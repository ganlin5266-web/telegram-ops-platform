import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { postgres, DomainError, one } from "./db.js";
import { legacyPreflight, expirePointsBatch } from "./point-lot-maintenance.js";

// Staging-only operator entrypoint. No cutover or feature-flag mutation exists here.
let db: ReturnType<typeof postgres> | undefined;
let stage = "input";
try {
  const args = process.argv.slice(2);
  if (
    args.length > 1 ||
    (args.length === 1 && !["--preflight", "--expire"].includes(args[0]!))
  )
    throw new DomainError("invalid_arguments");
  const expire = args[0] === "--expire";
  if (
    !process.env.DATABASE_URL ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
  )
    throw new DomainError("secure_connection_required");
  const url = new URL(process.env.DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new DomainError("secure_connection_required");
  for (const key of ["ssl", "uselibpqcompat", "sslmode"])
    url.searchParams.delete(key);
  url.searchParams.set("sslmode", "verify-full");
  db = postgres(url.href);
  stage = "readonly_preflight";
  const connection = db;
  const baseline = await db.transaction(async (tx) => {
    await tx.query("SET TRANSACTION READ ONLY");
    const identity = await one(
      tx,
      `SELECT current_database() AS db,current_user AS role,
   (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS ssl`,
    );
    if (identity.db !== "telegram_ops_staging" || identity.ssl !== true)
      throw new DomainError("staging_tls_required");
    const files = (await readdir("db/migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort();
    const applied = (
      await tx.query(
        "SELECT name,checksum FROM schema_migrations ORDER BY name",
      )
    ).rows;
    if (applied.length !== files.length)
      throw new DomainError("migration_mismatch");
    for (let i = 0; i < files.length; i++)
      if (
        applied[i]!.name !== files[i] ||
        applied[i]!.checksum !==
          createHash("sha256")
            .update(await readFile(`db/migrations/${files[i]}`))
            .digest("hex")
      )
        throw new DomainError("migration_mismatch");
    if (expire && identity.role !== "telegram_app")
      throw new DomainError("runtime_connection_required");
    const scopes = (
      await tx.query(
        "SELECT brand_id,id FROM telegram_bots ORDER BY brand_id,id",
      )
    ).rows;
    const results = [];
    for (const scope of scopes)
      results.push({
        brandId: scope.brand_id,
        botId: scope.id,
        ...(await legacyPreflight(tx, {
          brandId: scope.brand_id,
          botId: scope.id,
        })),
      });
    return results;
  });
  if (expire) {
    stage = "expiry_batch";
    console.log(
      JSON.stringify({ stage, ...(await expirePointsBatch(connection, 50)) }),
    );
  } else
    console.log(
      JSON.stringify({ stage, readonly: true, writes: 0, scopes: baseline }),
    );
} catch (error) {
  const safe = new Set([
    "invalid_arguments",
    "secure_connection_required",
    "staging_tls_required",
    "migration_mismatch",
    "runtime_connection_required",
    "point_lots_disabled",
    "point_lot_cutover_required",
    "point_reconciliation_mismatch",
    "point_writes_paused",
  ]);
  const code =
    error instanceof DomainError && safe.has(error.code)
      ? error.code
      : "maintenance_failed";
  console.error(JSON.stringify({ stage, classification: code }));
  process.exitCode = 1;
} finally {
  if (db)
    await db.close().catch(() => {
      process.exitCode = 1;
    });
}
