import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { one, postgres, type Database, type Queryable } from "../src/db.js";
import { migrate } from "../src/migrations.js";
import {
  createMemberRule,
  publishMemberRule,
  initializeMember,
  miniMemberSummary,
  checkinGrowth,
  recordGrowthEvaluation,
} from "../src/member-growth.js";
import { DEFAULT_LEVELS, defaultGrowth } from "../src/member-domain.js";
import {
  miniPlatforms,
  miniReferralSummary,
  miniPrimaryAction,
  referralRecordSql,
} from "../src/mini-experience.js";
import {
  redemptionCatalogue,
  createFixedRedemption,
  claimRedemptionCode,
  reviewRedemption,
} from "../src/redemption-flow.js";
import {
  createRedemptionRule,
  changeRedemptionRule,
  importCodeBatch,
} from "../src/redemption-v2.js";
import { createRedemptionCodeVault } from "../src/redemption-vault.js";
import {
  createReferralRule,
  changeReferralRule,
  evaluateReferralByIdentityTx,
} from "../src/referral-rewards.js";
import { postPoints } from "../src/points.js";
import { dateInZone } from "../src/entitlement-domain.js";
import { createApp } from "../src/app.js";
import { miniDigest } from "../src/mini-sessions.js";
let db: Database, close: () => Promise<void>;
const adapt = (x: any): Queryable => ({
  query: async (sql, params) =>
    params === undefined
      ? ((await x.exec(sql)).at(-1) ?? { rows: [] })
      : x.query(sql, params),
});
const envKeys = [
  "MEMBER_GROWTH_ENABLED",
  "POINT_LOTS_ENABLED",
  "BATCH2A_REFERRAL_REWARDS_ENABLED",
  "BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON",
];
const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
const vault = createRedemptionCodeVault({
  REDEMPTION_CODE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  REDEMPTION_CODE_FINGERPRINT_KEY: randomBytes(32).toString("base64"),
  REDEMPTION_CODE_KEY_VERSION: "p0-test",
})!;
before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    const pg = postgres(url.toString());
    db = pg;
    close = pg.close;
    assert.equal(
      Math.floor(
        Number((await one(db, "SHOW server_version_num")).server_version_num) /
          10000,
      ),
      17,
    );
  } else {
    const pg = new PGlite();
    db = {
      ...adapt(pg),
      transaction: (fn) => pg.transaction((tx) => fn(adapt(tx))),
    };
    close = () => pg.close();
  }
  await migrate(db);
  process.env.MEMBER_GROWTH_ENABLED = "true";
  process.env.POINT_LOTS_ENABLED = "false";
  process.env.BATCH2A_REFERRAL_REWARDS_ENABLED = "false";
  delete process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON;
});
after(async () => {
  await close();
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
let tid = 970000;
async function fixture(initialize = true) {
  const brand = await one(
    db,
    "INSERT INTO brands(name,slug,default_language) VALUES('P0 Synthetic',$1,'en') RETURNING id",
    [randomUUID()],
  );
  const bot = await one(
    db,
    "INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status) VALUES($1,'P0',$2,$2,$3,'en',ARRAY['en'],'active') RETURNING id,token_secret_ref",
    [
      brand.id,
      "P0_" + randomUUID().replaceAll("-", "").toUpperCase(),
      randomUUID(),
    ],
  );
  const admin = await one(
    db,
    "INSERT INTO admins(auth_subject,display_name) VALUES($1,'P0') RETURNING id",
    [randomUUID()],
  );
  await db.query(
    "INSERT INTO admin_roles(admin_id,role_id) SELECT $1,id FROM roles WHERE name='Super Admin'",
    [admin.id],
  );
  const user = await one(
    db,
    "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,$3) RETURNING id",
    [brand.id, bot.id, ++tid],
  );
  const p = {
      brandId: brand.id,
      botId: bot.id,
      userId: user.id,
      appKey: "p0-" + randomUUID(),
      sessionId: randomUUID(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    },
    adminP = { adminId: admin.id };
  const now = new Date();
  const growth = await createMemberRule(
    db,
    adminP,
    brand.id,
    {
      kind: "growth",
      effectiveFrom: "2020-01-01",
      effectiveUntil: "2099-12-31",
      config: defaultGrowth("America/Sao_Paulo"),
    },
    "p0",
  );
  const level = await createMemberRule(
    db,
    adminP,
    brand.id,
    {
      kind: "level",
      effectiveFrom: "2020-01-01",
      effectiveUntil: "2099-12-31",
      config: DEFAULT_LEVELS,
    },
    "p0",
  );
  await publishMemberRule(db, adminP, brand.id, growth.id, "p0", now);
  await publishMemberRule(db, adminP, brand.id, level.id, "p0", now);
  const member = initialize
    ? await db.transaction((tx) => initializeMember(tx, p, now))
    : null;
  const platform = await one(
    db,
    "INSERT INTO platforms(brand_id,code,display_name,market,timezone,currency,verification_method) VALUES($1,'P0','P0','BR','America/Sao_Paulo','BRL','manual_admin') RETURNING id,timezone,(now() AT TIME ZONE timezone)::date::text AS \"businessDate\"",
    [brand.id],
  );
  return { p, adminP, platform, member, growth, level, bot };
}
function readonly(db: Queryable): Database {
  return {
    query: (sql, params) => {
      assert.match(sql.trim(), /^SELECT\b/i);
      assert.doesNotMatch(sql, /FOR\s+(UPDATE|SHARE)/i);
      return db.query(sql, params);
    },
    transaction: async () => {
      throw Error("Read-model must not open a write transaction");
    },
  };
}
async function tier(f: Awaited<ReturnType<typeof fixture>>, codes = 1) {
  const r = await createRedemptionRule(
    db,
    f.adminP,
    f.p,
    {
      platformId: f.platform.id,
      tierKey: "p0_100",
      name: "P0 Synthetic",
      pointsCost: 100,
      faceValue: "10",
      currency: "BRL",
      effectiveFrom: "2020-01-01",
      effectiveUntil: null,
    },
    "p0",
  );
  await changeRedemptionRule(db, f.adminP, f.p, r.id, "publish", "p0");
  if (codes)
    await importCodeBatch(
      db,
      vault,
      f.adminP,
      f.p,
      {
        ruleId: r.id,
        codes: Array.from({ length: codes }, () => ({
          code: "SYNTH_" + randomUUID(),
          expiresAt: null,
        })),
      },
      "p0",
    );
  return r;
}
async function fund(f: any, n: string) {
  await db.transaction((tx) =>
    postPoints(tx, {
      ...f.p,
      delta: n,
      source: "test",
      businessType: "test",
      businessId: randomUUID(),
      idempotencyKey: randomUUID(),
    }),
  );
}

test("P0 new home read does not initialize Member, account or level history; pending UID action differs from unbound", async () => {
  const f = await fixture(false),
    token = randomBytes(32).toString("hex"),
    origin = "https://p0.example.test";
  const exchange = await one(
    db,
    "INSERT INTO mini_auth_exchanges(brand_id,bot_id,payload_digest,auth_date,valid_until) VALUES($1,$2,$3,now(),now()+interval '10 minutes') RETURNING id",
    [f.p.brandId, f.p.botId, randomBytes(32).toString("hex")],
  );
  await db.query(
    "INSERT INTO mini_sessions(id,brand_id,bot_id,user_id,token_hash,app_key,exchange_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')",
    [
      f.p.sessionId,
      f.p.brandId,
      f.p.botId,
      f.p.userId,
      miniDigest(token),
      f.p.appKey,
      exchange.id,
    ],
  );
  const app = createApp(
    readonly(db),
    () => undefined,
    async () => {
      throw Error("no admin");
    },
    undefined,
    {
      bindings: [
        {
          appKey: f.p.appKey,
          botId: f.p.botId,
          origin,
          tokenSecretRef: f.bot.token_secret_ref,
        },
      ],
    },
  );
  const read = () =>
    app.inject({
      url: "/v1/mini/home?platformId=" + f.platform.id,
      headers: { authorization: "Bearer " + token, origin },
    });
  try {
    const h = await read();
    assert.equal(h.statusCode, 200, h.body);
    assert.equal(h.json().primaryAction.kind, "bind_uid");
    assert.equal(h.json().member.canCheckin, true);
    await db.query(
      "INSERT INTO platform_identities(brand_id,bot_id,user_id,telegram_user_id,platform_id,platform_uid,verification_method,submission_key) SELECT brand_id,bot_id,id,telegram_user_id,$2,'P0UID','manual_admin',$3 FROM telegram_users WHERE id=$1",
      [f.p.userId, f.platform.id, randomUUID()],
    );
    assert.equal((await read()).json().primaryAction.kind, "view_identity");
    assert.equal(
      (
        await one(db, "SELECT count(*)::int n FROM members WHERE brand_id=$1", [
          f.p.brandId,
        ])
      ).n,
      0,
    );
    assert.equal(
      (
        await one(
          db,
          "SELECT count(*)::int n FROM point_accounts WHERE brand_id=$1",
          [f.p.brandId],
        )
      ).n,
      0,
    );
    assert.equal(
      (
        await one(
          db,
          "SELECT count(*)::int n FROM member_level_history WHERE brand_id=$1",
          [f.p.brandId],
        )
      ).n,
      0,
    );
  } finally {
    await app.close();
  }
});

test("P0 existing read models run under PostgreSQL READ ONLY with no initialization or level mutation", async () => {
  const f = await fixture();
  await tier(f);
  await fund(f, "100");
  await db.transaction(async (tx) => {
    if (process.env.TEST_DATABASE_URL)
      await tx.query("SET TRANSACTION READ ONLY");
    const ro = readonly(tx);
    const member = await miniMemberSummary(ro, f.p);
    assert.equal(member.available, true);
    assert.equal(
      (await redemptionCatalogue(ro, f.p, f.platform.id)).items[0].canRedeem,
      true,
    );
    assert.equal(
      (
        await miniReferralSummary(
          ro,
          f.p,
          f.platform,
          "https://t.me/p0_bot?start=ref_p0",
        )
      ).rewardAvailability,
      "disabled",
    );
  });
});

test("P0 checkin reads actual source ledger and survives reload, idempotency and next local day", async () => {
  const f = await fixture(),
    now = new Date("2026-10-28T15:00:00Z");
  assert.equal(
    (await miniMemberSummary(readonly(db), f.p, now)).canCheckin,
    true,
  );
  await checkinGrowth(db, f.p, "p0", now);
  await checkinGrowth(db, f.p, "p0-repeat", now);
  for (let n = 0; n < 2; n++) {
    const s = await miniMemberSummary(readonly(db), f.p, now);
    assert.equal(s.todayCheckedIn, true);
    assert.equal(s.actualGrowthEarned, "5");
    assert.equal(s.canCheckin, false);
    assert.equal(s.nextAvailableAt, "2026-10-29T03:00:00.000Z");
  }
  const next = await miniMemberSummary(
    readonly(db),
    f.p,
    new Date("2026-10-29T03:00:00Z"),
  );
  assert.equal(next.todayCheckedIn, false);
  assert.equal(next.actualGrowthEarned, "0");
  assert.equal(next.canCheckin, true);
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int n FROM point_ledger WHERE brand_id=$1",
        [f.p.brandId],
      )
    ).n,
    0,
  );
});

test("P0 later high priority Growth corrects checkin to zero and read reports cap rather than fake 5", async () => {
  const f = await fixture(),
    now = new Date("2026-10-28T15:00:00Z"),
    day = dateInZone(now, "America/Sao_Paulo");
  await checkinGrowth(db, f.p, "check", now);
  for (const [kind, key, n] of [
    ["platform_daily", "platform", 150],
    ["qualified_referral", "ref1", 50],
    ["qualified_referral", "ref2", 50],
    ["qualified_referral", "ref3", 50],
    ["qualified_referral", "ref4", 50],
  ] as const)
    await db.transaction((tx) =>
      recordGrowthEvaluation(
        tx,
        {
          brandId: f.p.brandId,
          memberId: f.member!.id,
          kind,
          key,
          day,
          occurredAt: now,
          policyId: f.growth.id,
          ruleId: f.growth.id,
          status: "eligible",
          reason: "p0",
          requested: n,
          evidence: {},
        },
        "p0",
        now,
      ),
    );
  const s = await miniMemberSummary(readonly(db), f.p, now);
  assert.equal(s.todayCheckedIn, true);
  assert.equal(s.actualGrowthEarned, "0");
  assert.equal(s.todayGrowth, "350");
  assert.equal(s.checkinStatus, "cap_reached");
  assert.equal(s.canCheckin, false);
});

test("P0 catalogue distinguishes missing account, exact gap, empty stock and available redemption", async () => {
  const f = await fixture();
  await tier(f);
  let item = (await redemptionCatalogue(readonly(db), f.p)).items[0];
  assert.equal(item.balance, null);
  assert.equal(item.pointsGap, null);
  assert.equal(item.unavailableReason, "account_unavailable");
  await fund(f, "99");
  item = (await redemptionCatalogue(readonly(db), f.p)).items[0];
  assert.equal(item.pointsGap, "1");
  assert.equal(item.unavailableReason, "insufficient_points");
  await fund(f, "9007199254740993");
  item = (await redemptionCatalogue(readonly(db), f.p)).items[0];
  assert.equal(item.balance, "9007199254741092");
  assert.equal(item.pointsGap, "0");
  assert.equal(item.canRedeem, true);
  const empty = await fixture();
  await tier(empty, 0);
  await fund(empty, "100");
  assert.equal(
    (await redemptionCatalogue(readonly(db), empty.p)).items[0]
      .unavailableReason,
    "inventory_empty",
  );
});

test("P0 catalogue retains daily occupancy until confirmed refund and primary prioritizes assigned code", async () => {
  const f = await fixture();
  const r = await tier(f, 2);
  await fund(f, "200");
  const order = await createFixedRedemption(db, f.p, r.id, randomUUID(), "p0");
  let item = (await redemptionCatalogue(readonly(db), f.p)).items[0];
  assert.equal(item.unavailableReason, "daily_redemption_limit");
  assert.equal(item.usedToday, 1);
  assert.equal(item.pointsUsedToday, "100");
  assert.equal(
    miniPrimaryAction({
      platformId: f.platform.id,
      orders: [order],
      tiers: [item],
      identity: "unbound",
      member: { canCheckin: true },
      referral: { rewardEligible: true, rewardedToday: "0" },
    }).kind,
    "view_code",
  );
  await claimRedemptionCode(db, vault, f.p, order.id);
  assert.equal(
    (await redemptionCatalogue(readonly(db), f.p)).items[0].usedToday,
    1,
  );
  await reviewRedemption(
    db,
    f.adminP,
    f.p,
    order.id,
    "mark_review",
    "internal_issue",
    "p0",
  );
  await reviewRedemption(
    db,
    f.adminP,
    f.p,
    order.id,
    "refund",
    "confirmed_internal_failure",
    "p0",
  );
  item = (await redemptionCatalogue(readonly(db), f.p)).items[0];
  assert.equal(item.usedToday, 0);
  assert.equal(item.pointsUsedToday, "0");
  assert.equal(item.canRedeem, true);
});

test("P0 platform selector rejects foreign platform and isolates catalogue and user balances", async () => {
  const f = await fixture(),
    other = await fixture();
  await tier(f);
  await fund(f, "100");
  await assert.rejects(
    miniPlatforms(readonly(db), f.p, other.platform.id),
    /not_found/,
  );
  assert.equal(
    (await redemptionCatalogue(readonly(db), f.p, other.platform.id)).items
      .length,
    0,
  );
  assert.equal(
    (await redemptionCatalogue(readonly(db), other.p)).items.length,
    0,
  );
  const scope = await miniPlatforms(readonly(db), f.p);
  assert.deepEqual(
    scope.platforms.map((x) => x.id),
    [f.platform.id],
  );
});

test("P0 action ordering never offers bind without platform, and does not rebind rejected/conflicting users", () => {
  const base = {
    platformId: null,
    orders: [],
    tiers: [],
    identity: "unbound",
    member: { canCheckin: false },
    referral: { rewardEligible: false, rewardedToday: "0" },
  };
  assert.equal(miniPrimaryAction(base).kind, "view_records");
  assert.equal(
    miniPrimaryAction({
      ...base,
      platformId: "p",
      tiers: [{ id: "r", canRedeem: true }],
    }).kind,
    "redeem",
  );
  assert.equal(
    miniPrimaryAction({
      ...base,
      platformId: "p",
      identity: "pending",
      member: { canCheckin: true },
    }).kind,
    "view_identity",
  );
  assert.equal(
    miniPrimaryAction({ ...base, platformId: "p", identity: "conflict" }).kind,
    "view_records",
  );
  assert.equal(
    miniPrimaryAction({
      ...base,
      platformId: "p",
      identity: "verified",
      member: { canCheckin: true },
    }).kind,
    "checkin",
  );
  assert.equal(
    miniPrimaryAction({
      ...base,
      platformId: "p",
      identity: "verified",
      referral: { rewardEligible: true, rewardedToday: "5" },
    }).kind,
    "view_records",
  );
});

test("P0 referral six qualified versus five rewarded; latest revocation is review, per-platform and gates remain separate", async () => {
  const f = await fixture();
  const rule = await createReferralRule(
    db,
    f.adminP,
    f.p.brandId,
    {
      platformId: f.platform.id,
      campaignKey: "P0",
      effectiveFrom: "2020-01-01",
      inviteeEnabled: true,
    },
    "p0",
  );
  await changeReferralRule(db, f.adminP, f.p.brandId, rule.id, "publish", "p0");
  const users: string[] = [],
    identities: string[] = [];
  for (let i = 0; i < 6; i++) {
    const u = await one(
      db,
      "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,$3) RETURNING id",
      [f.p.brandId, f.p.botId, ++tid],
    );
    users.push(u.id);
    await db.query(
      "INSERT INTO referrals(brand_id,bot_id,inviter_id,invitee_id,start_parameter) VALUES($1,$2,$3,$4,'p0')",
      [f.p.brandId, f.p.botId, f.p.userId, u.id],
    );
    const pi = await one(
      db,
      "INSERT INTO platform_identities(brand_id,bot_id,user_id,telegram_user_id,platform_id,platform_uid,verification_method,submission_key) SELECT brand_id,bot_id,id,telegram_user_id,$2,$3,'manual_admin',$4 FROM telegram_users WHERE id=$1 RETURNING id",
      [u.id, f.platform.id, "P0UID" + i, randomUUID()],
    );
    await db.query(
      "UPDATE platform_identities SET status='verified',verified_at=now(),verified_by=$2,evidence_reference='CASE-P0' WHERE id=$1",
      [pi.id, f.adminP.adminId],
    );
    identities.push(pi.id);
  }
  process.env.BATCH2A_REFERRAL_REWARDS_ENABLED = "true";
  process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON = JSON.stringify([
    {
      brandId: f.p.brandId,
      botId: f.p.botId,
      platformId: f.platform.id,
      userIds: [f.p.userId, ...users],
    },
  ]);
  try {
    for (const id of identities)
      await db.transaction((tx) => evaluateReferralByIdentityTx(tx, id, "p0"));
    let s = await miniReferralSummary(
      readonly(db),
      f.p,
      f.platform,
      "https://t.me/p0_bot?start=ref_p0",
    );
    assert.equal(s.qualifiedToday, "6");
    assert.equal(s.rewardedToday, "5");
    assert.equal(s.pointsEarned, "250");
    assert.equal(s.capExceededCount, "1");
    assert.equal(s.activity!.inviteeEnabled, true);
    assert.equal(s.rewardEligible, true);
    await db.query(
      "UPDATE platform_identities SET status='revoked',revoked_at=now(),revoked_by=$2,reason_code='user_request' WHERE id=$1",
      [identities[0], f.adminP.adminId],
    );
    const records = (
      await db.query(referralRecordSql, [
        f.p.brandId,
        f.p.botId,
        f.p.userId,
        f.platform.id,
      ])
    ).rows;
    assert.equal(
      records.filter((x) => x.displayStatus === "review_required").length,
      1,
    );
    assert.equal(
      records.filter((x) => x.displayStatus === "rewarded").length,
      4,
    );
    process.env.BATCH2A_REFERRAL_REWARDS_ENABLED = "false";
    s = await miniReferralSummary(
      readonly(db),
      f.p,
      f.platform,
      "https://t.me/p0_bot?start=ref_p0",
    );
    assert.equal(s.rewardEligible, false);
    assert.equal(s.rewardAvailability, "disabled");
    assert.ok(s.shareUrl);
    assert.equal(s.rewardedToday, "5");
    process.env.BATCH2A_REFERRAL_REWARDS_ENABLED = "true";
    process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON = "[]";
    assert.equal(
      (await miniReferralSummary(readonly(db), f.p, f.platform, null))
        .rewardAvailability,
      "out_of_scope",
    );
    const p2 = await one(
      db,
      "INSERT INTO platforms(brand_id,code,display_name,market,timezone,currency,verification_method) VALUES($1,'P2','P2','MX','America/Mexico_City','MXN','manual_admin') RETURNING id,timezone,(now() AT TIME ZONE timezone)::date::text AS \"businessDate\"",
      [f.p.brandId],
    );
    const other = await miniReferralSummary(readonly(db), f.p, p2, null);
    assert.equal(other.rewardedToday, "0");
    assert.equal(other.qualifiedToday, "0");
    assert.equal(other.pointsEarned, "0");
  } finally {
    process.env.BATCH2A_REFERRAL_REWARDS_ENABLED = "false";
    delete process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON;
  }
});

test("P0 daily redemption limit is shared across Bots for one Member while Points stay Bot-scoped", async () => {
  const f = await fixture();
  const first = await tier(f);
  await fund(f, "100");
  await createFixedRedemption(db, f.p, first.id, randomUUID(), "p0");
  const secondBot = await one(
    db,
    "INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status) VALUES($1,'P0 other Bot',$2,$2,$2,'en',ARRAY['en'],'active') RETURNING id",
    [f.p.brandId, "P0_" + randomUUID().replaceAll("-", "")],
  );
  const secondUser = await one(
    db,
    "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) SELECT brand_id,$2,telegram_user_id FROM telegram_users WHERE id=$1 RETURNING id,telegram_user_id",
    [f.p.userId, secondBot.id],
  );
  await db.query(
    "INSERT INTO member_user_links(brand_id,bot_id,user_id,member_id,telegram_user_id) VALUES($1,$2,$3,$4,$5)",
    [
      f.p.brandId,
      secondBot.id,
      secondUser.id,
      f.member!.id,
      secondUser.telegram_user_id,
    ],
  );
  const second = {
    ...f,
    p: { ...f.p, botId: secondBot.id, userId: secondUser.id },
  };
  await tier(second);
  await fund(second, "200");
  const item = (
    await redemptionCatalogue(readonly(db), second.p, second.platform.id)
  ).items[0];
  assert.equal(item.balance, "200");
  assert.equal(item.usedToday, 1);
  assert.equal(item.pointsUsedToday, "100");
  assert.equal(item.unavailableReason, "daily_redemption_limit");
  const secondCounter = await miniReferralSummary(
    readonly(db),
    second.p,
    second.platform,
    null,
  );
  assert.equal(secondCounter.rewardedToday, "0");
});

test("P0 uninitialized inviter is not reward eligible even with valid activity and allowlist; read never initializes", async () => {
  const f = await fixture(false),
    allowedPeer = randomUUID();
  const rule = await createReferralRule(
    db,
    f.adminP,
    f.p.brandId,
    {
      platformId: f.platform.id,
      campaignKey: "P0-new",
      effectiveFrom: "2020-01-01",
      inviteeEnabled: true,
    },
    "p0",
  );
  await changeReferralRule(db, f.adminP, f.p.brandId, rule.id, "publish", "p0");
  process.env.BATCH2A_REFERRAL_REWARDS_ENABLED = "true";
  process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON = JSON.stringify([
    {
      brandId: f.p.brandId,
      botId: f.p.botId,
      platformId: f.platform.id,
      userIds: [f.p.userId, allowedPeer],
    },
  ]);
  try {
    const share = "https://t.me/p0_bot?start=ref_p0";
    const summary = await miniReferralSummary(
      readonly(db),
      f.p,
      f.platform,
      share,
    );
    assert.equal(summary.rewardEligible, false);
    assert.equal(summary.rewardAvailability, "member_required");
    assert.equal(summary.shareUrl, share);
    assert.equal((await miniMemberSummary(readonly(db), f.p)).canCheckin, true);
    assert.equal(
      (
        await one(
          db,
          "SELECT count(*)::int n FROM member_user_links WHERE brand_id=$1",
          [f.p.brandId],
        )
      ).n,
      0,
    );
    assert.equal(
      (
        await one(
          db,
          "SELECT count(*)::int n FROM point_ledger WHERE brand_id=$1",
          [f.p.brandId],
        )
      ).n,
      0,
    );
    await checkinGrowth(db, f.p, "p0-explicit-init");
    assert.equal(
      (await miniReferralSummary(readonly(db), f.p, f.platform, share))
        .rewardEligible,
      true,
    );
  } finally {
    process.env.BATCH2A_REFERRAL_REWARDS_ENABLED = "false";
    delete process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON;
  }
});
