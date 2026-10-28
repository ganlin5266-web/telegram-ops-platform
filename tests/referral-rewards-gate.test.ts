import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/migrations.js";
import { one, type Database, type Queryable } from "../src/db.js";
import {
  evaluateReferralByIdentityTx,
  evaluateReferralReward,
  referralRewardScopeEnabled,
  referralRewardsEnabled,
} from "../src/referral-rewards.js";

let db: Database;
let close: () => Promise<void>;
let manualScope: { brandId: string; botId: string; platformId: string; adminId: string; referralId: string; identityId: string; userIds: string[] };

before(async () => {
  const p = new PGlite();
  const adapt = (client: any): Queryable => ({
    query: async (sql, params) =>
      params === undefined
        ? (await client.exec(sql)).at(-1) ?? { rows: [] }
        : client.query(sql, params),
  });
  db = { ...adapt(p), transaction: (fn) => p.transaction((tx) => fn(adapt(tx))) };
  close = () => p.close();
  await migrate(db);
  const brand = await one(db, "INSERT INTO brands(name,slug,default_language) VALUES('B2A gate',$1,'en') RETURNING id", [randomUUID()]);
  const bot = await one(db, "INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status) VALUES($1,'B2A gate',$2,$3,$4,'en',ARRAY['en'],'active') RETURNING id", [brand.id, randomUUID(), randomUUID(), randomUUID()]);
  const platform = await one(db, "INSERT INTO platforms(brand_id,code,display_name,market,timezone,currency,verification_method) VALUES($1,'B2A_GATE','B2A gate','BR','UTC','BRL','manual_admin') RETURNING id", [brand.id]);
  const admin = await one(db, "INSERT INTO admins(auth_subject,display_name) VALUES($1,'B2A gate') RETURNING id", [randomUUID()]);
  await db.query("INSERT INTO admin_roles(admin_id,role_id,brand_id) SELECT $1,id,$2 FROM roles WHERE name='Super Admin'", [admin.id, brand.id]);
  const inviter = await one(db, "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,700001) RETURNING id", [brand.id, bot.id]);
  const invitee = await one(db, "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,700002) RETURNING id", [brand.id, bot.id]);
  const referral = await one(db, "INSERT INTO referrals(brand_id,bot_id,inviter_id,invitee_id,start_parameter) VALUES($1,$2,$3,$4,'gate') RETURNING id", [brand.id, bot.id, inviter.id, invitee.id]);
  const identity = await one(db, "INSERT INTO platform_identities(brand_id,bot_id,user_id,telegram_user_id,platform_id,platform_uid,verification_method,submission_key) VALUES($1,$2,$3,700002,$4,'GATE-UID','manual_admin',$5) RETURNING id", [brand.id, bot.id, invitee.id, platform.id, randomUUID()]);
  await db.query("UPDATE platform_identities SET status='verified',verified_at=now(),verified_by=$2,evidence_reference='CASE-GATE' WHERE id=$1", [identity.id, admin.id]);
  manualScope = { brandId: brand.id, botId: bot.id, platformId: platform.id, adminId: admin.id, referralId: referral.id, identityId: identity.id, userIds: [inviter.id, invitee.id] };
});

after(async () => {
  delete process.env.BATCH2A_REFERRAL_REWARDS_ENABLED;
  delete process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON;
  await close();
});

test("allowlist is fail-closed and requires one exact Brand/Bot/Platform tuple", async () => {
  process.env.BATCH2A_REFERRAL_REWARDS_ENABLED = "true";
  const invalid = [
    undefined,
    "",
    "not-json",
    "[]",
    "{}",
    JSON.stringify([{ brandId: manualScope.brandId, botId: manualScope.botId }]),
    JSON.stringify([
      { brandId: manualScope.brandId, botId: manualScope.botId, platformId: manualScope.platformId, userIds: manualScope.userIds },
      { brandId: manualScope.brandId, botId: manualScope.botId, platformId: manualScope.platformId, userIds: manualScope.userIds },
    ]),
  ];
  for (const value of invalid) {
    if (value === undefined) delete process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON;
    else process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON = value;
    assert.equal(referralRewardScopeEnabled(manualScope), false);
    assert.deepEqual(await db.transaction(tx => evaluateReferralByIdentityTx(tx, manualScope.identityId, randomUUID())), { status: "disabled" });
    assert.deepEqual(await evaluateReferralReward(db, { adminId: manualScope.adminId }, manualScope, manualScope.referralId, randomUUID()), { status: "disabled" });
  }
  for (const scope of [
    { brandId: randomUUID(), botId: manualScope.botId, platformId: manualScope.platformId, userIds: manualScope.userIds },
    { brandId: manualScope.brandId, botId: randomUUID(), platformId: manualScope.platformId, userIds: manualScope.userIds },
    { brandId: manualScope.brandId, botId: manualScope.botId, platformId: randomUUID() },
  ]) {
    process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON = JSON.stringify([scope]);
    assert.equal(referralRewardScopeEnabled(manualScope), false);
    assert.deepEqual(await db.transaction(tx => evaluateReferralByIdentityTx(tx, manualScope.identityId, randomUUID())), { status: "disabled" });
  }
  process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON = JSON.stringify([{
    brandId: manualScope.brandId,
    botId: manualScope.botId,
    platformId: manualScope.platformId, userIds: manualScope.userIds,
  }]);
  assert.equal(referralRewardScopeEnabled(manualScope), true);
  assert.equal((await db.transaction(tx => evaluateReferralByIdentityTx(tx, manualScope.identityId, randomUUID()))).status, "rule_unavailable");
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM point_ledger")).n, 0);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM referral_reward_events")).n, 0);
});

test("Batch 2A gate is closed by default and fails closed for invalid values", async () => {
  for (const value of [undefined, "false", "TRUE", "1", "yes"]) {
    if (value === undefined) delete process.env.BATCH2A_REFERRAL_REWARDS_ENABLED;
    else process.env.BATCH2A_REFERRAL_REWARDS_ENABLED = value;
    assert.equal(referralRewardsEnabled(), false);
    assert.deepEqual(
      await db.transaction((tx) => evaluateReferralByIdentityTx(tx, randomUUID(), randomUUID())),
      { status: "disabled" },
    );
    assert.deepEqual(
      await evaluateReferralReward(db, { adminId: manualScope.adminId }, { brandId: manualScope.brandId, botId: manualScope.botId }, randomUUID(), randomUUID()),
      { status: "disabled" },
    );
  }
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM point_ledger")).n, 0);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM referral_reward_events")).n, 0);
});

test("gate toggling does not backfill a disabled historical identity or queue work", async () => {
  process.env.BATCH2A_REFERRAL_REWARDS_ENABLED = "false";
  delete process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON;
  const before = await one(db, "SELECT count(*)::int AS n FROM referral_reward_events");
  const result = await db.transaction((tx) => evaluateReferralByIdentityTx(tx, randomUUID(), randomUUID()));
  assert.equal(result.status, "disabled");
  process.env.BATCH2A_REFERRAL_REWARDS_ENABLED = "true";
  process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON = JSON.stringify([{
    brandId: manualScope.brandId,
    botId: manualScope.botId,
    platformId: manualScope.platformId, userIds: manualScope.userIds,
  }]);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM referral_reward_events")).n, before.n);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM referral_qualification_evidence")).n, 0);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM referral_reward_daily_counters")).n, 0);
});

test("ten concurrent disabled entry points produce no writes", async () => {
  process.env.BATCH2A_REFERRAL_REWARDS_ENABLED = "false";
  delete process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON;
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      db.transaction((tx) => evaluateReferralByIdentityTx(tx, randomUUID(), randomUUID())),
    ),
  );
  assert.equal(results.every((r) => r.status === "disabled"), true);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM point_ledger")).n, 0);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM point_lots")).n, 0);
});
