import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { postgres, one, type Database, type Queryable } from "../src/db.js";
import { migrate } from "../src/migrations.js";
import {
  createPlatform,
  submitIdentity,
  reviewIdentity,
} from "../src/platform-identities.js";
import { preflightImport, activateImport } from "../src/platform-data.js";
import {
  createEntitlementRule,
  changeEntitlementRule,
  evaluateEntitlement,
  scheduleEntitlements,
  runEntitlementTasks,
} from "../src/entitlements.js";
let db: Database, close: () => Promise<void>;
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
  delete process.env.DAILY_ENTITLEMENTS_ENABLED;
  await close();
});
async function fixture(value = "100") {
  delete process.env.DAILY_ENTITLEMENTS_ENABLED;
  const b = await one(
    db,
    "INSERT INTO brands(name,slug,default_language) VALUES('P5B TEST',$1,'en') RETURNING id",
    [randomUUID()],
  );
  const bot = await one(
    db,
    "INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status) VALUES($1,'P5B TEST',$2,$2,$2,'en',ARRAY['en'],'disabled') RETURNING id",
    [b.id, randomUUID()],
  );
  const admin = await one(
    db,
    "INSERT INTO admins(auth_subject,display_name) VALUES($1,'P5B TEST') RETURNING id",
    [randomUUID()],
  );
  await db.query(
    "INSERT INTO admin_roles(admin_id,role_id) SELECT $1,id FROM roles WHERE name='Super Admin'",
    [admin.id],
  );
  const s = { brandId: b.id, botId: bot.id },
    p = { adminId: admin.id };
  const platform = await createPlatform(
    db,
    p,
    s,
    {
      code: "P5B_TEST",
      displayName: "STAGING TEST ONLY",
      market: "BR",
      timezone: "America/Sao_Paulo",
      currency: "BRL",
      verificationMethod: "manual_admin",
      uidFormat: "alphanumeric",
      uidCase: "upper",
      uidMinLength: 3,
      uidMaxLength: 64,
    },
    "p5b",
  );
  const user = await one(
    db,
    "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,999001) RETURNING id",
    [b.id, bot.id],
  );
  const identity = await submitIdentity(
    db,
    { ...s, userId: user.id, sessionId: randomUUID() } as any,
    platform.id,
    "SYNTHETIC01",
    randomUUID(),
    "p5b",
  );
  await reviewIdentity(
    db,
    p,
    s,
    identity.id,
    { action: "verify", evidenceReference: "CASE-P5B-TEST" },
    "p5b",
  );
  const importFact = async (
    amount: string,
    date = "2026-09-26",
    completeness = "complete",
    replacement = false,
  ) => {
    const pre = await preflightImport(
      db,
      p,
      s,
      {
        platformId: platform.id,
        businessDate: date,
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        sourceType: "csv",
        filename: "STAGING-TEST.csv",
        fileBase64: Buffer.from("uid,deposit\nSYNTHETIC01," + amount).toString(
          "base64",
        ),
        mapping: { uid: "uid", deposit: "deposit" },
        coverage: { kind: "full", filter: "" },
        completeness,
        replacement,
        reason: "STAGING TEST ONLY",
      },
      "p5b",
    );
    const batchId = (pre as any).batchId ?? (pre as any).id;
    await activateImport(db, p, s, batchId, true, "p5b");
    return batchId;
  };
  const batchId = await importFact(value);
  const rule = {
    platformId: platform.id,
    name: "STAGING TEST ONLY",
    metric: "deposit_amount",
    operator: ">=",
    currency: "BRL",
    sourceTimezone: "America/Sao_Paulo",
    entitlementTimezone: "America/Sao_Paulo",
    cutoffTime: "12:00",
    effectiveFrom: "2026-09-27",
    effectiveUntil: "2026-10-05",
    mappingBatchId: batchId,
    tiers: [
      { key: "tier_1", name: "Tier 1", threshold: "100" },
      { key: "tier_2", name: "Tier 2", threshold: "500" },
      { key: "tier_3", name: "Tier 3", threshold: "1000" },
    ],
  };
  const draft = await createEntitlementRule(db, p, s, rule, "p5b");
  const t = {
    ...s,
    userId: user.id,
    platformId: platform.id,
    entitlementDate: "2026-09-27",
  };
  const publish = () =>
    changeEntitlementRule(db, p, s, draft.versionId, "publish", "p5b");
  return {
    s,
    p,
    platform,
    user,
    identity,
    batchId,
    rule,
    draft,
    t,
    importFact,
    publish,
  };
}
test("P5B default disabled, publish idempotent, immutable tier/version, exact history and no rewards", async () => {
  const f = await fixture();
  await assert.rejects(
    () => evaluateEntitlement(db, f.t, "test", "p5b"),
    /disabled/,
  );
  await f.publish();
  await f.publish();
  await assert.rejects(
    () =>
      db.query(
        "UPDATE entitlement_rule_versions SET currency='USD' WHERE id=$1",
        [f.draft.versionId],
      ),
    /immutable/,
  );
  await assert.rejects(
    () =>
      db.query(
        "UPDATE entitlement_rule_tiers SET threshold=1 WHERE version_id=$1",
        [f.draft.versionId],
      ),
    /immutable/,
  );
  process.env.DAILY_ENTITLEMENTS_ENABLED = "true";
  const first = await evaluateEntitlement(db, f.t, "test", "p5b");
  assert.equal(first.outcome, "changed");
  assert.equal(
    (await evaluateEntitlement(db, f.t, "test", "p5b")).outcome,
    "unchanged",
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT matched_tier FROM daily_entitlement_revisions WHERE id=$1",
        [first.revisionId],
      )
    ).matched_tier,
    "tier_1",
  );
  await f.importFact("600", "2026-09-26", "complete", true);
  const second = await evaluateEntitlement(db, f.t, "fact_revision", "p5b");
  assert.equal(
    (
      await one(
        db,
        "SELECT matched_tier FROM daily_entitlement_revisions WHERE id=$1",
        [second.revisionId],
      )
    ).matched_tier,
    "tier_2",
  );
  await f.importFact("700", "2026-09-26", "complete", true);
  await evaluateEntitlement(db, f.t, "fact_revision", "p5b");
  await f.importFact("50", "2026-09-26", "complete", true);
  const last = await evaluateEntitlement(db, f.t, "fact_revision", "p5b");
  assert.equal(
    (
      await one(
        db,
        "SELECT status FROM daily_entitlement_revisions WHERE id=$1",
        [last.revisionId],
      )
    ).status,
    "ineligible",
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int AS n FROM daily_entitlement_revisions WHERE daily_entitlement_id=$1",
        [first.id],
      )
    ).n,
    4,
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int AS n FROM point_accounts WHERE brand_id=$1",
        [f.s.brandId],
      )
    ).n,
    0,
  );
  await assert.rejects(
    () =>
      db.query(
        "UPDATE daily_entitlement_revisions SET status='pending' WHERE id=$1",
        [first.revisionId],
      ),
    /immutable/,
  );
  await assert.rejects(
    () =>
      db.query(
        "UPDATE daily_entitlements SET current_revision_id=$2 WHERE id=$1",
        [first.id, first.revisionId],
      ),
    /current_invalid/,
  );
});
test("P5B missing data survives cutoff; late arrival keeps subject and resolves SLA", async () => {
  const f = await fixture();
  await f.publish();
  process.env.DAILY_ENTITLEMENTS_ENABLED = "true";
  const t = { ...f.t, entitlementDate: "2026-09-28" };
  const before = await evaluateEntitlement(
    db,
    t,
    "test",
    "p5b",
    new Date("2026-09-28T14:59:00Z"),
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT reason_code FROM daily_entitlement_revisions WHERE id=$1",
        [before.revisionId],
      )
    ).reason_code,
    "waiting_for_data",
  );
  const after = await evaluateEntitlement(
    db,
    t,
    "cutoff_sla",
    "p5b",
    new Date("2026-09-28T15:00:00Z"),
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT reason_code FROM daily_entitlement_revisions WHERE id=$1",
        [after.revisionId],
      )
    ).reason_code,
    "stale_data",
  );
  await f.importFact("600", "2026-09-27");
  const late = await evaluateEntitlement(
    db,
    t,
    "fact_revision",
    "p5b",
    new Date("2026-09-28T18:00:00Z"),
  );
  assert.equal(late.id, before.id);
  assert.equal(
    (
      await one(
        db,
        "SELECT matched_tier FROM daily_entitlement_revisions WHERE id=$1",
        [late.revisionId],
      )
    ).matched_tier,
    "tier_2",
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int AS n FROM entitlement_sla_findings WHERE daily_entitlement_id=$1 AND resolved_at IS NOT NULL",
        [late.id],
      )
    ).n,
    1,
  );
});
test("P5B overlap rejected, current ownership protected and task retries are idempotent", async () => {
  const f = await fixture();
  await f.publish();
  const next = await createEntitlementRule(db, f.p, f.s, f.rule, "p5b");
  await assert.rejects(
    () => changeEntitlementRule(db, f.p, f.s, next.versionId, "publish", "p5b"),
    /overlap/,
  );
  process.env.DAILY_ENTITLEMENTS_ENABLED = "true";
  await scheduleEntitlements(
    db,
    f.s,
    f.platform.id,
    "2026-09-27",
    "manual_recalculate",
    "p5b",
  );
  await scheduleEntitlements(
    db,
    f.s,
    f.platform.id,
    "2026-09-27",
    "manual_recalculate",
    "p5b",
  );
  const results = await runEntitlementTasks(db, f.s);
  assert.equal(results.length, 1);
  assert.equal((await runEntitlementTasks(db, f.s)).length, 0);
});
test("P5B revoked identity becomes pending without deleting old eligibility", async () => {
  const f = await fixture("500");
  await f.publish();
  process.env.DAILY_ENTITLEMENTS_ENABLED = "true";
  const first = await evaluateEntitlement(db, f.t, "test", "p5b");
  await reviewIdentity(
    db,
    f.p,
    f.s,
    f.identity.id,
    { action: "revoke", reasonCode: "user_request" },
    "p5b",
  );
  const next = await evaluateEntitlement(db, f.t, "identity_change", "p5b");
  assert.equal(
    (
      await one(
        db,
        "SELECT reason_code FROM daily_entitlement_revisions WHERE id=$1",
        [next.revisionId],
      )
    ).reason_code,
    "waiting_for_identity",
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT status FROM daily_entitlement_revisions WHERE id=$1",
        [first.revisionId],
      )
    ).status,
    "eligible",
  );
});
for (const [value, quality, expected, reason] of [
  ["", "complete", "pending", "metric_not_available"],
  ["0", "complete", "ineligible", "threshold_not_met"],
  ["600", "incomplete", "pending", "incomplete_data"],
  ["600", "unknown", "pending", "incomplete_data"],
] as const)
  test("P5B stored quality " + quality + " " + value, async () => {
    const f = await fixture("100");
    await f.publish();
    await f.importFact(value, "2026-09-27", quality);
    process.env.DAILY_ENTITLEMENTS_ENABLED = "true";
    const r = await evaluateEntitlement(
      db,
      { ...f.t, entitlementDate: "2026-09-28" },
      "test",
      "p5b",
    );
    const stored = await one(
      db,
      "SELECT status,reason_code FROM daily_entitlement_revisions WHERE id=$1",
      [r.revisionId],
    );
    assert.equal(stored.status, expected);
    assert.equal(stored.reason_code, reason);
  });
test("P5B incomplete pending still creates one SLA warning at cutoff", async () => {
  const f = await fixture();
  await f.publish();
  await f.importFact("600", "2026-09-27", "incomplete");
  process.env.DAILY_ENTITLEMENTS_ENABLED = "true";
  const t = { ...f.t, entitlementDate: "2026-09-28" };
  const before = await evaluateEntitlement(db,t,"test","p5b",new Date("2026-09-28T14:59:00Z"));
  const after = await evaluateEntitlement(db,t,"cutoff_sla","p5b",new Date("2026-09-28T15:00:00Z"));
  assert.notEqual(before.revisionId,after.revisionId);
  assert.equal((await one(db,"SELECT status FROM daily_entitlement_revisions WHERE id=$1",[after.revisionId])).status,"pending");
  assert.equal((await evaluateEntitlement(db,t,"cutoff_sla","p5b",new Date("2026-09-28T15:01:00Z"))).outcome,"unchanged");
  assert.equal((await one(db,"SELECT count(*)::int AS n FROM entitlement_sla_findings WHERE daily_entitlement_id=$1",[after.id])).n,1);
});
test("P5B future version does not rewrite past entitlement and retired rule keeps evidence", async () => {
  const f = await fixture();
  await f.publish();
  const v2 = await createEntitlementRule(
    db,
    f.p,
    f.s,
    { ...f.rule, effectiveFrom: "2026-10-06", effectiveUntil: "2026-10-07" },
    "p5b",
  );
  await changeEntitlementRule(db, f.p, f.s, v2.versionId, "publish", "p5b");
  process.env.DAILY_ENTITLEMENTS_ENABLED = "true";
  const r = await evaluateEntitlement(db, f.t, "test", "p5b");
  assert.equal(
    (
      await one(
        db,
        "SELECT rule_version_id FROM daily_entitlement_revisions WHERE id=$1",
        [r.revisionId],
      )
    ).rule_version_id,
    f.draft.versionId,
  );
  await changeEntitlementRule(db, f.p, f.s, v2.versionId, "retire", "p5b");
  await changeEntitlementRule(db, f.p, f.s, v2.versionId, "retire", "p5b");
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int AS n FROM daily_entitlement_revisions WHERE id=$1",
        [r.revisionId],
      )
    ).n,
    1,
  );
});
test("P5B cross user/bot/brand/platform is rejected before a revision is written", async () => {
  const f = await fixture(),
    other = await fixture();
  await f.publish();
  process.env.DAILY_ENTITLEMENTS_ENABLED = "true";
  for (const patch of [
    { userId: other.user.id },
    { botId: other.s.botId },
    { brandId: other.s.brandId },
    { platformId: other.platform.id },
  ])
    await assert.rejects(() =>
      evaluateEntitlement(db, { ...f.t, ...patch }, "test", "p5b"),
    );
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int AS n FROM daily_entitlements WHERE brand_id=$1",
        [f.s.brandId],
      )
    ).n,
    0,
  );
});
test(
  "P5B PostgreSQL independent concurrent evaluation, publication and runtime rights",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const f = await fixture();
    await f.publish();
    process.env.DAILY_ENTITLEMENTS_ENABLED = "true";
    const parallel = await Promise.all([
      evaluateEntitlement(db, f.t, "test", "p5b"),
      evaluateEntitlement(db, f.t, "test", "p5b"),
    ]);
    assert.deepEqual(parallel.map((r) => r.outcome).sort(), [
      "changed",
      "unchanged",
    ]);
    await f.importFact("700", "2026-09-26", "complete", true);
    await Promise.all([
      evaluateEntitlement(db, f.t, "fact_revision", "p5b"),
      evaluateEntitlement(db, f.t, "old_task", "p5b"),
    ]);
    assert.equal(
      (
        await one(
          db,
          "SELECT count(*)::int AS n FROM daily_entitlement_revisions WHERE daily_entitlement_id=$1",
          [parallel[0]!.id],
        )
      ).n,
      2,
    );
    const { readFile } = await import("node:fs/promises");
    // Disposable test-only login; do not mutate the shared runtime role or assume trust authentication.
    const role = "p5b_rt_" + randomUUID().replaceAll("-", "");
    const password = randomUUID();
    await db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.username = role;
    url.password = password;
    const runtime = postgres(url.toString());
    try {
      await db.query((await readFile("db/runtime-grants.sql", "utf8")).replaceAll("telegram_app",role));
      assert.equal(
        (await one(runtime, "SELECT current_user AS role")).role,
        role,
      );
      assert.equal(
        (await evaluateEntitlement(runtime, f.t, "test", "p5b")).outcome,
        "unchanged",
      );
      for (const table of [
        "daily_entitlement_revisions",
        "entitlement_rule_versions",
        "daily_entitlements",
        "point_ledger",
        "audit_logs",
      ]) {
        const permissions = await one(
          runtime,
          "SELECT has_table_privilege(current_user,$1,'DELETE') AS del,has_table_privilege(current_user,$1,'TRUNCATE') AS trunc",
          [table],
        );
        assert.equal(permissions.del, false);
        assert.equal(permissions.trunc, false);
      }
      await assert.rejects(
        () =>
          runtime.query(
            "UPDATE daily_entitlement_revisions SET reason_code=reason_code",
          ),
        /permission denied/,
      );
      await assert.rejects(
        () =>
          runtime.query("UPDATE entitlement_rule_versions SET currency='USD'"),
        /permission denied/,
      );
    } finally {
      await runtime.close();
      await db.query(`DROP OWNED BY ${role}`);
      await db.query(`DROP ROLE ${role}`);
    }
  },
);
test("P5B administrator API RBAC, sensitive explanation and Mini boundary remain separate", async () => {
  const f = await fixture();
  const { createApp } = await import("../src/app.js");
  const { DomainError } = await import("../src/db.js");
  const reader = await one(
    db,
    "INSERT INTO admins(auth_subject,display_name) VALUES($1,'P5B reader') RETURNING id",
    [randomUUID()],
  );
  const role = await one(
    db,
    "INSERT INTO roles(name) VALUES($1) RETURNING id",
    ["reader-" + randomUUID()],
  );
  await db.query(
    "INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE name='entitlements.read'",
    [role.id],
  );
  await db.query(
    "INSERT INTO admin_roles(admin_id,role_id,brand_id,bot_id) VALUES($1,$2,$3,$4)",
    [reader.id, role.id, f.s.brandId, f.s.botId],
  );
  const app = createApp(
    db,
    () => {
      throw Error("Telegram must not be called");
    },
    async (h) => {
      if (h === "Bearer test-admin") return f.p;
      if (h === "Bearer test-reader") return { adminId: reader.id };
      throw new DomainError("unauthorized", 401);
    },
  );
  const base = `/v1/brands/${f.s.brandId}/bots/${f.s.botId}/entitlements`;
  try {
    assert.equal((await app.inject({ url: base + "/rules" })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          url: base + "/rules",
          headers: { authorization: "Bearer fake-mini" },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: base + "/rules",
          headers: { authorization: "Bearer test-reader" },
          payload: f.rule,
        })
      ).statusCode,
      403,
    );
    await f.publish();
    process.env.DAILY_ENTITLEMENTS_ENABLED = "true";
    const r = await evaluateEntitlement(db, f.t, "test", "p5b");
    const safe = await app.inject({
      url: base + "/daily/" + r.id,
      headers: { authorization: "Bearer test-reader" },
    });
    assert.equal(safe.statusCode, 200);
    assert.equal(safe.json().revisions[0].source_value, undefined);
    assert.equal(safe.body.includes("SYNTHETIC01"), false);
    const admin = await app.inject({
      url: base + "/daily/" + r.id,
      headers: { authorization: "Bearer test-admin" },
    });
    assert.equal(admin.statusCode, 200);
    assert.equal(admin.json().revisions[0].source_value, "100.000000");
    assert.equal(admin.body.includes("SYNTHETIC01"), false);
    const bad = await app.inject({
      url: base + "/daily/" + randomUUID(),
      headers: { authorization: "Bearer test-admin" },
    });
    assert.equal(bad.statusCode, 404);
    const before = await one(
      db,
      "SELECT count(*)::int AS n FROM daily_entitlement_revisions",
    );
    const preview = await app.inject({
      method: "POST",
      url: base + "/rules/preview",
      headers: { authorization: "Bearer test-admin" },
      payload: { rule: f.rule, value: "500" },
    });
    assert.equal(preview.json().matchedTier, "tier_2");
    assert.equal(
      (
        await one(
          db,
          "SELECT count(*)::int AS n FROM daily_entitlement_revisions",
        )
      ).n,
      before.n,
    );
  } finally {
    await app.close();
  }
});
test('P5B task lease recovery, transient retry and business pending completes without retry loop',async()=>{
 const f=await fixture();await f.publish();process.env.DAILY_ENTITLEMENTS_ENABLED='true';
 await scheduleEntitlements(db,f.s,f.platform.id,'2026-09-28','manual_recalculate','p5b');
 const task=await one(db,'SELECT id FROM entitlement_evaluation_tasks WHERE brand_id=$1 ORDER BY created_at LIMIT 1',[f.s.brandId]);
 let fail=true;
 const wrapped:Database={...db,transaction:fn=>db.transaction(tx=>fn({query:async(sql,params)=>{if(fail&&sql.startsWith('SELECT id FROM platforms')){fail=false;throw Object.assign(new Error('test'),{code:'40001'})}return tx.query(sql,params)}}))};
 const retry=await runEntitlementTasks(wrapped,f.s,1);assert.equal(retry[0]?.outcome,'transient_error');
 await db.query("UPDATE entitlement_evaluation_tasks SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[task.id]);
 const recovered=await runEntitlementTasks(db,f.s,1);assert.equal(recovered[0]?.outcome,'changed');
 assert.equal((await one(db,'SELECT status,attempts FROM entitlement_evaluation_tasks WHERE id=$1',[task.id])).status,'completed');
 assert.equal((await runEntitlementTasks(db,f.s,1)).length,0);
});
