import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PGlite } from "@electric-sql/pglite";
import {
  postgres,
  one,
  DomainError,
  type Database,
  type Queryable,
  type Scope,
} from "../src/db.js";
import { migrate } from "../src/migrations.js";
import { createApp } from "../src/app.js";
import { dashboardSummary, dashboardTrends } from "../src/dashboard.js";
let db: Database,
  close: () => Promise<void>,
  app: ReturnType<typeof createApp>,
  a: Scope,
  a2: Scope,
  b: Scope,
  empty: Scope;
const identities: Record<string, string> = {};
const from = "2025-01-01T00:00:00Z",
  to = "2025-04-01T00:00:00Z";
const path = (s = a) => `/v1/brands/${s.brandId}/bots/${s.botId}`;
const url = (kind = "summary", start = from, end = to, s = a) =>
  `${path(s)}/dashboard/${kind}?${new URLSearchParams({ from: start, to: end })}`;
const get = (u = url(), role = "Admin") =>
  app.inject({ url: u, headers: { authorization: identities[role] ?? role } });
async function data(u = url(), role = "Admin") {
  const r = await get(u, role);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
before(
  async () => {
    if (process.env.TEST_DATABASE_URL) {
      const pg = postgres(process.env.TEST_DATABASE_URL);
      db = pg;
      close = pg.close;
    } else {
      const pg = new PGlite();
      const adapt = (p: any): Queryable => ({
        query: async (sql, args) =>
          args === undefined
            ? ((await p.exec(sql)).at(-1) ?? { rows: [] })
            : p.query(sql, args),
      });
      db = {
        ...adapt(pg),
        transaction: (fn) => pg.transaction((tx) => fn(adapt(tx))),
      };
      close = () => pg.close();
    }
    await migrate(db);
    await migrate(db);
    async function brand() {
      return (
        await one(
          db,
          "INSERT INTO brands(name,slug,default_language,timezone) VALUES('Dashboard test',$1,'en','UTC') RETURNING id",
          [randomUUID()],
        )
      ).id;
    }
    async function bot(brandId: string) {
      return {
        brandId,
        botId: (
          await one(
            db,
            "INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages) VALUES($1,'Dashboard',$2,$3,$4,'en',ARRAY['en']) RETURNING id",
            [brandId, randomUUID(), randomUUID(), randomUUID()],
          )
        ).id,
      };
    }
    a = await bot(await brand());
    a2 = await bot(a.brandId);
    b = await bot(await brand());
    empty = await bot(a.brandId);
    for (const role of [
      "Admin",
      "Viewer",
      "Operator",
      "Super Admin",
      "No permission",
    ]) {
      const id = (
        await one(
          db,
          "INSERT INTO admins(auth_subject,display_name) VALUES($1,'Dashboard tester') RETURNING id",
          [randomUUID()],
        )
      ).id;
      identities[role] = id;
      if (role !== "No permission")
        await db.query(
          "INSERT INTO admin_roles(admin_id,role_id,brand_id,bot_id) SELECT $1,id,$2,$3 FROM roles WHERE name=$4",
          [
            id,
            role === "Super Admin" ? null : a.brandId,
            role === "Super Admin" ? null : a.botId,
            role,
          ],
        );
    }
    app = createApp(
      db,
      () => undefined,
      async (id) => {
        if (!id) throw new DomainError("unauthorized", 401);
        return { adminId: id };
      },
    );
    for (const [s, size] of [
      [a, 10000],
      [a2, 3],
      [b, 5],
    ] as [Scope, number][]) {
      await db.query(
        `INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id,first_started_at,created_at) SELECT $1,$2,g,'2025-01-01'::timestamptz+((g-1)%90)*interval '1 day','2024-12-01' FROM generate_series(1,$3::int) g`,
        [s.brandId, s.botId, size],
      );
      await db.query(
        "INSERT INTO point_accounts(brand_id,bot_id,user_id) SELECT brand_id,bot_id,id FROM telegram_users WHERE bot_id=$1",
        [s.botId],
      );
      // Immutable ledger fixtures exercise the actual account trigger, never update balances.
      for (const [delta, source, business] of [
        ["100", "admin", "manual_adjustment"],
        ["-10", "admin", "manual_adjustment"],
        ["-5", "redemption", "redemption_debit"],
      ])
        await db.query(
          `INSERT INTO point_ledger(brand_id,bot_id,user_id,account_id,delta,balance_before,balance_after,source,business_type,business_id,idempotency_key,created_at) SELECT p.brand_id,p.bot_id,p.user_id,p.id,$2::bigint,0,0,$3,$4,p.user_id::text||$2,p.user_id::text||$2,u.first_started_at FROM point_accounts p JOIN telegram_users u ON u.id=p.user_id WHERE p.bot_id=$1`,
          [s.botId, delta, source, business],
        );
      await db.query(
        `INSERT INTO referrals(brand_id,bot_id,inviter_id,invitee_id,start_parameter,bound_at,reward_status) SELECT u.brand_id,u.bot_id,i.id,u.id,'test',u.first_started_at,CASE WHEN u.telegram_user_id%3=0 THEN 'rewarded' WHEN u.telegram_user_id%3=1 THEN 'ineligible' ELSE 'pending' END FROM telegram_users u JOIN telegram_users i ON i.bot_id=u.bot_id AND i.telegram_user_id=1 WHERE u.bot_id=$1 AND u.telegram_user_id>1`,
        [s.botId],
      );
      const rule = (
        await one(
          db,
          "INSERT INTO redemption_rules(brand_id,bot_id,name,mode,points_cost,exchange_rate) VALUES($1,$2,'Test','fixed',5,1) RETURNING id",
          [s.brandId, s.botId],
        )
      ).id;
      await db.query(
        `INSERT INTO redemptions(brand_id,bot_id,user_id,rule_id,points_cost,idempotency_key,rule_snapshot,created_at,status) SELECT brand_id,bot_id,id,$2,5,id::text,'{}',first_started_at,(ARRAY['pending','processing','success','failed','cancelled'])[1+(telegram_user_id%5)::int] FROM telegram_users WHERE bot_id=$1`,
        [s.botId, rule],
      );
      await db.query(
        `INSERT INTO point_ledger(brand_id,bot_id,user_id,account_id,delta,balance_before,balance_after,source,business_type,business_id,idempotency_key,created_at) SELECT r.brand_id,r.bot_id,r.user_id,p.id,5,0,0,'redemption','redemption_refund',r.id::text,'refund:'||r.id::text,r.created_at FROM redemptions r JOIN point_accounts p ON p.bot_id=r.bot_id AND p.user_id=r.user_id WHERE r.bot_id=$1 AND r.status='failed'`,
        [s.botId],
      );
    }
    await db.query("ANALYZE telegram_users");
    await db.query("ANALYZE point_ledger");
    await db.query("ANALYZE referrals");
    await db.query("ANALYZE redemptions");
  },
  { timeout: 120000 },
);
after(async () => {
  await app?.close();
  await close?.();
});
const check = (name: string, fn: (v: any) => void) =>
  test(name, async () => fn(await data()));
check("dashboard total counts Bot profiles", (v) =>
  assert.equal(v.realtime.totalUsers, 10000),
);
check("dashboard new users use first start not creation", (v) =>
  assert.equal(v.period.newUsers, 10000),
);
check("dashboard current balance", (v) =>
  assert.equal(v.realtime.pointsBalance, "860000"),
);
check("dashboard earned includes refunds", (v) =>
  assert.equal(v.period.pointsEarned, "1010000"),
);
check("dashboard spent absolute negatives", (v) =>
  assert.equal(v.period.pointsSpent, "150000"),
);
check("dashboard manual credit count", (v) =>
  assert.equal(v.period.manualAdjustments.creditCount, 10000),
);
check("dashboard manual credit points", (v) =>
  assert.equal(v.period.manualAdjustments.creditPoints, "1000000"),
);
check("dashboard manual debit count", (v) =>
  assert.equal(v.period.manualAdjustments.debitCount, 10000),
);
check("dashboard manual debit points", (v) =>
  assert.equal(v.period.manualAdjustments.debitPoints, "100000"),
);
check("dashboard new referrals", (v) =>
  assert.equal(v.period.referrals.newRelations, 9999),
);
check("dashboard unique inviters", (v) =>
  assert.equal(v.period.referrals.uniqueInviters, 1),
);
check("dashboard reward statuses are facts", (v) =>
  assert.deepEqual(v.period.referrals.rewardStatus, {
    pending: 3333,
    rewarded: 3333,
    ineligible: 3333,
  }),
);
check("dashboard redemption created cohort current statuses", (v) =>
  assert.deepEqual(v.period.redemptions, {
    created: 10000,
    currentStatusOfCreatedOrders: {
      pending: 2000,
      processing: 2000,
      success: 2000,
      failed: 2000,
      cancelled: 2000,
    },
  }),
);
check("dashboard refunds linked to orders and dated by ledger", (v) =>
  assert.deepEqual(v.period.refunds, { orders: 2000, points: "10000" }),
);
for (const [key, expected] of [
  ["newUsers", 10000],
  ["pointsEarned", "1010000"],
  ["pointsSpent", "150000"],
  ["newReferrals", 9999],
  ["redemptions", 10000],
] as const)
  test(`dashboard daily ${key} aggregates reconcile`, async () => {
    const v = await data(url("trends"));
    assert.equal(v.items.length, 90);
    const sum = v.items.reduce((n: bigint, r: any) => n + BigInt(r[key]), 0n);
    assert.equal(sum.toString(), String(expected));
  });
test("dashboard half open excludes to boundary", async () => {
  const v = await data(url("summary", from, "2025-01-02T00:00:00Z"));
  assert.equal(v.period.newUsers, 112);
});
test("dashboard realtime balance independent of date", async () => {
  const v = await data(
    url("summary", "2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z"),
  );
  assert.equal(v.period.pointsEarned, "0");
  assert.equal(v.realtime.pointsBalance, "860000");
});
test("dashboard empty scope zero and daily gaps filled", async () => {
  const v = await data(url("summary", from, to, empty), "Super Admin");
  assert.equal(v.realtime.totalUsers, 0);
  assert.equal(v.realtime.pointsBalance, "0");
  const t = await data(url("trends", from, to, empty), "Super Admin");
  assert.equal(t.items.length, 90);
  assert.ok(
    t.items.every((r: any) => r.newUsers === 0 && r.pointsEarned === "0"),
  );
});
check("dashboard unsupported facts explicitly null not zero", (v) => {
  for (const metric of Object.values(v.unsupported) as any[]) {
    assert.equal(metric.supported, false);
    assert.equal(metric.value, null);
  }
  assert.equal(v.period.activeUsers, undefined);
});
for (const role of ["Viewer", "Operator", "Admin", "Super Admin"])
  test(`dashboard ${role} granted permission`, async () =>
    assert.equal((await get(url(), role)).statusCode, 200));
test("dashboard permission denied", async () =>
  assert.equal((await get(url(), "No permission")).statusCode, 403));
test("dashboard session required", async () =>
  assert.equal((await app.inject({ url: url() })).statusCode, 401));
for (const name of ["brand", "bot"])
  test(`dashboard ${name} isolation`, async () => {
    const s = name === "brand" ? b : a2;
    assert.equal((await get(url("summary", from, to, s))).statusCode, 403);
    const v = await data(url("summary", from, to, s), "Super Admin");
    assert.equal(v.realtime.totalUsers, name === "brand" ? 5 : 3);
  });
test("dashboard mismatched brand bot rejected", async () =>
  assert.equal(
    (
      await get(
        url("summary", from, to, { brandId: b.brandId, botId: a.botId }),
        "Super Admin",
      )
    ).statusCode,
    404,
  ));
test("dashboard invalid and excessive ranges rejected", async () => {
  for (const [start, end] of [
    [to, from],
    [from, from],
    [from, "2025-04-02T00:00:00Z"],
    ["bad", to],
  ])
    assert.equal((await get(url("summary", start, end))).statusCode, 400);
  assert.equal(
    (await get(url("trends") + "&granularity=hour")).statusCode,
    400,
  );
});
check("dashboard secret free response", (v) =>
  assert.doesNotMatch(
    JSON.stringify(v),
    /secret|password|token|rule_snapshot|failure_reason/i,
  ),
);
test("dashboard users API backwards compatible", async () => {
  const v = await data(path() + "/users?limit=2");
  assert.equal(v.items.length, 2);
  assert.ok(v.nextCursor);
});
test("dashboard inherited timezone and override boundaries", async () => {
  await db.query(
    "UPDATE telegram_bots SET timezone='America/New_York' WHERE id=$1",
    [empty.botId],
  );
  try {
    const v = await data(
      url("trends", "2025-01-01T00:00:00Z", "2025-01-02T00:00:00Z", empty),
      "Super Admin",
    );
    assert.equal(v.timezoneSource, "bot");
    assert.deepEqual(
      v.items.map((r: any) => r.date),
      ["2024-12-31", "2025-01-01"],
    );
  } finally {
    await db.query("UPDATE telegram_bots SET timezone=NULL WHERE id=$1", [
      empty.botId,
    ]);
  }
});
test("dashboard DST spring and fall local calendar days", async () => {
  await db.query(
    "UPDATE telegram_bots SET timezone='America/New_York' WHERE id=$1",
    [empty.botId],
  );
  try {
    for (const [start, end, date] of [
      ["2025-03-09T05:00:00Z", "2025-03-10T04:00:00Z", "2025-03-09"],
      ["2025-11-02T04:00:00Z", "2025-11-03T05:00:00Z", "2025-11-02"],
    ]) {
      const v = await data(url("trends", start, end, empty), "Super Admin");
      assert.deepEqual(
        v.items.map((r: any) => r.date),
        [date],
      );
    }
  } finally {
    await db.query("UPDATE telegram_bots SET timezone=NULL WHERE id=$1", [
      empty.botId,
    ]);
  }
});
test("dashboard timezone missing fails explicitly and invalid config rejected", async () => {
  await assert.rejects(
    db.query("UPDATE telegram_bots SET timezone='Not/AZone' WHERE id=$1", [
      empty.botId,
    ]),
  );
  await db.query("UPDATE brands SET timezone=NULL WHERE id=$1", [a.brandId]);
  try {
    const r = await get(url());
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error, "dashboard_timezone_not_configured");
  } finally {
    await db.query("UPDATE brands SET timezone='UTC' WHERE id=$1", [a.brandId]);
  }
});
for (const days of [1, 7, 30, 90])
  test(`dashboard performance ${days} days`, async () => {
    const end = new Date(Date.parse(from) + days * 86400000).toISOString();
    for (const kind of ["summary", "trends"] as const) {
      const range = { from, to: end };
      const start = performance.now();
      await db.transaction(async (tx) => {
        await tx.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        return kind === "summary"
          ? dashboardSummary(tx, a, range)
          : dashboardTrends(tx, a, range);
      });
      const dbMs = performance.now() - start;
      const apiStart = performance.now();
      const r = await get(url(kind, from, end));
      const apiMs = performance.now() - apiStart;
      assert.equal(r.statusCode, 200, r.body);
      assert.ok(apiMs < 5000);
      console.log(
        "DASHBOARD_PERF",
        JSON.stringify({
          engine: process.env.TEST_DATABASE_URL ? "PostgreSQL17" : "PGlite",
          days,
          kind,
          dbMs: +dbMs.toFixed(2),
          apiMs: +apiMs.toFixed(2),
          bytes: Buffer.byteLength(r.body),
          users: 10000,
          ledger: 32000,
          referrals: 9999,
          redemptions: 10000,
        }),
      );
    }
  });
test("dashboard bigint remains exact beyond JS integer precision", async () => {
  const user = (
    await one(db, "SELECT id FROM telegram_users WHERE bot_id=$1 LIMIT 1", [
      b.botId,
    ])
  ).id;
  const account = (
    await one(db, "SELECT id FROM point_accounts WHERE user_id=$1", [user])
  ).id;
  await db.query(
    "INSERT INTO point_ledger(brand_id,bot_id,user_id,account_id,delta,balance_before,balance_after,source,business_type,business_id,idempotency_key,created_at) VALUES($1,$2,$3,$4,9007199254740993,0,0,'test','precision',$5,$5,'2025-01-01')",
    [b.brandId, b.botId, user, account, randomUUID()],
  );
  const v = await data(url("summary", from, to, b), "Super Admin");
  assert.equal(v.period.pointsEarned, "9007199254741498");
  assert.equal(typeof v.period.pointsEarned, "string");
});
test("dashboard missing first start excluded and timezone buckets contain actual facts", async () => {
  await db.query(
    "UPDATE telegram_bots SET timezone='America/New_York' WHERE id=$1",
    [empty.botId],
  );
  await db.query(
    "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id,first_started_at) VALUES($1,$2,1,'2025-01-01T04:59:59Z'),($1,$2,2,'2025-01-01T05:00:00Z'),($1,$2,3,NULL)",
    [empty.brandId, empty.botId],
  );
  try {
    const v = await data(
      url("trends", "2025-01-01T00:00:00Z", "2025-01-02T00:00:00Z", empty),
      "Super Admin",
    );
    assert.deepEqual(
      v.items.map((r: any) => [r.date, r.newUsers]),
      [
        ["2024-12-31", 1],
        ["2025-01-01", 1],
      ],
    );
    const sum = await data(
      url("summary", "2025-01-01T05:00:00Z", "2025-01-02T05:00:00Z", empty),
      "Super Admin",
    );
    assert.equal(sum.realtime.totalUsers, 3);
    assert.equal(sum.period.newUsers, 1);
  } finally {
    await db.query("UPDATE telegram_bots SET timezone=NULL WHERE id=$1", [
      empty.botId,
    ]);
  }
});
test(
  "dashboard PG17 repeatable snapshot survives concurrent ledger commit",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const user = (
      await one(db, "SELECT id FROM telegram_users WHERE bot_id=$1 LIMIT 1", [
        empty.botId,
      ])
    ).id;
    const account = (
      await one(
        db,
        "INSERT INTO point_accounts(brand_id,bot_id,user_id) VALUES($1,$2,$3) RETURNING id",
        [empty.brandId, empty.botId, user],
      )
    ).id;
    await db.transaction(async (tx) => {
      await tx.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const before = await dashboardSummary(tx, empty, { from, to });
      await db.query(
        "INSERT INTO point_ledger(brand_id,bot_id,user_id,account_id,delta,balance_before,balance_after,source,business_type,business_id,idempotency_key,created_at) VALUES($1,$2,$3,$4,9,0,0,'test','snapshot',$5,$5,'2025-01-01')",
        [empty.brandId, empty.botId, user, account, randomUUID()],
      );
      const after = await dashboardSummary(tx, empty, { from, to });
      assert.deepEqual(after, before);
    });
    const fresh = await data(url("summary", from, to, empty), "Super Admin");
    assert.equal(fresh.realtime.pointsBalance, "9");
    assert.equal(fresh.period.pointsEarned, "9");
  },
);
