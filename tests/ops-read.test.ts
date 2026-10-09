import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  DomainError,
  one,
  postgres,
  type Database,
  type Queryable,
} from "../src/db.js";
import { migrate } from "../src/migrations.js";
import { createApp } from "../src/app.js";
import {
  createPlatform,
  reviewIdentity,
  submitIdentity,
} from "../src/platform-identities.js";
import { activateImport, preflightImport } from "../src/platform-data.js";
import { fields } from "../src/platform-data-input.js";
import {
  pendingSummary,
  performanceRange,
  platformDataStatus,
  privatePerformance,
} from "../src/ops-read.js";

let db: Database,
  close: () => Promise<void>;
const adapt = (p: any): Queryable => ({
  query: async (sql, parameters) =>
    parameters === undefined
      ? ((await p.exec(sql)).at(-1) ?? { rows: [] })
      : p.query(sql, parameters),
});
before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    const database = postgres(process.env.TEST_DATABASE_URL);
    db = database;
    close = database.close;
  } else {
    const database = new PGlite();
    db = {
      ...adapt(database),
      transaction: (fn) => database.transaction((tx) => fn(adapt(tx))),
    };
    close = () => database.close();
  }
  await migrate(db);
});
after(async () => close());

function sourceRow(uid: string, extra: Record<string, string> = {}) {
  return {
    uid,
    tier: "synthetic",
    login_account: "fake",
    registered_at: "2026-09-20T10:00:00-03:00",
    login_time: "2026-09-25T23:50:00-03:00",
    channel: "STAGING SYNTHETIC",
    agent: "test",
    deposit: "100.00",
    deposit_count: "2",
    gift: "25.00",
    withdrawal: "30.00",
    source_net: "999.00",
    bet: "250",
    payout: "230",
    game_profit: "-20",
    first_deposit_date: "2026-09-20",
    first_deposit: "50",
    ...extra,
  };
}

async function fixture(options: { currency?: string; day?: string; completeness?: "complete" | "incomplete" | "unknown" } = {}) {
  const currency = options.currency ?? "BRL",
    day = options.day ?? "2026-09-26",
    brand = await one(
      db,
      "INSERT INTO brands(name,slug,default_language) VALUES('Ops Test',$1,'en') RETURNING id",
      [randomUUID()],
    ),
    bot = await one(
      db,
      "INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status) VALUES($1,'Ops Bot',$2,$3,$4,'en',ARRAY['en'],'disabled') RETURNING id",
      [brand.id, randomUUID(), "OPS_" + randomUUID(), "OPS_" + randomUUID()],
    ),
    admin = await one(
      db,
      "INSERT INTO admins(auth_subject,display_name) VALUES($1,'Ops Reviewer') RETURNING id",
      [randomUUID()],
    );
  await db.query(
    "INSERT INTO admin_roles(admin_id,role_id) SELECT $1,id FROM roles WHERE name='Super Admin'",
    [admin.id],
  );
  const s = { brandId: brand.id, botId: bot.id },
    p = { adminId: admin.id },
    platform = await createPlatform(
      db,
      p,
      s,
      {
        code: "OPS_" + randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase(),
        displayName: "Ops Synthetic",
        market: "BR",
        timezone: "America/Sao_Paulo",
        currency,
        verificationMethod: "manual_admin",
        uidFormat: "alphanumeric",
        uidCase: "upper",
        uidMinLength: 1,
        uidMaxLength: 64,
      },
      "ops-test",
    );
  const levelRule = await one(
    db,
    `INSERT INTO member_rule_versions(brand_id,kind,version,status,effective_from,effective_until,config,created_by)
     VALUES($1,'level',1,'draft','2026-01-01','2026-12-31',$2,$3) RETURNING id`,
    [brand.id, JSON.stringify({ levels: [{ key: "level_1", name: "Starter", threshold: 0 }], grandfather: true }), admin.id],
  );
  await db.query(
    "UPDATE member_rule_versions SET status='published',published_at=now(),published_by=$2 WHERE id=$1",
    [levelRule.id, admin.id],
  );
  async function linkedUser(telegramId: number, uid: string) {
    const user = await one(
        db,
        "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,$3) RETURNING id",
        [brand.id, bot.id, telegramId],
      ),
      identity = await submitIdentity(
        db,
        {
          ...s,
          userId: user.id,
          sessionId: randomUUID(),
          appKey: "test",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        platform.id,
        uid,
        randomUUID(),
        "ops-test",
      );
    await reviewIdentity(
      db,
      p,
      s,
      identity.id,
      { action: "verify", evidenceReference: "CASE-OPS-SYNTHETIC" },
      "ops-test",
    );
    const member = await one(
      db,
      "INSERT INTO members(brand_id,telegram_user_id,level_rule_id) VALUES($1,$2,$3) RETURNING id",
      [brand.id, telegramId, levelRule.id],
    );
    await db.query(
      "INSERT INTO member_user_links(brand_id,bot_id,user_id,member_id,telegram_user_id) VALUES($1,$2,$3,$4,$5)",
      [brand.id, bot.id, user.id, member.id, telegramId],
    );
    await db.query(
      "INSERT INTO growth_accounts(brand_id,member_id) VALUES($1,$2)",
      [brand.id, member.id],
    );
    return { user, identity, member };
  }
  async function activate(
    rows: Record<string, string>[],
    over: Record<string, unknown> = {},
    target: Record<string, any> = platform,
  ) {
    const input = {
      platformId: target.id,
      businessDate: day,
      timezone: target.timezone,
      currency: target.currency,
      sourceType: "csv",
      filename: `OPS-${randomUUID()}.csv`,
      fileBase64: Buffer.from(
        [fields.join(","), ...rows.map((row) => fields.map((field) => row[field] ?? "").join(","))].join("\n"),
      ).toString("base64"),
      mapping: Object.fromEntries(fields.map((field) => [field, field])),
      coverage: { kind: "full", filter: "" },
      completeness: options.completeness ?? "complete",
      replacement: false,
      reason: "OPS SYNTHETIC",
      ...over,
    };
    const batch = await preflightImport(db, p, s, input, "ops-test");
    await activateImport(
      db,
      p,
      s,
      batch.id,
      input.replacement === true,
      "ops-test",
    );
    return batch.id;
  }
  return { brand, bot, admin, s, p, platform, levelRule, linkedUser, activate, day };
}

test("Batch 1 calendar periods use business-date arithmetic", () => {
  assert.deepEqual(performanceRange("2026-09-27", "day"), { from: "2026-09-27", to: "2026-09-27" });
  assert.deepEqual(performanceRange("2026-09-27", "week"), { from: "2026-09-21", to: "2026-09-27" });
  assert.deepEqual(performanceRange("2026-02-15", "month"), { from: "2026-02-01", to: "2026-02-28" });
});

test("private performance is exact and keeps the first verified attribution through revoke and fact revision", async () => {
  const f = await fixture(),
    first = await f.linkedUser(810001, "BR-OPS-1"),
    second = await f.linkedUser(810002, "BR-OPS-2");
  await f.activate([
    sourceRow("BR-OPS-1", { deposit: "100.123456", withdrawal: "30.000001", source_net: "999", gift: "500", first_deposit: "700" }),
    sourceRow("BR-OPS-2", { deposit: "0", deposit_count: "0", withdrawal: "5" }),
  ]);
  await reviewIdentity(
    db,
    f.p,
    f.s,
    first.identity.id,
    { action: "revoke", reasonCode: "user_request" },
    "ops-test",
  );
  await f.activate(
    [
      sourceRow("BR-OPS-1", { deposit: "120.123456", withdrawal: "30.000001", source_net: "999", gift: "500", first_deposit: "700" }),
      sourceRow("BR-OPS-2", { deposit: "0", deposit_count: "0", withdrawal: "5" }),
    ],
    { replacement: true },
  );
  const result = await privatePerformance(db, f.s, { period: "day", date: f.day }, new Date("2026-09-28T12:00:00Z"));
  assert.equal(result.platforms[0]!.depositors.value, 1);
  assert.equal(result.platforms[0]!.depositAmount.value, "120.123456");
  assert.equal(result.platforms[0]!.netDeposit.value, "85.123455");
  assert.equal(result.total!.depositors.value, 1);
  assert.equal(second.member.id !== first.member.id, true);
});

test("deposit_count contradiction and missing withdrawal fail closed", async () => {
  const f = await fixture();
  await f.linkedUser(820001, "BR-OPS-3");
  await f.activate([sourceRow("BR-OPS-3", { deposit: "0", deposit_count: "1", withdrawal: "" })]);
  const result = await privatePerformance(db, f.s, { period: "day", date: f.day }, new Date("2026-09-28T12:00:00Z")),
    row = result.platforms[0]!;
  assert.deepEqual([row.depositors.status, row.depositAmount.status, row.netDeposit.status], ["data_incomplete", "data_incomplete", "data_incomplete"]);
  assert.deepEqual([row.depositors.value, row.depositAmount.value, row.netDeposit.value], [null, null, null]);
});

test("a canonically unavailable withdrawal is not reported as zero or incomplete money", async () => {
  const f = await fixture();
  await f.linkedUser(820101, "BR-OPS-NET");
  await f.activate(
    [sourceRow("BR-OPS-NET", { deposit: "10", withdrawal: "" })],
    { mapping: { uid: "uid", deposit: "deposit" } },
  );
  const result = await privatePerformance(
      db,
      f.s,
      { period: "day", date: f.day },
      new Date("2026-09-28T12:00:00Z"),
    ),
    row = result.platforms[0]!;
  assert.equal(row.depositAmount.value, "10.000000");
  assert.deepEqual(
    [row.netDeposit.status, row.netDeposit.value, result.total!.netDeposit.status],
    ["not_applicable", null, "not_applicable"],
  );
});

test("unknown completeness and open period never expose partial values", async () => {
  const unknown = await fixture({ completeness: "unknown" });
  await unknown.linkedUser(830001, "BR-OPS-4");
  await unknown.activate([sourceRow("BR-OPS-4")]);
  const incomplete = await privatePerformance(db, unknown.s, { period: "day", date: unknown.day }, new Date("2026-09-28T12:00:00Z"));
  assert.equal(incomplete.platforms[0]!.completeness, "unknown");
  assert.equal(incomplete.platforms[0]!.depositAmount.reason, "completeness_unknown");
  assert.equal(incomplete.platforms[0]!.depositAmount.value, null);

  const open = await fixture({ day: "2026-09-28" });
  await open.linkedUser(830002, "BR-OPS-5");
  await open.activate([sourceRow("BR-OPS-5")]);
  const result = await privatePerformance(db, open.s, { period: "day", date: open.day }, new Date("2026-09-28T12:00:00Z"));
  assert.equal(result.platforms[0]!.depositAmount.reason, "period_open");
  assert.equal(result.platforms[0]!.depositAmount.value, null);
});

test("different currencies keep depositor total but do not aggregate money", async () => {
  const f = await fixture(),
    usd = await createPlatform(
      db,
      f.p,
      f.s,
      {
        code: "USD_" + randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase(),
        displayName: "USD Synthetic",
        market: "US",
        timezone: "America/Sao_Paulo",
        currency: "USD",
        verificationMethod: "manual_admin",
        uidFormat: "alphanumeric",
        uidCase: "upper",
        uidMinLength: 1,
        uidMaxLength: 64,
      },
      "ops-test",
    );
  const linked = await f.linkedUser(840001, "BR-OPS-6"),
    usdIdentity = await submitIdentity(
      db,
      { ...f.s, userId: linked.user.id, sessionId: randomUUID(), appKey: "test", expiresAt: new Date(Date.now() + 60_000).toISOString() },
      usd.id,
      "US-OPS-6",
      randomUUID(),
      "ops-test",
    );
  await reviewIdentity(db, f.p, f.s, usdIdentity.id, { action: "verify", evidenceReference: "CASE-OPS-USD" }, "ops-test");
  await f.activate([sourceRow("BR-OPS-6")]);
  await f.activate([sourceRow("US-OPS-6", { deposit: "5", withdrawal: "1" })], {}, usd);
  const result = await privatePerformance(db, f.s, { period: "day", date: f.day }, new Date("2026-09-28T12:00:00Z"));
  assert.equal(result.platforms.some((row: any) => row.platformId === usd.id), true);
  assert.equal(result.total!.depositAmount.status, "not_applicable");
  assert.equal(result.total!.depositAmount.reason, "multiple_currencies");
  assert.equal(result.total!.depositAmount.value, null);
});

test("all-platform depositor total deduplicates one Member across platforms", async () => {
  const f = await fixture(),
    second = await createPlatform(
      db,
      f.p,
      f.s,
      {
        code: "BR2_" + randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase(),
        displayName: "Second BRL",
        market: "BR",
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        verificationMethod: "manual_admin",
        uidFormat: "alphanumeric",
        uidCase: "upper",
        uidMinLength: 1,
        uidMaxLength: 64,
      },
      "ops-test",
    ),
    linked = await f.linkedUser(840101, "BR-OPS-A"),
    identity = await submitIdentity(
      db,
      { ...f.s, userId: linked.user.id, sessionId: randomUUID(), appKey: "test", expiresAt: new Date(Date.now() + 60_000).toISOString() },
      second.id,
      "BR-OPS-B",
      randomUUID(),
      "ops-test",
    );
  await reviewIdentity(db, f.p, f.s, identity.id, { action: "verify", evidenceReference: "CASE-OPS-CROSS" }, "ops-test");
  await f.activate([sourceRow("BR-OPS-A", { deposit: "100", withdrawal: "10" })]);
  await f.activate([sourceRow("BR-OPS-B", { deposit: "50", withdrawal: "5" })], {}, second);
  const result = await privatePerformance(db, f.s, { period: "day", date: f.day }, new Date("2026-09-28T12:00:00Z"));
  assert.deepEqual(result.platforms.map((row: any) => row.depositors.value), [1, 1]);
  assert.equal(result.total!.depositors.value, 1);
  assert.equal(result.total!.depositAmount.value, "150.000000");
  assert.equal(result.total!.netDeposit.value, "135.000000");
});

test("platform status returns latest active date and preserves unknown", async () => {
  const f = await fixture({ completeness: "unknown" });
  await f.linkedUser(850001, "BR-OPS-7");
  await f.activate([sourceRow("BR-OPS-7")]);
  const result = await platformDataStatus(db, f.s),
    item = result.items.find((row: any) => row.platformId === f.platform.id);
  assert.equal(item!.latestBusinessDate, f.day);
  assert.equal(item!.completeness, "unknown");
  assert.equal(result.expectedBusinessDate.status, "backend_pending");
});

test("pending uses current revisions and reports categories independently", async () => {
  const f = await fixture(),
    linked = await f.linkedUser(860001, "BR-OPS-8");
  const pendingUser = await one(
    db,
    "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,$3) RETURNING id",
    [f.brand.id, f.bot.id, 860002],
  );
  const pendingIdentity = await submitIdentity(
    db,
    { ...f.s, userId: pendingUser.id, sessionId: randomUUID(), appKey: "test", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    f.platform.id,
    "BR-OPS-9",
    randomUUID(),
    "ops-test",
  );
  assert.ok(pendingIdentity.id);
  const historical = await one(
      db,
      `INSERT INTO growth_sources(brand_id,member_id,source_type,source_key,business_date,occurred_at,policy_id)
       VALUES($1,$2,'member_task','ops-history','2026-09-26',now(),$3) RETURNING id`,
      [f.brand.id, linked.member.id, f.levelRule.id],
    ),
    oldReview = await one(
      db,
      `INSERT INTO growth_evaluation_revisions(brand_id,member_id,source_id,rule_version_id,input_fingerprint,status,reason_code,requested_growth,evidence)
       VALUES($1,$2,$3,$4,$5,'review_required','synthetic_review',0,'{}') RETURNING id`,
      [f.brand.id, linked.member.id, historical.id, f.levelRule.id, "1".repeat(64)],
    );
  await db.query("UPDATE growth_sources SET current_evaluation_id=$2 WHERE id=$1", [historical.id, oldReview.id]);
  const resolved = await one(
    db,
    `INSERT INTO growth_evaluation_revisions(brand_id,member_id,source_id,rule_version_id,input_fingerprint,status,reason_code,requested_growth,evidence)
     VALUES($1,$2,$3,$4,$5,'eligible','resolved',10,'{}') RETURNING id`,
    [f.brand.id, linked.member.id, historical.id, f.levelRule.id, "2".repeat(64)],
  );
  await db.query("UPDATE growth_sources SET current_evaluation_id=$2 WHERE id=$1", [historical.id, resolved.id]);
  const result = await pendingSummary(db, f.p, f.s);
  assert.equal(result.identityReview.status, "ok");
  assert.equal(result.identityReview.value, 1);
  assert.equal(result.identityConflict.value, 0);
  assert.equal(result.growthReview.value, 0);
  assert.equal(result.lowInventory.status, "backend_pending");
  assert.equal(result.lowInventory.value, null);
});

test("routes require Brand-wide P4 permission and expose no sensitive UID", async () => {
  const f = await fixture(),
    viewer = await one(
      db,
      "INSERT INTO admins(auth_subject,display_name) VALUES($1,'Bot Viewer') RETURNING id",
      [randomUUID()],
    ),
    role = await one(db, "INSERT INTO roles(name) VALUES($1) RETURNING id", ["Ops " + randomUUID()]);
  await db.query(
    "INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE name IN ('dashboard.read','platform_data.read','platform_identities.read')",
    [role.id],
  );
  await db.query(
    "INSERT INTO admin_roles(admin_id,role_id,brand_id,bot_id) VALUES($1,$2,$3,$4)",
    [viewer.id, role.id, f.brand.id, f.bot.id],
  );
  const app = createApp(db, () => undefined, async () => ({ adminId: viewer.id }));
  const base = `/v1/brands/${f.brand.id}/bots/${f.bot.id}/ops`;
  assert.equal((await app.inject({ method: "GET", url: base + "/platform-data-status" })).statusCode, 403);
  const pending = await app.inject({ method: "GET", url: base + "/pending" });
  assert.equal(pending.statusCode, 200);
  assert.equal(pending.json().identityReview.status, "ok");
  assert.equal(pending.json().platformDataReview.status, "forbidden");
  assert.equal(pending.json().qualificationReview.status, "forbidden");
  assert.equal(pending.json().growthReview.status, "forbidden");
  assert.doesNotMatch(pending.body, /BR-OPS|token|secret/i);
  await app.close();

  const superApp = createApp(db, () => undefined, async () => f.p);
  const status = await superApp.inject({ method: "GET", url: base + "/platform-data-status" });
  const performance = await superApp.inject({
    method: "GET",
    url: base + `/private-performance?period=day&date=${f.day}`,
  });
  assert.equal(status.statusCode, 200);
  assert.equal(performance.statusCode, 200);
  assert.equal(status.headers["cache-control"], "no-store");
  assert.equal(performance.headers["cache-control"], "no-store");
  await superApp.close();
});

test("cross Brand and Bot data never enters private performance", async () => {
  const first = await fixture(),
    other = await fixture();
  await first.linkedUser(870001, "BR-OPS-10");
  await first.activate([sourceRow("BR-OPS-10", { deposit: "10" })]);
  await other.linkedUser(870002, "BR-OPS-11");
  await other.activate([sourceRow("BR-OPS-11", { deposit: "900" })]);
  const result = await privatePerformance(db, first.s, { period: "day", date: first.day }, new Date("2026-09-28T12:00:00Z"));
  assert.equal(result.platforms[0]!.depositAmount.value, "10.000000");
  assert.equal(result.total!.depositAmount.value, "10.000000");
});

test("query failure is not converted to a real zero", async () => {
  const broken: Queryable = { query: async () => { throw new DomainError("query_failed", 500); } };
  await assert.rejects(() => platformDataStatus(broken, { brandId: randomUUID(), botId: randomUUID() }), /query_failed/);
});
