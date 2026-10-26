import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/migrations.js";
import { one, type Database, type Queryable } from "../src/db.js";
import { changeReferralRule, createReferralRule, evaluateReferralByIdentityTx } from "../src/referral-rewards.js";

let db: Database;
let close: () => Promise<void>;
before(async () => {
  process.env.BATCH2A_REFERRAL_REWARDS_ENABLED = "true";
  const p = new PGlite();
  const adapt = (client: any): Queryable => ({
    query: async (sql, params) =>
      params === undefined ? (await client.exec(sql)).at(-1) ?? { rows: [] } : client.query(sql, params),
  });
  db = { ...adapt(p), transaction: (fn) => p.transaction((tx) => fn(adapt(tx))) };
  close = () => p.close();
  await migrate(db);
});
after(async () => {
  delete process.env.BATCH2A_REFERRAL_REWARDS_ENABLED;
  delete process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON;
  await close();
});

test("Batch 2A grants 50/20 atomically and counts invitations separately from ledger rows", async () => {
  const brand = await one(db, "INSERT INTO brands(name,slug,default_language) VALUES('B2A',$1,'en') RETURNING id", [randomUUID()]);
  const platform = await one(db, `INSERT INTO platforms(brand_id,code,display_name,market,timezone,currency,verification_method) VALUES($1,'B2A','B2A','BR','UTC','BRL','manual_admin') RETURNING id`, [brand.id]);
  const bot = await one(db, `INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status) VALUES($1,'B2A',$2,$3,$4,'en',ARRAY['en'],'active') RETURNING id`, [brand.id,randomUUID(),randomUUID(),randomUUID()]);
  process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON = JSON.stringify([
    { brandId: brand.id, botId: bot.id, platformId: platform.id },
  ]);
  const admin = await one(db, "INSERT INTO admins(auth_subject,display_name) VALUES($1,'B2A') RETURNING id", [randomUUID()]);
  await db.query("INSERT INTO admin_roles(admin_id,role_id,brand_id) SELECT $1,id,$2 FROM roles WHERE name='Super Admin'", [admin.id,brand.id]);
  const rule = await one(db, `INSERT INTO member_rule_versions(brand_id,kind,version,status,effective_from,effective_until,config,created_by) VALUES($1,'level',1,'draft','2026-01-01','2026-12-31',$2,$3) RETURNING id`, [brand.id,JSON.stringify({levels:[{threshold:0},{threshold:500},{threshold:2000},{threshold:6000},{threshold:15000}],grandfather:true}),admin.id]);
  await db.query("UPDATE member_rule_versions SET status='published',published_at=now(),published_by=$2 WHERE id=$1", [rule.id,admin.id]);
  const inviter = await one(db, "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,1) RETURNING id", [brand.id,bot.id]);
  const member = await one(db, "INSERT INTO members(brand_id,telegram_user_id,level,level_rule_id) VALUES($1,1,1,$2) RETURNING id", [brand.id,rule.id]);
  await db.query("INSERT INTO member_user_links(brand_id,bot_id,user_id,member_id,telegram_user_id) VALUES($1,$2,$3,$4,1)", [brand.id,bot.id,inviter.id,member.id]);
  const referralIds: string[] = [], identityIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const user = await one(db, "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,$3) RETURNING id", [brand.id,bot.id,100 + i]);
    const referral = await one(db, "INSERT INTO referrals(brand_id,bot_id,inviter_id,invitee_id,start_parameter) VALUES($1,$2,$3,$4,$5) RETURNING id", [brand.id,bot.id,inviter.id,user.id,`s${i}`]);
    const identity = await one(db, `INSERT INTO platform_identities(brand_id,bot_id,user_id,telegram_user_id,platform_id,platform_uid,verification_method,submission_key) VALUES($1,$2,$3,$4,$5,$6,'manual_admin',$7) RETURNING id`, [brand.id,bot.id,user.id,100 + i,platform.id,`UID${i}`,randomUUID()]);
    await db.query("UPDATE platform_identities SET status='verified',verified_at=now(),verified_by=$2,evidence_reference=$3 WHERE id=$1", [identity.id,admin.id,`CASE-${i}`]);
    referralIds.push(referral.id); identityIds.push(identity.id);
  }
  const rewardRule = await createReferralRule(db, { adminId: admin.id }, brand.id, { platformId: platform.id, campaignKey: "B2A", effectiveFrom: "2026-01-01", effectiveUntil: null, inviteeEnabled: true }, randomUUID());
  await changeReferralRule(db, { adminId: admin.id }, brand.id, rewardRule.id, "publish", randomUUID());
  const outsider = await one(db, "INSERT INTO admins(auth_subject,display_name) VALUES($1,'OUTSIDER') RETURNING id", [randomUUID()]);
  await assert.rejects(() => createReferralRule(db, { adminId: outsider.id }, brand.id, { platformId: platform.id, campaignKey: "DENIED", effectiveFrom: "2026-01-01", effectiveUntil: null }, randomUUID()), /forbidden/);
  const results = [];
  for (const identityId of identityIds)
    results.push(await db.transaction((tx) => evaluateReferralByIdentityTx(tx, identityId, randomUUID())));
  assert.equal(results.filter((r: any) => r.status === "granted").length, 5);
  assert.equal(results.at(-1)!.status, "cap_exceeded");
  assert.deepEqual(await one(db, "SELECT qualified_count,rewarded_count FROM referral_reward_daily_counters"), { qualified_count: 6, rewarded_count: 5 });
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM referral_reward_events")).n, 10);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM point_ledger")).n, 10);
  assert.equal((await one(db, "SELECT balance::text FROM point_accounts WHERE user_id=$1", [inviter.id])).balance, "250");
  const duplicate = await db.transaction((tx) => evaluateReferralByIdentityTx(tx, identityIds[0]!, randomUUID()));
  assert.equal(duplicate.status, "already_rewarded");
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM point_ledger")).n, 10);
  await db.query("UPDATE platform_identities SET status='revoked',revoked_at=now(),revoked_by=$2,reason_code='user_request' WHERE id=$1", [identityIds[0], admin.id]);
  const secondBot = await one(db, `INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status) VALUES($1,'B2A second bot',$2,$3,$4,'en',ARRAY['en'],'active') RETURNING id`, [brand.id,randomUUID(),randomUUID(),randomUUID()]);
  const secondInviter = await one(db, "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,2001) RETURNING id", [brand.id, secondBot.id]);
  const secondInvitee = await one(db, "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,2002) RETURNING id", [brand.id, secondBot.id]);
  const secondMember = await one(db, "INSERT INTO members(brand_id,telegram_user_id,level,level_rule_id) VALUES($1,2001,1,$2) RETURNING id", [brand.id, rule.id]);
  await db.query("INSERT INTO member_user_links(brand_id,bot_id,user_id,member_id,telegram_user_id) VALUES($1,$2,$3,$4,2001)", [brand.id, secondBot.id, secondInviter.id, secondMember.id]);
  const secondReferral = await one(db, "INSERT INTO referrals(brand_id,bot_id,inviter_id,invitee_id,start_parameter) VALUES($1,$2,$3,$4,'cross-bot') RETURNING id", [brand.id, secondBot.id, secondInviter.id, secondInvitee.id]);
  const secondIdentity = await one(db, `INSERT INTO platform_identities(brand_id,bot_id,user_id,telegram_user_id,platform_id,platform_uid,verification_method,submission_key) VALUES($1,$2,$3,2002,$4,'UID0','manual_admin',$5) RETURNING id`, [brand.id, secondBot.id, secondInvitee.id, platform.id, randomUUID()]);
  await db.query("UPDATE platform_identities SET status='verified',verified_at=now(),verified_by=$2,evidence_reference='CASE-CROSS-BOT' WHERE id=$1", [secondIdentity.id, admin.id]);
  process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON = JSON.stringify([
    { brandId: brand.id, botId: bot.id, platformId: platform.id },
    { brandId: brand.id, botId: secondBot.id, platformId: platform.id },
  ]);
  const crossBot = await db.transaction((tx) => evaluateReferralByIdentityTx(tx, secondIdentity.id, randomUUID()));
  assert.equal(crossBot.status, "manual_review");
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM referral_reward_events WHERE referral_id=$1", [secondReferral.id])).n, 0);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM point_ledger")).n, 10);
  await changeReferralRule(db, { adminId: admin.id }, brand.id, rewardRule.id, "disable", randomUUID());
  const disabledUser = await one(db, "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,999) RETURNING id", [brand.id,bot.id]);
  const disabledReferral = await one(db, "INSERT INTO referrals(brand_id,bot_id,inviter_id,invitee_id,start_parameter) VALUES($1,$2,$3,$4,'disabled') RETURNING id", [brand.id,bot.id,inviter.id,disabledUser.id]);
  const disabledIdentity = await one(db, `INSERT INTO platform_identities(brand_id,bot_id,user_id,telegram_user_id,platform_id,platform_uid,verification_method,submission_key) VALUES($1,$2,$3,999,$4,'UID999','manual_admin',$5) RETURNING id`, [brand.id,bot.id,disabledUser.id,platform.id,randomUUID()]);
  await db.query("UPDATE platform_identities SET status='verified',verified_at=now(),verified_by=$2,evidence_reference='CASE-DISABLED' WHERE id=$1", [disabledIdentity.id,admin.id]);
  assert.equal((await db.transaction((tx) => evaluateReferralByIdentityTx(tx, disabledIdentity.id, randomUUID()))).status, "rule_unavailable");
  assert.ok(disabledReferral.id);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM point_ledger")).n, 10);
  assert.equal(referralIds.length, 6);
});
