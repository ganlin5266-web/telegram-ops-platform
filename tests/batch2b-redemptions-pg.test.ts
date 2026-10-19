import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { migrate } from "../src/migrations.js";
import { one, postgres, type Database } from "../src/db.js";
import {
  changeRedemptionRule,
  createRedemptionRule,
  importCodeBatch,
} from "../src/redemption-v2.js";
import { createRedemptionCodeVault } from "../src/redemption-vault.js";

let db: Database & { close(): Promise<void> };
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const vault = createRedemptionCodeVault({
  REDEMPTION_CODE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  REDEMPTION_CODE_FINGERPRINT_KEY: randomBytes(32).toString("base64"),
  REDEMPTION_CODE_KEY_VERSION: "pg-v1",
})!;

before(async () => {
  if (!enabled) return;
  db = postgres(process.env.TEST_DATABASE_URL!);
  await migrate(db);
});
after(async () => {
  if (enabled) await db.close();
});

async function pgFixture() {
  const brand = await one(
    db,
    "INSERT INTO brands(name,slug,default_language) VALUES('B2B PG',$1,'en') RETURNING id",
    [randomUUID()],
  );
  const bot = async (name: string) =>
    one(
      db,
      `INSERT INTO telegram_bots(
  brand_id,name,username,token_secret_ref,webhook_secret_ref,
  default_language,supported_languages,status
 ) VALUES($1,$2,$3,$4,$5,'en',ARRAY['en'],'active') RETURNING id`,
      [brand.id, name, randomUUID(), randomUUID(), randomUUID()],
    );
  const [botA, botB] = await Promise.all([bot("Bot A"), bot("Bot B")]);
  const platform = await one(
    db,
    `INSERT INTO platforms(
  brand_id,code,display_name,market,timezone,currency,verification_method
 ) VALUES($1,$2,'B2B PG','BR','UTC','BRL','manual_admin') RETURNING id`,
    [
      brand.id,
      `PG_${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    ],
  );
  const admin = await one(
    db,
    "INSERT INTO admins(auth_subject,display_name) VALUES($1,'B2B PG') RETURNING id",
    [randomUUID()],
  );
  await db.query(
    `INSERT INTO admin_roles(admin_id,role_id)
  SELECT $1,id FROM roles WHERE name='Super Admin'`,
    [admin.id],
  );
  const principal = { adminId: admin.id };
  const scopeA = { brandId: brand.id, botId: botA.id };
  const scopeB = { brandId: brand.id, botId: botB.id };
  const makeRule = async (scope: typeof scopeA, tierKey: string) => {
    const rule = await createRedemptionRule(
      db,
      principal,
      scope,
      {
        platformId: platform.id,
        tierKey,
        name: tierKey,
        pointsCost: 100,
        faceValue: "10",
        currency: "BRL",
        effectiveFrom: "2026-01-01",
        effectiveUntil: null,
      },
      randomUUID(),
    );
    await changeRedemptionRule(
      db,
      principal,
      scope,
      rule.id,
      "publish",
      randomUUID(),
    );
    return rule;
  };
  const [ruleA, ruleB] = await Promise.all([
    makeRule(scopeA, "bot_a"),
    makeRule(scopeB, "bot_b"),
  ]);
  return {
    brandId: brand.id,
    platformId: platform.id,
    principal,
    scopeA,
    scopeB,
    ruleA,
    ruleB,
  };
}

test(
  "PG17 serializes same-platform imports across Bots and records rejection",
  {
    skip: !enabled,
  },
  async () => {
    const f = await pgFixture(),
      plain = "PG-CONCURRENT-SECRET";
    const before = await one(
      db,
      `SELECT
  (SELECT count(*)::int FROM redemptions) redemptions,
  (SELECT count(*)::int FROM point_ledger) point_ledger,
  (SELECT count(*)::int FROM point_lots) point_lots,
  (SELECT count(*)::int FROM point_lot_allocations) allocations,
  (SELECT count(*)::int FROM growth_ledger) growth_ledger`,
    );
    const results = await Promise.all([
      importCodeBatch(
        db,
        vault,
        f.principal,
        f.scopeA,
        {
          ruleId: f.ruleA.id,
          codes: [{ code: plain, expiresAt: null }],
        },
        randomUUID(),
      ),
      importCodeBatch(
        db,
        vault,
        f.principal,
        f.scopeB,
        {
          ruleId: f.ruleB.id,
          codes: [{ code: plain, expiresAt: null }],
        },
        randomUUID(),
      ),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [
      "imported",
      "rejected",
    ]);
    assert.equal(
      (
        await one(
          db,
          `SELECT count(*)::int n FROM redemption_codes
  WHERE brand_id=$1 AND platform_id=$2`,
          [f.brandId, f.platformId],
        )
      ).n,
      1,
    );
    assert.equal(
      (
        await one(
          db,
          `SELECT count(*)::int n FROM redemption_code_batches
  WHERE brand_id=$1 AND platform_id=$2`,
          [f.brandId, f.platformId],
        )
      ).n,
      2,
    );
    const stored = await one(
      db,
      `SELECT code_secret_ref,
  encode(code_ciphertext,'hex') ciphertext FROM redemption_codes
  WHERE brand_id=$1 AND platform_id=$2`,
      [f.brandId, f.platformId],
    );
    assert.ok(!JSON.stringify(stored).includes(plain));
    const after = await one(
      db,
      `SELECT
  (SELECT count(*)::int FROM redemptions) redemptions,
  (SELECT count(*)::int FROM point_ledger) point_ledger,
  (SELECT count(*)::int FROM point_lots) point_lots,
  (SELECT count(*)::int FROM point_lot_allocations) allocations,
  (SELECT count(*)::int FROM growth_ledger) growth_ledger`,
    );
    assert.deepEqual(after, before);
  },
);

test(
  "PG17 keeps same-batch replay and rule version creation idempotent/serialized",
  {
    skip: !enabled,
  },
  async () => {
    const f = await pgFixture();
    const payload = {
      ruleId: f.ruleA.id,
      codes: [
        { code: "PG-REPLAY-A", expiresAt: null },
        { code: "PG-REPLAY-B", expiresAt: null },
      ],
    };
    const batches = await Promise.all([
      importCodeBatch(db, vault, f.principal, f.scopeA, payload, randomUUID()),
      importCodeBatch(db, vault, f.principal, f.scopeA, payload, randomUUID()),
    ]);
    assert.equal(batches[0].id, batches[1].id);
    assert.equal(
      (
        await one(
          db,
          `SELECT count(*)::int n FROM redemption_code_batches
  WHERE brand_id=$1 AND bot_id=$2 AND source_fingerprint=(
   SELECT source_fingerprint FROM redemption_code_batches WHERE id=$3
  )`,
          [f.brandId, f.scopeA.botId, batches[0].id],
        )
      ).n,
      1,
    );

    const create = () =>
      createRedemptionRule(
        db,
        f.principal,
        f.scopeA,
        {
          platformId: f.platformId,
          tierKey: "concurrent_version",
          name: "Concurrent",
          pointsCost: 200,
          faceValue: "20",
          currency: "BRL",
          effectiveFrom: "2026-01-01",
          effectiveUntil: null,
        },
        randomUUID(),
      );
    const rules = await Promise.all([create(), create()]);
    assert.deepEqual(
      rules.map((r) => Number(r.version)).sort((a, b) => a - b),
      [1, 2],
    );
  },
);

test(
  "PG17 keeps older inventory decryptable after the active key rotates",
  {
    skip: !enabled,
  },
  async () => {
    const f = await pgFixture();
    const oldKey = randomBytes(32).toString("base64");
    const newKey = randomBytes(32).toString("base64");
    const fingerprintKey = randomBytes(32).toString("base64");
    const configured = (active: string, keys: Record<string, string>) =>
      createRedemptionCodeVault({
        REDEMPTION_CODE_ENCRYPTION_KEYS: JSON.stringify(keys),
        REDEMPTION_CODE_ACTIVE_KEY_VERSION: active,
        REDEMPTION_CODE_FINGERPRINT_KEY: fingerprintKey,
      })!;
    const oldVault = configured("v1", { v1: oldKey });
    await importCodeBatch(
      db,
      oldVault,
      f.principal,
      f.scopeA,
      {
        ruleId: f.ruleA.id,
        codes: [{ code: "PG-ROTATION-OLD", expiresAt: null }],
      },
      randomUUID(),
    );

    const rotated = configured("v2", { v1: oldKey, v2: newKey });
    await importCodeBatch(
      db,
      rotated,
      f.principal,
      f.scopeA,
      {
        ruleId: f.ruleA.id,
        codes: [{ code: "PG-ROTATION-NEW", expiresAt: null }],
      },
      randomUUID(),
    );
    const rows = (
      await db.query(
        `SELECT platform_id,code_ciphertext,code_iv,
  code_auth_tag,code_key_version,code_fingerprint
  FROM redemption_codes WHERE brand_id=$1 AND bot_id=$2
  AND code_key_version IN ('v1','v2') ORDER BY code_key_version`,
        [f.brandId, f.scopeA.botId],
      )
    ).rows;
    assert.deepEqual(
      rows.map((row) => row.code_key_version),
      ["v1", "v2"],
    );
    assert.deepEqual(
      rows.map((row) => rotated.decrypt(row, row.platform_id)),
      ["PG-ROTATION-OLD", "PG-ROTATION-NEW"],
    );
    assert.equal(
      rotated.fingerprint("PG-ROTATION-OLD", f.platformId),
      oldVault.fingerprint("PG-ROTATION-OLD", f.platformId),
    );
  },
);

test(
  "PG17 runtime grant can change inventory state but not encrypted payload or history",
  {
    skip: !enabled,
  },
  async () => {
    const f = await pgFixture();
    await importCodeBatch(
      db,
      vault,
      f.principal,
      f.scopeA,
      {
        ruleId: f.ruleA.id,
        codes: [{ code: "PG-RUNTIME-GRANT", expiresAt: null }],
      },
      randomUUID(),
    );
    const code = await one(
      db,
      `SELECT id FROM redemption_codes
  WHERE brand_id=$1 AND platform_id=$2 AND status='available'`,
      [f.brandId, f.platformId],
    );
    const role = "b2b_rt_" + randomUUID().replaceAll("-", "");
    await db.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    try {
      // Reproduce the pre-Batch-2B Staging grant. A column-level GRANT alone
      // would leave this wider table privilege in force.
      await db.query(`GRANT UPDATE ON redemption_codes TO ${role}`);
      await db.query(
        (await readFile("db/runtime-grants.sql", "utf8")).replaceAll(
          "telegram_app",
          role,
        ),
      );
      await db.transaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE ${role}`);
        await tx.query(
          "UPDATE redemption_codes SET status='disabled' WHERE id=$1",
          [code.id],
        );
      });
      for (const sql of [
        "UPDATE redemption_codes SET code_ciphertext='\\x00' WHERE id=$1",
        "UPDATE redemption_codes SET code_fingerprint='0' WHERE id=$1",
        "DELETE FROM redemption_codes WHERE id=$1",
        "TRUNCATE redemption_code_batches",
      ])
        await assert.rejects(
          () =>
            db.transaction(async (tx) => {
              await tx.query(`SET LOCAL ROLE ${role}`);
              await tx.query(sql, sql.includes("$1") ? [code.id] : undefined);
            }),
          /permission denied/,
        );
    } finally {
      await db.query(`DROP OWNED BY ${role}`);
      await db.query(`DROP ROLE ${role}`);
    }
  },
);
