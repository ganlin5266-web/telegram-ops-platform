import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  postgres,
  one,
  DomainError,
  type Database,
  type Queryable,
} from "../src/db.js";
import { migrate } from "../src/migrations.js";
import {
  createPlatform,
  submitIdentity,
  reviewIdentity,
  canonicalUid,
  maskUid,
} from "../src/platform-identities.js";
import { createApp } from "../src/app.js";
let db: Database, close: () => Promise<void>;
const apps: ReturnType<typeof createApp>[] = [];
const adapt = (p: any): Queryable => ({
  query: async (s, a) =>
    a === undefined
      ? ((await p.exec(s)).at(-1) ?? { rows: [] })
      : p.query(s, a),
});
before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    const p = postgres(process.env.TEST_DATABASE_URL);
    db = p;
    close = p.close;
  } else {
    const p = new PGlite();
    db = { ...adapt(p), transaction: (f) => p.transaction((t) => f(adapt(t))) };
    close = () => p.close();
  }
  await migrate(db);
});
after(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await close();
});
const config = {
  code: "TEST",
  displayName: "Test Platform",
  market: "BR",
  timezone: "America/Sao_Paulo",
  currency: "BRL",
  verificationMethod: "manual_admin",
  uidFormat: "alphanumeric",
  uidCase: "upper",
  uidMinLength: 3,
  uidMaxLength: 64,
};
async function fixture(runtime = false) {
  const brand = await one(
    db,
    "INSERT INTO brands(name,slug,default_language) VALUES('P3 Test',$1,'en') RETURNING id",
    [randomUUID()],
  );
  const bot = await one(
    db,
    "INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status) VALUES($1,'P3 Test',$2,$3,$4,'en',ARRAY['en'],'active') RETURNING id,token_secret_ref",
    [
      brand.id,
      randomUUID(),
      "TEST_" + randomUUID().replaceAll("-", "").toUpperCase(),
      "WEBHOOK_" + randomUUID().replaceAll("-", "").toUpperCase(),
    ],
  );
  const s = { brandId: brand.id, botId: bot.id },
    admin = await one(
      db,
      "INSERT INTO admins(auth_subject,display_name) VALUES($1,'Test reviewer') RETURNING id",
      [randomUUID()],
    );
  await db.query(
    "INSERT INTO admin_roles(admin_id,role_id) SELECT $1,id FROM roles WHERE name='Super Admin'",
    [admin.id],
  );
  const p = { adminId: admin.id };
  const users: Record<string, any>[] = [];
  for (let i = 1; i <= 2; i++)
    users.push(
      await one(
        db,
        "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,$3) RETURNING id",
        [brand.id, bot.id, 80000 + i],
      ),
    );
  let connection = db;
  if (runtime) {
    await db.query(
      "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='telegram_app') THEN CREATE ROLE telegram_app NOLOGIN; END IF; END $$",
    );
    await db.query(await readFile("db/runtime-grants.sql", "utf8"));
    connection = {
      query: (q, a) =>
        db.transaction(async (tx) => {
          await tx.query("SET LOCAL ROLE telegram_app");
          return tx.query(q, a);
        }),
      transaction: (fn) =>
        db.transaction(async (tx) => {
          await tx.query("SET LOCAL ROLE telegram_app");
          return fn(tx);
        }),
    };
  }
  const platform = await createPlatform(connection, p, s, config, "test");
  const user = (n = 0) => ({
    ...s,
    userId: users[n]!.id,
    sessionId: randomUUID(),
    appKey: "p3-test",
    expiresAt: new Date(Date.now() + 100000).toISOString(),
  });
  const submit = (n = 0, uid = "BRTEST10001", key = randomUUID()) =>
    submitIdentity(connection, user(n), platform.id, uid, key, "test");
  const review = (
    id: string,
    action: "verify" | "reject" | "revoke",
    extra: Record<string, string> = {},
  ) => reviewIdentity(connection, p, s, id, { action, ...extra }, "test");
  return { s, p, users, platform, user, submit, review, connection };
}
const error = (code: string) => (e: unknown) =>
  e instanceof DomainError && e.code === code;
test("P3 canonicalization uses configured format, preserves strings and masks short UID", () => {
  assert.equal(
    canonicalUid(" brtest10001 ", {
      uid_case: "upper",
      uid_format: "alphanumeric",
      uid_min_length: 3,
      uid_max_length: 64,
    }),
    "BRTEST10001",
  );
  assert.equal(maskUid("BRTEST10001"), "BR****01");
  assert.equal(maskUid("123"), "****");
  assert.throws(() =>
    canonicalUid("١٢٣", {
      uid_case: "upper",
      uid_format: "digits",
      uid_min_length: 1,
      uid_max_length: 20,
    }),
  );
});
test("P3 submit only pending, duplicate click and request replay create one identity and one audit", async () => {
  const f = await fixture(),
    key = randomUUID(),
    a = await f.submit(0, "brtest10001", key),
    b = await f.submit(0, "BRTEST10001", key),
    c = await f.submit();
  assert.equal(a.status, "pending");
  assert.equal(a.id, b.id);
  assert.equal(a.id, c.id);
  assert.equal(a.uidMasked, "BR****01");
  assert.ok(!JSON.stringify(a).includes("BRTEST10001"));
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int AS n FROM audit_logs WHERE object_id=$1 AND action='identity.submit'",
        [a.id],
      )
    ).n,
    1,
  );
  await assert.rejects(
    () => f.submit(0, "NEW123", key),
    error("idempotency_conflict"),
  );
});
test("P3 verify, repeat verify, revoke and immutable historical UID", async () => {
  const f = await fixture(),
    a = await f.submit();
  await assert.rejects(
    () => f.review(a.id, "verify"),
    error("evidence_required"),
  );
  const v = await f.review(a.id, "verify", {
    evidenceReference: "CASE-TEST-1",
  });
  assert.equal(v.status, "verified");
  assert.equal(
    (await f.review(a.id, "verify", { evidenceReference: "CASE-TEST-1" }))
      .status,
    "verified",
  );
  await assert.rejects(
    () => f.submit(0, "OTHER123"),
    error("identity_current_exists"),
  );
  await assert.rejects(() =>
    db.query(
      "UPDATE platform_identities SET platform_uid='OTHER123' WHERE id=$1",
      [a.id],
    ),
  );
  assert.equal(
    (await f.review(a.id, "revoke", { reasonCode: "user_request" })).status,
    "revoked",
  );
  assert.equal(
    (await f.review(a.id, "revoke", { reasonCode: "user_request" })).status,
    "revoked",
  );
  await assert.rejects(
    () => f.review(a.id, "verify", { evidenceReference: "CASE-TEST-1" }),
    error("identity_state_conflict"),
  );
  const r = await one(
    db,
    "SELECT verified_at,revoked_at,evidence_reference FROM platform_identities WHERE id=$1",
    [a.id],
  );
  assert.ok(r.verified_at && r.revoked_at);
  assert.equal(r.evidence_reference, "CASE-TEST-1");
});
test("P3 reject history, correction cooldown, and no business side effects", async () => {
  const f = await fixture(),
    a = await f.submit();
  await f.review(a.id, "reject", { reasonCode: "incorrect_uid" });
  await assert.rejects(
    () => f.submit(0, "CORRECT123"),
    error("identity_rate_limited"),
  );
  for (const table of [
    "point_accounts",
    "point_ledger",
    "referrals",
    "redemptions",
  ])
    assert.equal(
      (
        await one(
          db,
          `SELECT count(*)::int AS n FROM ${table} WHERE bot_id=$1`,
          [f.s.botId],
        )
      ).n,
      0,
    );
  assert.equal(
    (
      await one(db, "SELECT status FROM platform_identities WHERE id=$1", [
        a.id,
      ])
    ).status,
    "rejected",
  );
});
test("P3 cross-user UID conflict is retained safely, no owner disclosure", async () => {
  const f = await fixture(),
    a = await f.submit();
  await f.review(a.id, "verify", { evidenceReference: "CASE-TEST-2" });
  const conflict = await f.submit(1);
  assert.equal(conflict.status, "conflict");
  assert.ok(!JSON.stringify(conflict).includes(f.users[0]!.id));
  await assert.rejects(
    () => f.review(conflict.id, "verify", { evidenceReference: "CASE-TEST-3" }),
    error("identity_state_conflict"),
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int AS n FROM platform_identities WHERE platform_id=$1 AND status='verified'",
        [f.platform.id],
      )
    ).n,
    1,
  );
});
test("P3 two concurrent submissions same UID have only one current owner", async () => {
  const f = await fixture();
  const r = await Promise.all([f.submit(0), f.submit(1)]);
  assert.deepEqual(r.map((x) => x.status).sort(), ["conflict", "pending"]);
});
test("P3 concurrent verify/reject and revoke/verify serialize to legal states", async () => {
  const f = await fixture(),
    a = await f.submit();
  const results = await Promise.allSettled([
    f.review(a.id, "verify", { evidenceReference: "CASE-CONCURRENT" }),
    f.review(a.id, "reject", { reasonCode: "ownership_not_proven" }),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  const final = await one(
    db,
    "SELECT status FROM platform_identities WHERE id=$1",
    [a.id],
  );
  if (final.status === "verified") {
    const r = await Promise.allSettled([
      f.review(a.id, "revoke", { reasonCode: "user_request" }),
      f.review(a.id, "verify", { evidenceReference: "CASE-CONCURRENT" }),
    ]);
    assert.ok(r.some((x) => x.status === "fulfilled"));
    assert.equal(
      (
        await one(db, "SELECT status FROM platform_identities WHERE id=$1", [
          a.id,
        ])
      ).status,
      "revoked",
    );
  }
});
test("P3 RBAC only Super Admin gets default new permissions; wrong Brand/Bot cannot review", async () => {
  const f = await fixture(),
    a = await f.submit(),
    other = await fixture();
  await assert.rejects(
    () =>
      reviewIdentity(
        db,
        other.p,
        other.s,
        a.id,
        { action: "verify", evidenceReference: "CASE-X" },
        "test",
      ),
    error("not_found"),
  );
  for (const role of ["Admin", "Operator", "Viewer"]) {
    const row = await one(db, "SELECT id FROM roles WHERE name=$1", [role]);
    await db.query("UPDATE admin_roles SET role_id=$2 WHERE admin_id=$1", [
      f.p.adminId,
      row.id,
    ]);
    await assert.rejects(
      () => f.review(a.id, "reject", { reasonCode: "incorrect_uid" }),
      error("forbidden"),
    );
  }
});
test("P3 platform inactive/automatic mode fail closed and cross Brand submit is rejected", async () => {
  const f = await fixture(),
    other = await fixture();
  await assert.rejects(
    () =>
      submitIdentity(
        db,
        f.user(),
        other.platform.id,
        "TEST1",
        randomUUID(),
        "test",
      ),
    error("not_found"),
  );
  await db.query("UPDATE platforms SET status='disabled' WHERE id=$1", [
    f.platform.id,
  ]);
  await assert.rejects(() => f.submit(), error("platform_unavailable"));
  await db.query(
    "UPDATE platforms SET status='active',verification_method='platform_api' WHERE id=$1",
    [f.platform.id],
  );
  await assert.rejects(() => f.submit(), error("verification_unavailable"));
});
test("P3 runtime grants support submit/review while prohibiting UID overwrite and deletes", async () => {
  const f = await fixture(true),
    a = await f.submit();
  assert.equal(
    (await f.review(a.id, "verify", { evidenceReference: "CASE-RUNTIME" }))
      .status,
    "verified",
  );
  await assert.rejects(() =>
    f.connection.query("DELETE FROM platform_identities WHERE id=$1", [a.id]),
  );
  await assert.rejects(() =>
    f.connection.query(
      "UPDATE platform_identities SET platform_uid='OTHER' WHERE id=$1",
      [a.id],
    ),
  );
  await assert.rejects(() =>
    f.connection.query("UPDATE point_accounts SET balance=balance+1"),
  );
  await assert.rejects(() =>
    f.connection.query("UPDATE audit_logs SET note='changed'"),
  );
});
test("P3 database unique/FK/check guards survive direct invalid writes and canonicalization bypass", async () => {
  const f = await fixture(),
    a = await f.submit();
  const row = await one(db, "SELECT * FROM platform_identities WHERE id=$1", [
    a.id,
  ]);
  const values = [
    f.s.brandId,
    f.s.botId,
    f.users[1]!.id,
    80002,
    f.platform.id,
    row.platform_uid,
    "pending",
    "manual_admin",
    randomUUID(),
  ];
  const sql =
    "INSERT INTO platform_identities(brand_id,bot_id,user_id,telegram_user_id,platform_id,platform_uid,status,verification_method,submission_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)";
  await assert.rejects(() => db.query(sql, values));
  values[5] = "lowercase";
  await assert.rejects(() => db.query(sql, values));
  values[5] = "OTHER123";
  values[3] = 80001;
  await assert.rejects(() => db.query(sql, values));
  await assert.rejects(() =>
    db.query("DELETE FROM platform_identities WHERE id=$1", [a.id]),
  );
});
test("P3 Mini HTTP strictly derives scope, masks UID and refuses admin bearer", async () => {
  const f = await fixture(),
    secret = randomUUID(),
    ref = (
      await one(db, "SELECT token_secret_ref FROM telegram_bots WHERE id=$1", [
        f.s.botId,
      ])
    ).token_secret_ref;
  const origin = "https://p3.example.test",
    binding = {
      appKey: "p3-test",
      botId: f.s.botId,
      origin,
      tokenSecretRef: ref,
    };
  const app = createApp(
    db,
    (r) => (r === ref ? secret : undefined),
    async (token) => {
      if (token !== "Bearer ADMIN") throw new DomainError("unauthorized", 401);
      return f.p;
    },
    undefined,
    { bindings: [binding] },
  );
  apps.push(app);
  const raw = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 80001, first_name: "Synthetic" }),
    query_id: randomUUID(),
  });
  raw.sort();
  raw.set(
    "hash",
    createHmac(
      "sha256",
      createHmac("sha256", "WebAppData").update(secret).digest(),
    )
      .update([...raw].map(([k, v]) => `${k}=${v}`).join("\n"))
      .digest("hex"),
  );
  const ex = await app.inject({
    method: "POST",
    url: "/v1/mini/auth/exchange",
    headers: { origin },
    payload: { appKey: "p3-test", initData: raw.toString() },
  });
  assert.equal(ex.statusCode, 200);
  const headers = {
    origin,
    authorization: "Bearer " + ex.json().token,
    "x-mini-csrf": "1",
    "idempotency-key": randomUUID(),
  };
  const payload = { platformId: f.platform.id, uid: "BRTEST10001" };
  for (const key of ["brandId", "botId", "telegramUserId"])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/mini/platform-identities",
          headers,
          payload: { ...payload, [key]: randomUUID() },
        })
      ).statusCode,
      400,
    );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/mini/platform-identities",
        headers: { ...headers, "x-mini-csrf": "" },
        payload,
      })
    ).statusCode,
    403,
  );
  const r = await app.inject({
    method: "POST",
    url: "/v1/mini/platform-identities",
    headers,
    payload,
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, "pending");
  assert.ok(!r.body.includes(payload.uid));
  for (const path of ["/v1/mini/platforms", "/v1/mini/platform-identities"]) {
    const list = await app.inject({ url: path, headers });
    assert.equal(list.statusCode, 200);
    assert.ok(!list.body.includes(payload.uid));
    assert.equal(
      (
        await app.inject({
          url: path,
          headers: { origin, authorization: "Bearer ADMIN" },
        })
      ).statusCode,
      401,
    );
  }
  const audit = await one(
    db,
    "SELECT after_data::text AS data FROM audit_logs WHERE object_id=$1 AND action='identity.submit'",
    [r.json().id],
  );
  assert.ok(!audit.data.includes(payload.uid));
});
test("P3 historical revoke/reject permits a new version without overwriting the old UID", async () => {
  for (const action of ["revoke", "reject"] as const) {
    const f = await fixture();
    const old = await one(
      db,
      "INSERT INTO platform_identities(brand_id,bot_id,user_id,telegram_user_id,platform_id,platform_uid,verification_method,submission_key,submitted_at) VALUES($1,$2,$3,80001,$4,'OLD123','manual_admin',$5,now()-interval '1 minute') RETURNING id",
      [f.s.brandId, f.s.botId, f.users[0]!.id, f.platform.id, randomUUID()],
    );
    if (action === "revoke")
      await f.review(old.id, "verify", { evidenceReference: "CASE-HISTORY" });
    await f.review(old.id, action, { reasonCode: "user_request" });
    const next = await f.submit(0, "NEW123");
    const row = await one(
      db,
      "SELECT previous_identity_id FROM platform_identities WHERE id=$1",
      [next.id],
    );
    assert.equal(row.previous_identity_id, old.id);
    assert.equal(
      (
        await one(
          db,
          "SELECT platform_uid FROM platform_identities WHERE id=$1",
          [old.id],
        )
      ).platform_uid,
      "OLD123",
    );
  }
});
test("P3 same Telegram identity cannot acquire a second current UID through another Bot", async () => {
  const f = await fixture();
  await f.submit();
  const b = await one(
    db,
    "INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages) VALUES($1,'Other',$2,'NONE','NONE','en',ARRAY['en']) RETURNING id",
    [f.s.brandId, randomUUID()],
  );
  const u = await one(
    db,
    "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,80001) RETURNING id",
    [f.s.brandId, b.id],
  );
  await assert.rejects(
    () =>
      submitIdentity(
        db,
        { ...f.user(), botId: b.id, userId: u.id },
        f.platform.id,
        "NEW123",
        randomUUID(),
        "test",
      ),
    error("identity_current_exists"),
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int AS n FROM platform_identities WHERE platform_id=$1",
        [f.platform.id],
      )
    ).n,
    1,
  );
});
test("P3 mutation and audit rollback together when audit insertion fails", async () => {
  const f = await fixture();
  const broken: Database = {
    ...db,
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          query: (sql, args) => {
            if (sql.includes("INSERT INTO audit_logs"))
              throw new Error("test audit failure");
            return tx.query(sql, args);
          },
        }),
      ),
  };
  await assert.rejects(() =>
    submitIdentity(
      broken,
      f.user(),
      f.platform.id,
      "TEST123",
      randomUUID(),
      "test",
    ),
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int AS n FROM platform_identities WHERE platform_id=$1",
        [f.platform.id],
      )
    ).n,
    0,
  );
});
