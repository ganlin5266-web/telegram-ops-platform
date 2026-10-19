import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/migrations.js";
import { one, type Database, type Queryable } from "../src/db.js";
import { postPoints } from "../src/points.js";
import { createRedemptionCodeVault } from "../src/redemption-vault.js";
import {
  createRedemptionRule,
  changeRedemptionRule,
  importCodeBatch,
} from "../src/redemption-v2.js";
import {
  claimRedemptionCode,
  createFixedRedemption,
  listAdminRedemptions,
  recoverRedemptionCode,
  reviewRedemption,
} from "../src/redemption-flow.js";

let db: Database, close: () => Promise<void>;
const vault = createRedemptionCodeVault({
  REDEMPTION_CODE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  REDEMPTION_CODE_FINGERPRINT_KEY: randomBytes(32).toString("base64"),
  REDEMPTION_CODE_KEY_VERSION: "b2c-test",
})!;
const adapt = (client: any): Queryable => ({
  query: async (sql, params) =>
    params === undefined
      ? ((await client.exec(sql)).at(-1) ?? { rows: [] })
      : client.query(sql, params),
});
before(async () => {
  const pg = new PGlite();
  db = {
    ...adapt(pg),
    transaction: (fn) => pg.transaction((tx) => fn(adapt(tx))),
  };
  close = () => pg.close();
  await migrate(db);
});
after(async () => close());

let telegramId = 800000;
async function fixture(options: { codes?: string[]; points?: number } = {}) {
  const brand = await one(
    db,
    "INSERT INTO brands(name,slug,default_language) VALUES('B2C',$1,'en') RETURNING id",
    [randomUUID()],
  );
  const bot = await one(
    db,
    `INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status)
  VALUES($1,'B2C',$2,$3,$4,'en',ARRAY['en'],'active') RETURNING id`,
    [brand.id, randomUUID(), randomUUID(), randomUUID()],
  );
  const platform = await one(
    db,
    `INSERT INTO platforms(brand_id,code,display_name,market,timezone,currency,verification_method,redemption_url)
  VALUES($1,$2,'FUN66','BR','America/Sao_Paulo','BRL','manual_admin','https://example.test/redeem') RETURNING id`,
    [
      brand.id,
      `P${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    ],
  );
  const user = await one(
    db,
    `INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id,status)
  VALUES($1,$2,$3,'active') RETURNING id,telegram_user_id`,
    [brand.id, bot.id, ++telegramId],
  );
  const admin = await one(
    db,
    "INSERT INTO admins(auth_subject,display_name) VALUES($1,'B2C') RETURNING id",
    [randomUUID()],
  );
  await db.query(
    `INSERT INTO admin_roles(admin_id,role_id) SELECT $1,id FROM roles WHERE name='Super Admin'`,
    [admin.id],
  );
  const level = await one(
    db,
    `INSERT INTO member_rule_versions(brand_id,kind,version,status,effective_from,effective_until,config,created_by)
  VALUES($1,'level',1,'draft','2020-01-01','2099-12-31',$2,$3) RETURNING id`,
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
    `INSERT INTO members(brand_id,telegram_user_id,level,level_rule_id) VALUES($1,$2,1,$3) RETURNING id`,
    [brand.id, user.telegram_user_id, level.id],
  );
  await db.query(
    `INSERT INTO member_user_links(brand_id,bot_id,user_id,member_id,telegram_user_id) VALUES($1,$2,$3,$4,$5)`,
    [brand.id, bot.id, user.id, member.id, user.telegram_user_id],
  );
  const principal = { adminId: admin.id },
    scope = { brandId: brand.id, botId: bot.id };
  const draft = await createRedemptionRule(
    db,
    principal,
    scope,
    {
      platformId: platform.id,
      tierKey: "brl_10",
      name: "BRL 10",
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
  if (options.codes?.length)
    await importCodeBatch(
      db,
      vault,
      principal,
      scope,
      {
        ruleId: draft.id,
        codes: options.codes.map((code) => ({ code, expiresAt: null })),
      },
      randomUUID(),
    );
  if (options.points)
    await db.transaction((tx) =>
      postPoints(tx, {
        ...scope,
        userId: user.id,
        delta: String(options.points),
        source: "test",
        businessType: "test_credit",
        businessId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    );
  const mini = {
    ...scope,
    userId: user.id,
    sessionId: randomUUID(),
    appKey: "test",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  return {
    brand,
    bot,
    platform,
    user,
    admin,
    member,
    principal,
    scope,
    ruleId: draft.id,
    mini,
  };
}

test("atomic create, claim and recovery debit once and return the same encrypted inventory code", async () => {
  const f = await fixture({ codes: ["SAFE-CODE-ONE"], points: 300 }),
    key = randomUUID();
  const [a, b] = await Promise.all([
    createFixedRedemption(db, f.mini, f.ruleId, key, "r1"),
    createFixedRedemption(db, f.mini, f.ruleId, key, "r2"),
  ]);
  assert.equal(a.id, b.id);
  const claimed = await claimRedemptionCode(db, vault, f.mini, a.id);
  assert.equal(claimed.code, "SAFE-CODE-ONE");
  assert.equal(claimed.status, "code_claimed");
  assert.equal(
    (await recoverRedemptionCode(db, vault, f.mini, a.id)).code,
    "SAFE-CODE-ONE",
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT balance::text FROM point_accounts WHERE user_id=$1",
        [f.user.id],
      )
    ).balance,
    "200",
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int n FROM point_ledger WHERE business_type='redemption_debit' AND business_id=$1",
        [a.id],
      )
    ).n,
    1,
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int n FROM redemption_codes WHERE redemption_id=$1 AND status='used'",
        [a.id],
      )
    ).n,
    1,
  );
});

test("inventory and insufficient-points failures roll back order, code and all accounting writes", async () => {
  const noStock = await fixture({ points: 200 });
  await assert.rejects(
    () =>
      createFixedRedemption(
        db,
        noStock.mini,
        noStock.ruleId,
        randomUUID(),
        "x",
      ),
    /inventory_empty/,
  );
  assert.equal(
    (
      await one(db, "SELECT count(*)::int n FROM redemptions WHERE bot_id=$1", [
        noStock.bot.id,
      ])
    ).n,
    0,
  );
  const poor = await fixture({ codes: ["SAFE-CODE-POOR"], points: 50 });
  await assert.rejects(
    () => createFixedRedemption(db, poor.mini, poor.ruleId, randomUUID(), "x"),
    /insufficient_points/,
  );
  assert.equal(
    (
      await one(db, "SELECT count(*)::int n FROM redemptions WHERE bot_id=$1", [
        poor.bot.id,
      ])
    ).n,
    0,
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int n FROM redemption_codes WHERE bot_id=$1 AND status='available'",
        [poor.bot.id],
      )
    ).n,
    1,
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT balance::text FROM point_accounts WHERE user_id=$1",
        [poor.user.id],
      )
    ).balance,
    "50",
  );
});

test("daily slot is permanent across Bots for one member and one platform", async () => {
  const f = await fixture({ codes: ["SAFE-CODE-A"], points: 300 });
  await createFixedRedemption(db, f.mini, f.ruleId, randomUUID(), "first");
  const bot = await one(
    db,
    `INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status)
  VALUES($1,'Sibling',$2,$3,$4,'en',ARRAY['en'],'active') RETURNING id`,
    [f.brand.id, randomUUID(), randomUUID(), randomUUID()],
  );
  const user = await one(
    db,
    `INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id,status) VALUES($1,$2,$3,'active') RETURNING id`,
    [f.brand.id, bot.id, f.user.telegram_user_id],
  );
  await db.query(
    `INSERT INTO member_user_links(brand_id,bot_id,user_id,member_id,telegram_user_id) VALUES($1,$2,$3,$4,$5)`,
    [f.brand.id, bot.id, user.id, f.member.id, f.user.telegram_user_id],
  );
  const scope = { brandId: f.brand.id, botId: bot.id };
  const draft = await createRedemptionRule(
    db,
    f.principal,
    scope,
    {
      platformId: f.platform.id,
      tierKey: "other_bot",
      name: "Other",
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
    f.principal,
    scope,
    draft.id,
    "publish",
    randomUUID(),
  );
  await importCodeBatch(
    db,
    vault,
    f.principal,
    scope,
    { ruleId: draft.id, codes: [{ code: "SAFE-CODE-B", expiresAt: null }] },
    randomUUID(),
  );
  await db.transaction((tx) =>
    postPoints(tx, {
      ...scope,
      userId: user.id,
      delta: "200",
      source: "test",
      businessType: "test_credit",
      businessId: randomUUID(),
      idempotencyKey: randomUUID(),
    }),
  );
  const mini = { ...f.mini, ...scope, userId: user.id };
  await assert.rejects(
    () => createFixedRedemption(db, mini, draft.id, randomUUID(), "second"),
    /daily_redemption_limit/,
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT balance::text FROM point_accounts WHERE user_id=$1",
        [user.id],
      )
    ).balance,
    "200",
  );
});

test("manual review never refunds platform rejection; confirmed internal refund restores the daily slot", async () => {
  const f = await fixture({
    codes: ["SAFE-CODE-R1", "SAFE-CODE-R2"],
    points: 300,
  });
  const order = await createFixedRedemption(
    db,
    f.mini,
    f.ruleId,
    randomUUID(),
    "create",
  );
  await claimRedemptionCode(db, vault, f.mini, order.id);
  await reviewRedemption(
    db,
    f.principal,
    f.scope,
    order.id,
    "mark_review",
    "platform_rejected",
    "review",
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT balance::text FROM point_accounts WHERE user_id=$1",
        [f.user.id],
      )
    ).balance,
    "200",
  );
  await assert.rejects(
    () =>
      reviewRedemption(
        db,
        f.principal,
        f.scope,
        order.id,
        "refund",
        "platform_rejected",
        "bad",
      ),
    /refund_not_confirmed/,
  );
  await reviewRedemption(
    db,
    f.principal,
    f.scope,
    order.id,
    "refund",
    "confirmed_internal_failure",
    "refund",
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT balance::text FROM point_accounts WHERE user_id=$1",
        [f.user.id],
      )
    ).balance,
    "300",
  );
  const next = await createFixedRedemption(
    db,
    f.mini,
    f.ruleId,
    randomUUID(),
    "replacement",
  );
  assert.equal(next.status, "code_assigned");
});

test("admin list and audits never expose plaintext code", async () => {
  const f = await fixture({ codes: ["NEVER-EXPOSE-THIS"], points: 200 });
  const order = await createFixedRedemption(
    db,
    f.mini,
    f.ruleId,
    randomUUID(),
    "create",
  );
  const list = await listAdminRedemptions(db, f.principal, f.scope);
  assert.equal(list.items[0]!.id, order.id);
  assert.ok(!JSON.stringify(list).includes("NEVER-EXPOSE-THIS"));
  assert.ok(
    !JSON.stringify(
      (
        await db.query("SELECT * FROM audit_logs WHERE object_id=$1", [
          order.id,
        ])
      ).rows,
    ).includes("NEVER-EXPOSE-THIS"),
  );
});
