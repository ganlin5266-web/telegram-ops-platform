import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/migrations.js";
import { one, postgres, type Database, type Queryable } from "../src/db.js";
import { createPolicy, publishPolicy } from "../src/point-lots.js";
import { cutoverBot } from "../src/point-lot-maintenance.js";
import { changeReferralRule, createReferralRule, evaluateReferralByIdentityTx, evaluateReferralReward } from "../src/referral-rewards.js";
import { reviewIdentity } from "../src/platform-identities.js";

let db: Database;
let close: () => Promise<void>;
const usePg17 = Boolean(process.env.TEST_DATABASE_URL);

before(async () => {
  process.env.BATCH2A_REFERRAL_REWARDS_ENABLED = "true";
  process.env.POINT_LOTS_ENABLED = "true";
  if (process.env.TEST_DATABASE_URL) {
    const pg = postgres(process.env.TEST_DATABASE_URL);
    db = pg;
    close = pg.close;
  } else {
    const p = new PGlite();
    const adapt = (client: any): Queryable => ({
      query: async (sql, params) =>
        params === undefined
          ? (await client.exec(sql)).at(-1) ?? { rows: [] }
          : client.query(sql, params),
    });
    db = { ...adapt(p), transaction: (fn) => p.transaction((tx) => fn(adapt(tx))) };
    close = () => p.close();
  }
  await migrate(db);
});

after(async () => {
  delete process.env.BATCH2A_REFERRAL_REWARDS_ENABLED;
  delete process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON;
  delete process.env.POINT_LOTS_ENABLED;
  await close();
});

function allowScope(brandId: string, botId: string, platformId: string, userIds: string[]) {
  const existing = JSON.parse(process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON ?? "[]");
  process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON = JSON.stringify([
    ...existing,
    { brandId, botId, platformId, userIds },
  ]);
}

async function fixture(verified = true) {
  const brand = await one(db, "INSERT INTO brands(name,slug,default_language) VALUES('Lots B2A',$1,'en') RETURNING id", [randomUUID()]);
  const platform = await one(db, "INSERT INTO platforms(brand_id,code,display_name,market,timezone,currency,verification_method) VALUES($1,'LOTS_B2A','Lots B2A','BR','UTC','BRL','manual_admin') RETURNING id", [brand.id]);
  const bot = await one(db, "INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status) VALUES($1,'Lots B2A',$2,$3,$4,'en',ARRAY['en'],'active') RETURNING id", [brand.id,randomUUID(),randomUUID(),randomUUID()]);
  const admin = await one(db, "INSERT INTO admins(auth_subject,display_name) VALUES($1,'Lots Admin') RETURNING id", [randomUUID()]);
  await db.query("INSERT INTO admin_roles(admin_id,role_id,brand_id) SELECT $1,id,$2 FROM roles WHERE name='Super Admin'", [admin.id, brand.id]);
  const level = await one(db, "INSERT INTO member_rule_versions(brand_id,kind,version,status,effective_from,effective_until,config,created_by) VALUES($1,'level',1,'draft','2026-01-01','2026-12-31',$2,$3) RETURNING id", [brand.id, JSON.stringify({ levels: [{ threshold: 0 }], grandfather: true }), admin.id]);
  await db.query("UPDATE member_rule_versions SET status='published',published_at=now(),published_by=$2 WHERE id=$1", [level.id, admin.id]);
  const inviter = await one(db, "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,1) RETURNING id", [brand.id, bot.id]);
  const invitee = await one(db, "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,2) RETURNING id", [brand.id, bot.id]);
  const member = await one(db, "INSERT INTO members(brand_id,telegram_user_id,level,level_rule_id) VALUES($1,1,1,$2) RETURNING id", [brand.id, level.id]);
  await db.query("INSERT INTO member_user_links(brand_id,bot_id,user_id,member_id,telegram_user_id) VALUES($1,$2,$3,$4,1)", [brand.id,bot.id,inviter.id,member.id]);
  const referral = await one(db, "INSERT INTO referrals(brand_id,bot_id,inviter_id,invitee_id,start_parameter) VALUES($1,$2,$3,$4,'lots') RETURNING id", [brand.id,bot.id,inviter.id,invitee.id]);
  const identity = await one(db, "INSERT INTO platform_identities(brand_id,bot_id,user_id,telegram_user_id,platform_id,platform_uid,verification_method,submission_key) VALUES($1,$2,$3,2,$4,'LOTS-UID','manual_admin',$5) RETURNING id", [brand.id,bot.id,invitee.id,platform.id,randomUUID()]);
  if (verified) await db.query("UPDATE platform_identities SET status='verified',verified_at=now(),verified_by=$2,evidence_reference='CASE-LOTS' WHERE id=$1", [identity.id, admin.id]);
  allowScope(brand.id, bot.id, platform.id, [inviter.id, invitee.id]);
  await db.transaction((tx) => cutoverBot(tx, { brandId: brand.id, botId: bot.id }));
  await db.transaction(async (tx) => {
    const policy = await createPolicy(tx, { brandId: brand.id, botId: bot.id }, admin.id, { name: "B2A lots", source: "*", mode: "permanent", timezone: "UTC", effectiveAt: new Date(Date.now() - 60000).toISOString() }, "lots-policy");
    await publishPolicy(tx, { brandId: brand.id, botId: bot.id }, admin.id, policy.id, "lots-policy");
  });
  const referralRule = await createReferralRule(db, { adminId: admin.id }, brand.id, { platformId: platform.id, campaignKey: "LOTS-B2A", effectiveFrom: "2026-01-01", effectiveUntil: null, inviteeEnabled: true }, "lots-rule");
  await changeReferralRule(db, { adminId: admin.id }, brand.id, referralRule.id, "publish", "lots-rule");
  const scope = { brandId: brand.id, botId: bot.id };
  return { ...scope, adminId: admin.id, brandId: brand.id, botId: bot.id, platformId: platform.id, inviter: inviter.id, invitee: invitee.id, referral: referral.id, identity: identity.id };
}

test("verified UID hook uses the same exact-scope gate and never backfills mismatched history", async () => {
  const mismatched = await fixture(false);
  process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON = JSON.stringify([{
    brandId: mismatched.brandId,
    botId: mismatched.botId,
    platformId: randomUUID(),
    userIds: [mismatched.inviter, mismatched.invitee],
  }]);
  await reviewIdentity(db, { adminId: mismatched.adminId }, { brandId: mismatched.brandId, botId: mismatched.botId }, mismatched.identity, { action: "verify", evidenceReference: "CASE-AUTO-MISMATCH" }, randomUUID());
  assert.equal((await one(db, "SELECT count(*)::int n FROM referral_reward_events WHERE referral_id=$1", [mismatched.referral])).n, 0);
  allowScope(mismatched.brandId, mismatched.botId, mismatched.platformId, [mismatched.inviter, mismatched.invitee]);
  assert.equal((await one(db, "SELECT count(*)::int n FROM referral_reward_events WHERE referral_id=$1", [mismatched.referral])).n, 0);

  const matched = await fixture(false);
  await reviewIdentity(db, { adminId: matched.adminId }, { brandId: matched.brandId, botId: matched.botId }, matched.identity, { action: "verify", evidenceReference: "CASE-AUTO-MATCH" }, randomUUID());
  assert.equal((await one(db, "SELECT count(*)::int n FROM referral_reward_events WHERE referral_id=$1", [matched.referral])).n, 2);
  assert.equal((await one(db, "SELECT count(*)::int n FROM point_ledger WHERE bot_id=$1", [matched.botId])).n, 2);
});

test("Lots-enabled referral reward is atomically 50/20, idempotent, and rolls back on failure", async (t) => {
  if (!usePg17) t.diagnostic("Run with TEST_DATABASE_URL against isolated PostgreSQL 17 for the required multi-connection acceptance.");
  const f = await fixture();
  const granted = await db.transaction((tx) => evaluateReferralByIdentityTx(tx, f.identity, randomUUID()));
  assert.equal(granted.status, "granted");
  assert.equal((await one(db, "SELECT coalesce(sum(balance),0)::text AS n FROM point_accounts WHERE bot_id=$1", [f.botId])).n, "70");
  assert.equal((await one(db, "SELECT coalesce(sum(delta),0)::text AS n FROM point_ledger WHERE bot_id=$1", [f.botId])).n, "70");
  assert.equal((await one(db, "SELECT coalesce(sum(remaining_amount),0)::text AS n FROM point_lots WHERE bot_id=$1", [f.botId])).n, "70");
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM point_ledger WHERE bot_id=$1", [f.botId])).n, 2);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM point_lots WHERE bot_id=$1", [f.botId])).n, 2);
  const duplicate = await db.transaction((tx) => evaluateReferralByIdentityTx(tx, f.identity, randomUUID()));
  assert.equal(duplicate.status, "already_rewarded");
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM point_ledger WHERE bot_id=$1", [f.botId])).n, 2);
  process.env.BATCH2A_REFERRAL_REWARDS_ENABLED = "false";
  const stopped = await db.transaction((tx) => evaluateReferralByIdentityTx(tx, f.identity, randomUUID()));
  assert.equal(stopped.status, "disabled");
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM point_ledger WHERE bot_id=$1", [f.botId])).n, 2);
  process.env.BATCH2A_REFERRAL_REWARDS_ENABLED = "true";
  const failed = await fixture();
  process.env.POINT_WRITES_PAUSED = "true";
  try {
    await assert.rejects(
      () => db.transaction((tx) => evaluateReferralByIdentityTx(tx, failed.identity, randomUUID())),
      /point_writes_paused/,
    );
  } finally {
    delete process.env.POINT_WRITES_PAUSED;
  }
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM referral_reward_events WHERE bot_id=$1", [failed.botId])).n, 0);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM referral_qualification_evidence WHERE bot_id=$1", [failed.botId])).n, 0);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM referral_reward_daily_counters WHERE brand_id=$1", [failed.brandId])).n, 0);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM point_ledger WHERE bot_id=$1", [failed.botId])).n, 0);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM point_lots WHERE bot_id=$1", [failed.botId])).n, 0);
});

test("Lots-enabled concurrent evaluation grants one referral exactly once", async (t) => {
  if (!usePg17) {
    t.skip("Requires two independent PostgreSQL 17 connections");
    return;
  }
  const f = await fixture();
  const results = await Promise.allSettled([
    db.transaction((tx) => evaluateReferralByIdentityTx(tx, f.identity, randomUUID())),
    db.transaction((tx) => evaluateReferralByIdentityTx(tx, f.identity, randomUUID())),
  ]);
  const values = results.filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled").map((r) => r.value.status);
  assert.deepEqual(values.sort(), ["already_rewarded", "granted"]);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM point_ledger WHERE bot_id=$1", [f.botId])).n, 2);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM point_lots WHERE bot_id=$1", [f.botId])).n, 2);
});

function setUsers(f: Awaited<ReturnType<typeof fixture>>, userIds: unknown) {
  process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON = JSON.stringify([{
    brandId: f.brandId, botId: f.botId, platformId: f.platformId, userIds,
  }]);
}

async function assertNoRewardWrites(f: Awaited<ReturnType<typeof fixture>>) {
  for (const table of ["point_accounts", "point_ledger", "point_lots", "referral_reward_events", "referral_qualification_evidence", "referral_reward_daily_counters", "growth_ledger"]) {
    assert.equal((await one(db, `SELECT count(*)::int n FROM ${table} WHERE brand_id=$1`, [f.brandId])).n, 0, table);
  }
  assert.equal((await one(db, "SELECT count(*)::int n FROM audit_logs WHERE brand_id=$1 AND action LIKE 'referral.reward.%'", [f.brandId])).n, 0);
}

test("user gate fails closed for missing, empty, invalid and duplicate IDs on internal and manual entry", async () => {
  const f = await fixture();
  for (const ids of [undefined, [], [f.inviter], "all", [f.inviter, "bad"], [f.inviter, f.inviter], [f.inviter, f.inviter.toUpperCase()]]) {
    setUsers(f, ids);
    assert.equal((await db.transaction(tx => evaluateReferralByIdentityTx(tx, f.identity, randomUUID()))).status, "disabled");
    assert.equal((await evaluateReferralReward(db, { adminId: f.adminId }, f, f.referral, randomUUID())).status, "disabled");
    await assertNoRewardWrites(f);
  }
});

test("both inviter and invitee must be allowed, including inviter-only campaigns; cross-tuple IDs cannot combine", async () => {
  const f = await fixture();
  for (const ids of [[f.inviter, randomUUID()], [randomUUID(), f.invitee]]) {
    setUsers(f, ids);
    assert.equal((await db.transaction(tx => evaluateReferralByIdentityTx(tx, f.identity, randomUUID()))).status, "disabled");
  }
  const rule = await one(db, "SELECT id FROM referral_reward_rule_versions WHERE brand_id=$1", [f.brandId]);
  await changeReferralRule(db, {adminId:f.adminId}, f.brandId, rule.id, "disable", randomUUID());
  const next = await createReferralRule(db, {adminId:f.adminId}, f.brandId, {platformId:f.platformId,campaignKey:"INVITER-ONLY",effectiveFrom:"2026-01-01",inviteeEnabled:false}, randomUUID());
  await changeReferralRule(db, {adminId:f.adminId}, f.brandId, next.id, "publish", randomUUID());
  setUsers(f, [f.inviter, randomUUID()]);
  assert.equal((await db.transaction(tx => evaluateReferralByIdentityTx(tx, f.identity, randomUUID()))).status, "disabled");
  const other = await fixture();
  process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON = JSON.stringify([
    {brandId:f.brandId,botId:f.botId,platformId:f.platformId,userIds:[f.inviter,other.invitee]},
    {brandId:other.brandId,botId:other.botId,platformId:other.platformId,userIds:[other.inviter,f.invitee]},
  ]);
  assert.equal((await db.transaction(tx => evaluateReferralByIdentityTx(tx, f.identity, randomUUID()))).status, "disabled");
  await assertNoRewardWrites(f);
});

test("UID verify hook excludes same-tuple nonallowlisted users and configuration changes never enqueue history", async () => {
  const f = await fixture(false);
  setUsers(f, [f.inviter, randomUUID()]);
  await reviewIdentity(db, {adminId:f.adminId}, f, f.identity, {action:"verify",evidenceReference:"CASE-SYNTH-EXCLUDED"}, randomUUID());
  await assertNoRewardWrites(f);
  setUsers(f, [f.inviter, f.invitee]);
  await assertNoRewardWrites(f);
  const g = await fixture(false);
  setUsers(g, [randomUUID(), g.invitee]);
  await reviewIdentity(db, {adminId:g.adminId}, g, g.identity, {action:"verify",evidenceReference:"CASE-SYNTH-EXCLUDED-INVITER"}, randomUUID());
  await assertNoRewardWrites(g);
});

test("inactive participants and unauthorized admins cannot use user allowlist to bypass identity or RBAC", async () => {
  const f = await fixture();
  setUsers(f, [f.inviter, f.invitee]);
  await assert.rejects(() => evaluateReferralReward(db, {adminId:randomUUID()}, f, f.referral, randomUUID()), /forbidden/);
  await db.query("UPDATE telegram_users SET status='blocked' WHERE id=$1", [f.invitee]);
  assert.equal((await db.transaction(tx => evaluateReferralByIdentityTx(tx, f.identity, randomUUID()))).status, "disabled");
  await assertNoRewardWrites(f);
});

test("PG17 concurrent excluded retries are write-free and user removal stops later manual/internal rewards", async (t) => {
  if (!usePg17) { t.skip("Requires independent PG17 connections"); return; }
  const f = await fixture();
  setUsers(f, [f.inviter, randomUUID()]);
  const results = await Promise.all(Array.from({length:10}, (_,i) => i%2
    ? evaluateReferralReward(db,{adminId:f.adminId},f,f.referral,randomUUID())
    : db.transaction(tx=>evaluateReferralByIdentityTx(tx,f.identity,randomUUID()))));
  assert.ok(results.every(r=>r.status==='disabled'));
  await assertNoRewardWrites(f);
  setUsers(f,[f.inviter,f.invitee]);
  const granted=await evaluateReferralReward(db,{adminId:f.adminId},f,f.referral,randomUUID());
  assert.equal(granted.status,'granted');
  setUsers(f,[f.inviter,randomUUID()]);
  assert.equal((await evaluateReferralReward(db,{adminId:f.adminId},f,f.referral,randomUUID())).status,'disabled');
  const money=await one(db, `SELECT (SELECT sum(balance)::text FROM point_accounts WHERE bot_id=$1) balance,
    (SELECT sum(delta)::text FROM point_ledger WHERE bot_id=$1) ledger,
    (SELECT sum(remaining_amount)::text FROM point_lots WHERE bot_id=$1) lots,
    (SELECT count(*)::int FROM point_ledger WHERE bot_id=$1) rows`,[f.botId]);
  assert.deepEqual(money,{balance:'70',ledger:'70',lots:'70',rows:2});
});
