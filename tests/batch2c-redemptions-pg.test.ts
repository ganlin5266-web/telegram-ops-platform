import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { postgres, one, type Database } from "../src/db.js";
import { migrate } from "../src/migrations.js";
import { postPoints } from "../src/points.js";
import { createPolicy, publishPolicy } from "../src/point-lots.js";
import { cutoverBot } from "../src/point-lot-maintenance.js";
import { createRedemptionCodeVault } from "../src/redemption-vault.js";
import {
  createRedemptionRule,
  changeRedemptionRule,
  importCodeBatch,
} from "../src/redemption-v2.js";
import {
  claimRedemptionCode,
  createFixedRedemption,
  reviewRedemption,
} from "../src/redemption-flow.js";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
let db: Database & { close(): Promise<void> };
let admin: (Database & { close(): Promise<void> }) | undefined;
let testDatabase: string | undefined;
const vault = createRedemptionCodeVault({
  REDEMPTION_CODE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  REDEMPTION_CODE_FINGERPRINT_KEY: randomBytes(32).toString("base64"),
  REDEMPTION_CODE_KEY_VERSION: "b2c-pg",
})!;
before(async () => {
  if (!enabled) return;
  const url = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
  testDatabase = `batch2c_${randomUUID().replaceAll("-", "")}`;
  admin = postgres(url.toString()) as typeof db;
  await admin.query(`CREATE DATABASE ${testDatabase}`);
  url.pathname = `/${testDatabase}`;
  db = postgres(url.toString()) as typeof db;
  await migrate(db);
  process.env.POINT_LOTS_ENABLED = "true";
});
after(async () => {
  delete process.env.POINT_LOTS_ENABLED;
  if (!enabled) return;
  await db.close();
  await admin!.query(`DROP DATABASE ${testDatabase}`);
  await admin!.close();
});

async function fixture() {
  const brand = await one(
    db,
    "INSERT INTO brands(name,slug,default_language) VALUES('B2C PG',$1,'en') RETURNING id",
    [randomUUID()],
  );
  const bot = await one(
    db,
    `INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status) VALUES($1,'B2C PG',$2,$3,$4,'en',ARRAY['en'],'active') RETURNING id`,
    [brand.id, randomUUID(), randomUUID(), randomUUID()],
  );
  const user = await one(
    db,
    `INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id,status) VALUES($1,$2,700001,'active') RETURNING id,telegram_user_id`,
    [brand.id, bot.id],
  );
  const admin = await one(
    db,
    "INSERT INTO admins(auth_subject,display_name) VALUES($1,'B2C PG') RETURNING id",
    [randomUUID()],
  );
  await db.query(
    "INSERT INTO admin_roles(admin_id,role_id) SELECT $1,id FROM roles WHERE name='Super Admin'",
    [admin.id],
  );
  const level = await one(
    db,
    `INSERT INTO member_rule_versions(brand_id,kind,version,status,effective_from,effective_until,config,created_by) VALUES($1,'level',1,'draft','2020-01-01','2099-12-31',$2,$3) RETURNING id`,
    [
      brand.id,
      JSON.stringify({
        levels: [{ key: "level_1", name: "Starter", threshold: 0 }],
        grandfather: true,
      }),
      admin.id,
    ],
  );
  await db.query(
    "UPDATE member_rule_versions SET status='published',published_by=$2,published_at=now() WHERE id=$1",
    [level.id, admin.id],
  );
  const member = await one(
    db,
    "INSERT INTO members(brand_id,telegram_user_id,level,level_rule_id) VALUES($1,$2,1,$3) RETURNING id",
    [brand.id, user.telegram_user_id, level.id],
  );
  await db.query(
    "INSERT INTO member_user_links(brand_id,bot_id,user_id,member_id,telegram_user_id) VALUES($1,$2,$3,$4,$5)",
    [brand.id, bot.id, user.id, member.id, user.telegram_user_id],
  );
  const scope = { brandId: brand.id, botId: bot.id },
    principal = { adminId: admin.id };
  await db.transaction((tx) => cutoverBot(tx, scope));
  await db.transaction(async (tx) => {
    const p = await createPolicy(
      tx,
      scope,
      admin.id,
      {
        name: "B2C",
        source: "*",
        mode: "permanent",
        rollingDays: null,
        deadline: null,
        timezone: "UTC",
        refundMinCompensationDays: null,
        effectiveAt: new Date(Date.now() - 1000).toISOString(),
      },
      "policy",
    );
    await publishPolicy(tx, scope, admin.id, p.id, "policy");
  });
  await db.transaction((tx) =>
    postPoints(tx, {
      ...scope,
      userId: user.id,
      delta: "500",
      source: "test",
      businessType: "test_credit",
      businessId: randomUUID(),
      idempotencyKey: randomUUID(),
    }),
  );
  async function platformRule(code: string, tier: string) {
    const platform = await one(
      db,
      `INSERT INTO platforms(brand_id,code,display_name,market,timezone,currency,verification_method) VALUES($1,$2,$2,'BR','America/Sao_Paulo','BRL','manual_admin') RETURNING id`,
      [brand.id, code],
    );
    const draft = await createRedemptionRule(
      db,
      principal,
      scope,
      {
        platformId: platform.id,
        tierKey: tier,
        name: tier,
        pointsCost: 100,
        faceValue: "10",
        currency: "BRL",
        effectiveFrom: "2020-01-01",
        effectiveUntil: null,
      },
      randomUUID(),
    );
    await changeRedemptionRule(
      db,
      principal,
      scope,
      draft.id,
      "publish",
      randomUUID(),
    );
    await importCodeBatch(
      db,
      vault,
      principal,
      scope,
      {
        ruleId: draft.id,
        codes: [
          { code: `${tier}-A`, expiresAt: null },
          { code: `${tier}-B`, expiresAt: null },
        ],
      },
      randomUUID(),
    );
    return { platform, ruleId: draft.id };
  }
  const a = await platformRule("PGA", "tier_a"),
    b = await platformRule("PGB", "tier_b");
  const mini = {
    ...scope,
    userId: user.id,
    sessionId: randomUUID(),
    appKey: "test",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  return { brand, bot, user, admin, member, scope, principal, mini, a, b };
}

test(
  "PG17 serializes daily redemption, keeps platforms isolated and reconciles Ledger/Lots through refund",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const replayKey = randomUUID();
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        createFixedRedemption(
          db,
          f.mini,
          f.a.ruleId,
          replayKey,
          randomUUID(),
        ),
      ),
    );
    assert.equal(new Set(attempts.map((x) => x.id)).size, 1);
    const first = attempts[0]!;
    await assert.rejects(
      () =>
        createFixedRedemption(
          db,
          f.mini,
          f.a.ruleId,
          randomUUID(),
          randomUUID(),
        ),
      /daily_redemption_limit/,
    );
    assert.equal(
      (
        await one(
          db,
          "SELECT count(*)::int n FROM point_ledger WHERE business_type='redemption_debit' AND business_id=$1",
          [first.id],
        )
      ).n,
      1,
    );
    assert.equal(
      (
        await one(
          db,
          "SELECT count(*)::int n FROM redemption_codes WHERE redemption_id=$1",
          [first.id],
        )
      ).n,
      1,
    );
    const other = await createFixedRedemption(
      db,
      f.mini,
      f.b.ruleId,
      randomUUID(),
      "other-platform",
    );
    assert.equal(other.status, "code_assigned");
    await claimRedemptionCode(db, vault, f.mini, first.id);
    await reviewRedemption(
      db,
      f.principal,
      f.scope,
      first.id,
      "mark_review",
      "internal_failure_unknown",
      "review",
    );
    await reviewRedemption(
      db,
      f.principal,
      f.scope,
      first.id,
      "refund",
      "confirmed_internal_failure",
      "refund",
    );
    const accounting = await one(
      db,
      `SELECT a.balance::text,
  (SELECT coalesce(sum(delta),0)::text FROM point_ledger WHERE account_id=a.id) ledger,
  (SELECT coalesce(sum(remaining_amount),0)::text FROM point_lots WHERE account_id=a.id) lots
 FROM point_accounts a WHERE user_id=$1`,
      [f.user.id],
    );
    assert.deepEqual(accounting, {
      balance: "400",
      ledger: "400",
      lots: "400",
    });
    assert.equal(
      (
        await one(
          db,
          "SELECT count(*)::int n FROM point_lot_allocations a JOIN point_ledger l ON l.id=a.negative_ledger_id WHERE l.business_type='redemption_debit'",
          [],
        )
      ).n,
      2,
    );
  },
);
