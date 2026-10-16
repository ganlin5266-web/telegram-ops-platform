import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/migrations.js";
import { one, type Database, type Queryable } from "../src/db.js";
import {
  evaluateReferralByIdentityTx,
  evaluateReferralReward,
  referralRewardsEnabled,
} from "../src/referral-rewards.js";

let db: Database;
let close: () => Promise<void>;
let manualScope: { brandId: string; botId: string; adminId: string };

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
  const admin = await one(db, "INSERT INTO admins(auth_subject,display_name) VALUES($1,'B2A gate') RETURNING id", [randomUUID()]);
  await db.query("INSERT INTO admin_roles(admin_id,role_id,brand_id) SELECT $1,id,$2 FROM roles WHERE name='Super Admin'", [admin.id, brand.id]);
  manualScope = { brandId: brand.id, botId: bot.id, adminId: admin.id };
});

after(async () => {
  delete process.env.BATCH2A_REFERRAL_REWARDS_ENABLED;
  await close();
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
  const before = await one(db, "SELECT count(*)::int AS n FROM referral_reward_events");
  const result = await db.transaction((tx) => evaluateReferralByIdentityTx(tx, randomUUID(), randomUUID()));
  assert.equal(result.status, "disabled");
  process.env.BATCH2A_REFERRAL_REWARDS_ENABLED = "true";
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM referral_reward_events")).n, before.n);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM referral_qualification_evidence")).n, 0);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM referral_reward_daily_counters")).n, 0);
});

test("ten concurrent disabled entry points produce no writes", async () => {
  process.env.BATCH2A_REFERRAL_REWARDS_ENABLED = "false";
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      db.transaction((tx) => evaluateReferralByIdentityTx(tx, randomUUID(), randomUUID())),
    ),
  );
  assert.equal(results.every((r) => r.status === "disabled"), true);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM point_ledger")).n, 0);
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM point_lots")).n, 0);
});
