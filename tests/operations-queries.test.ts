import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import {
  postgres,
  one,
  type Database,
  type Queryable,
  type Scope,
} from "../src/db.js";
import { migrate } from "../src/migrations.js";
import { createApp } from "../src/app.js";
import { postPoints } from "../src/points.js";
import { hashPassword } from "../src/passwords.js";
let db: Database,
  close: () => Promise<void>,
  app: FastifyInstance,
  sessionApp: FastifyInstance;
let a: Scope,
  a2: Scope,
  b: Scope,
  admin: string,
  viewer: string,
  superAdmin: string,
  userId: string,
  otherUser: string,
  ledgerScaleUser: string,
  cookie: string;
const base = () => `/v1/brands/${a.brandId}/bots/${a.botId}`;
const path = (s: Scope) => `/v1/brands/${s.brandId}/bots/${s.botId}`;
const get = (url: string, identity = admin) =>
  app.inject({ url, headers: { authorization: identity } });
async function data(url: string, identity = admin) {
  const response = await get(url, identity);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
async function collect(url: string) {
  const result: any[] = [];
  let after: string | null = null;
  do {
    const response = await data(
      url +
        (url.includes("?") ? "&" : "?") +
        "limit=100" +
        (after ? "&after=" + encodeURIComponent(after) : ""),
    );
    result.push(...response.items);
    after = response.nextCursor;
  } while (after);
  return result;
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
    async function brand() {
      return (
        await one(
          db,
          "INSERT INTO brands(name,slug,default_language) VALUES('Query acceptance',$1,'pt-BR') RETURNING id",
          [randomUUID()],
        )
      ).id;
    }
    async function bot(brandId: string): Promise<Scope> {
      const row = await one(
        db,
        "INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages) VALUES($1,'Query bot',$2,$3,$4,'pt-BR',ARRAY['pt-BR','en']) RETURNING id",
        [brandId, randomUUID(), randomUUID(), randomUUID()],
      );
      return { brandId, botId: row.id };
    }
    const brandId = await brand();
    a = await bot(brandId);
    a2 = await bot(brandId);
    b = await bot(await brand());
    async function identity(role: string, scope: Scope | null) {
      const id = (
        await one(
          db,
          "INSERT INTO admins(auth_subject,display_name) VALUES($1,'Query admin') RETURNING id",
          [randomUUID()],
        )
      ).id;
      await db.query(
        "INSERT INTO admin_roles(admin_id,role_id,brand_id,bot_id) SELECT $1,id,$2,$3 FROM roles WHERE name=$4",
        [id, scope?.brandId ?? null, scope?.botId ?? null, role],
      );
      return id;
    }
    admin = await identity("Admin", a);
    viewer = await identity("Viewer", a);
    superAdmin = await identity("Super Admin", null);
    for (const [scope, size] of [
      [a, 5000],
      [a2, 500],
      [b, 500],
    ] as [Scope, number][]) {
      await db.query(
        `INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id,username,first_name,last_name,telegram_language_code,preferred_language,status,first_started_at,last_interaction_at)
 SELECT $1,$2,10000000+g,'user_'||lpad(g::text,5,'0'),'Member'||lpad(g::text,5,'0'),'Family'||(g%10),CASE WHEN g%2=0 THEN 'en' ELSE 'zh-CN' END,CASE WHEN g%4=0 THEN 'pt-BR' ELSE NULL END,CASE WHEN g%3=0 THEN 'blocked' ELSE 'active' END,CASE WHEN g%5=0 THEN NULL ELSE '2025-01-01'::timestamptz+(g%20)*interval '1 day' END,'2025-02-01'::timestamptz+(g%15)*interval '1 day' FROM generate_series(1,$3::int) g`,
        [scope.brandId, scope.botId, size],
      );
      await db.query(
        "INSERT INTO point_accounts(brand_id,bot_id,user_id) SELECT brand_id,bot_id,id FROM telegram_users WHERE bot_id=$1",
        [scope.botId],
      );
      await db.query(
        `INSERT INTO point_ledger(brand_id,bot_id,user_id,account_id,delta,balance_before,balance_after,source,business_type,business_id,idempotency_key,note,created_at) SELECT brand_id,bot_id,user_id,id,10,0,0,'activity','seed',user_id::text,user_id::text,'Acceptance seed','2025-01-01' FROM point_accounts WHERE bot_id=$1`,
        [scope.botId],
      );
      const inviter = (
        await one(
          db,
          "SELECT id FROM telegram_users WHERE bot_id=$1 AND telegram_user_id=10000001",
          [scope.botId],
        )
      ).id;
      await db.query(
        `INSERT INTO referrals(brand_id,bot_id,inviter_id,invitee_id,start_parameter,status,reward_status,bound_at) SELECT brand_id,bot_id,$2,id,'acceptance',CASE WHEN telegram_user_id%2=0 THEN 'qualified' ELSE 'bound' END,CASE WHEN telegram_user_id%2=0 THEN 'rewarded' ELSE 'pending' END,'2025-03-01' FROM telegram_users WHERE bot_id=$1 AND id<>$2`,
        [scope.botId, inviter],
      );
      await db.query(
        `INSERT INTO audit_logs(admin_id,brand_id,bot_id,action,object_type,object_id,note,before_data,after_data,created_at) SELECT $3,$1,$2,'points.adjust','point_ledger',id::text,'DO_NOT_DISCLOSE_NOTE',jsonb_build_object('password','DO_NOT_DISCLOSE_PASSWORD'),jsonb_build_object('nested',jsonb_build_object('token','DO_NOT_DISCLOSE_TOKEN')),'2025-04-01' FROM point_ledger WHERE bot_id=$2`,
        [scope.brandId, scope.botId, admin],
      );
    }
    userId = (
      await one(
        db,
        "SELECT id FROM telegram_users WHERE bot_id=$1 AND telegram_user_id=10000001",
        [a.botId],
      )
    ).id;
    otherUser = (
      await one(db, "SELECT id FROM telegram_users WHERE bot_id=$1 LIMIT 1", [
        a2.botId,
      ])
    ).id;
    for (const [delta, source, type] of [
      ["9007199254740993", "admin", "manual_adjustment"],
      ["-7", "redemption", "redemption"],
      ["3", "refund", "refund"],
    ])
      await db.transaction((tx) =>
        postPoints(tx, {
          ...a,
          userId,
          delta: delta!,
          source: source!,
          businessType: type!,
          businessId: randomUUID(),
          idempotencyKey: randomUUID(),
          note: "Acceptance event",
        }),
      );
    ledgerScaleUser = (
      await one(
        db,
        "SELECT id FROM telegram_users WHERE bot_id=$1 AND telegram_user_id=10000002",
        [a.botId],
      )
    ).id;
    await db.transaction(async (tx) => {
      for (let i = 0; i < 1000; i++)
        await postPoints(tx, {
          ...a,
          userId: ledgerScaleUser,
          delta: "1",
          source: "acceptance",
          businessType: "scale",
          businessId: randomUUID(),
          idempotencyKey: randomUUID(),
        });
    });
    for (const table of [
      "telegram_users",
      "point_accounts",
      "point_ledger",
      "referrals",
      "audit_logs",
    ])
      await db.query("ANALYZE " + table);
    app = createApp(
      db,
      () => undefined,
      async (identity) => ({ adminId: identity! }),
    );
    const password = randomUUID() + randomUUID(),
      login = "query-" + randomUUID();
    await db.query(
      "INSERT INTO admin_credentials(admin_id,login,password_hash) VALUES($1,$2,$3)",
      [admin, login, await hashPassword(password)],
    );
    sessionApp = createApp(
      db,
      () => undefined,
      async () => {
        throw Error("Legacy fallback forbidden");
      },
      {
        allowedOrigins: ["https://queries.example.test"],
        secure: true,
        sameSite: "Lax",
        sessionSeconds: 28800,
      },
    );
    const signed = await sessionApp.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: {
        origin: "https://queries.example.test",
        "x-csrf-protection": "1",
      },
      payload: { login, password },
    });
    assert.equal(signed.statusCode, 200);
    cookie = String(signed.headers["set-cookie"]).split(";")[0]!;
    console.log(
      "Query fixture: 2 brands, 3 bots, 6000 users, 7003 ledger rows, 5997 referrals, 6000 scoped audits.",
    );
  },
  { timeout: 120000 },
);
after(async () => {
  await app?.close();
  await sessionApp?.close();
  await close?.();
});
test("query: Telegram ID exact search", async () => {
  const r = await data(base() + "/users?q=10000001");
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].id, userId);
});
test("query: username prefix search and literal wildcard escaping", async () => {
  const r = await data(base() + "/users?q=@USER_00001");
  assert.equal(r.items[0].id, userId);
  assert.equal((await data(base() + "/users?q=%25")).items.length, 0);
});
test("query: first and last name prefix searches", async () => {
  assert.equal((await data(base() + "/users/count?q=Member0000")).total, "9");
  assert.equal((await data(base() + "/users/count?q=Family2")).total, "500");
});
test("query: status filter", async () => {
  assert.equal(
    (await data(base() + "/users/count?status=blocked")).total,
    "1666",
  );
});
test("query: stored Telegram language filter", async () => {
  assert.equal((await data(base() + "/users/count?language=EN")).total, "2500");
});
test("query: preferred language filter does not guess resolved language", async () => {
  assert.equal(
    (await data(base() + "/users/count?language=pt-BR&languageField=preferred"))
      .total,
    "1250",
  );
});
test("query: first start range excludes null and uses half-open bounds", async () => {
  assert.equal(
    (
      await data(
        base() +
          "/users/count?startedFrom=2025-01-02T00:00:00Z&startedTo=2025-01-03T00:00:00Z",
      )
    ).total,
    "250",
  );
});
test("query: last interaction range", async () => {
  assert.equal(
    (
      await data(
        base() +
          "/users/count?interactionFrom=2025-02-01T00:00:00Z&interactionTo=2025-02-02T00:00:00Z",
      )
    ).total,
    "333",
  );
});
test("query: deterministic unique ID default ordering", async () => {
  const r = await data(base() + "/users");
  assert.deepEqual(
    r.items.map((u: any) => u.id),
    r.items.map((u: any) => u.id).sort(),
  );
});
test("query: combined name status and language filters", async () => {
  const r = await data(
    base() + "/users/count?q=Member000&status=blocked&language=en",
  );
  assert.equal(r.total, "16");
});
test("query: search with cursor pagination", async () => {
  const rows = await collect(base() + "/users?q=Member00");
  assert.equal(rows.length, 999);
  assert.equal(new Set(rows.map((r) => r.id)).size, 999);
});
test("query: filter with cursor pagination", async () => {
  const rows = await collect(base() + "/users?status=blocked");
  assert.equal(rows.length, 1666);
  assert.ok(rows.every((r) => r.status === "blocked"));
});
for (const order of ["asc", "desc"])
  test(`query: time sort ${order} with null/tie pagination has no loss`, async () => {
    const rows = await collect(
      base() + `/users?sort=first_started_at&order=${order}`,
    );
    assert.equal(rows.length, 5000);
    assert.equal(new Set(rows.map((r) => r.id)).size, 5000);
    let nullSeen = false;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.first_started_at === null) nullSeen = true;
      else assert.equal(nullSeen, false);
      const previous = rows[i - 1];
      if (!previous || !row.first_started_at || !previous.first_started_at)
        continue;
      const diff =
        Date.parse(row.first_started_at) -
        Date.parse(previous.first_started_at);
      assert.ok(order === "asc" ? diff >= 0 : diff <= 0);
      if (!diff)
        assert.ok(
          order === "asc" ? row.id > previous.id : row.id < previous.id,
        );
    }
  });
test("query: last interaction sort supported", async () => {
  const r = await data(base() + "/users?sort=last_interaction_at&order=desc");
  assert.ok(
    r.items.every(
      (v: any) => v.last_interaction_at === r.items[0].last_interaction_at,
    ),
  );
});
test("query: cursor rejects changed search/filter/order and Bot", async () => {
  const r = await data(base() + "/users?limit=2");
  for (const suffix of [
    "&q=Member",
    "&status=active",
    "&order=desc",
    "&sort=first_started_at",
  ])
    assert.equal(
      (await get(base() + "/users?after=" + r.nextCursor + suffix)).statusCode,
      400,
    );
  assert.equal(
    (await get(path(a2) + "/users?after=" + r.nextCursor, superAdmin))
      .statusCode,
    400,
  );
});
test("query: forged and legacy UUID cursors rejected safely", async () => {
  assert.equal(
    (await get(base() + "/users?after=" + randomUUID())).statusCode,
    400,
  );
  const r = await data(base() + "/users?limit=1");
  const [body, sig] = r.nextCursor.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString());
  payload.id = randomUUID();
  assert.equal(
    (
      await get(
        base() +
          "/users?after=" +
          Buffer.from(JSON.stringify(payload)).toString("base64url") +
          "." +
          sig,
      )
    ).statusCode,
    400,
  );
});
test("query: count independent of pages and scope", async () => {
  assert.equal((await data(base() + "/users/count")).total, "5000");
  assert.equal((await data(path(b) + "/users/count", superAdmin)).total, "500");
});
test("query: detail safe fields and existing language resolver", async () => {
  const r = await data(base() + "/users/" + userId);
  assert.equal(r.telegram_user_id, "10000001");
  assert.equal(r.resolved_language, "pt-BR");
  for (const k of [
    "created_at",
    "updated_at",
    "first_started_at",
    "last_interaction_at",
  ])
    assert.ok(k in r);
  assert.ok(!JSON.stringify(r).includes("secret"));
});
test("query: exact current balance string", async () => {
  assert.equal(
    (await data(base() + `/users/${userId}/points/summary`)).balance,
    "9007199254740999",
  );
});
test("query: total earned includes credits and refunds", async () => {
  assert.equal(
    (await data(base() + `/users/${userId}/points/summary`)).totalEarned,
    "9007199254741006",
  );
});
test("query: total spent is absolute negative ledger sum", async () => {
  assert.equal(
    (await data(base() + `/users/${userId}/points/summary`)).totalSpent,
    "7",
  );
});
test("query: ledger cursor pages", async () => {
  const first = await data(base() + `/users/${userId}/point-ledger?limit=2`);
  const second = await data(
    base() + `/users/${userId}/point-ledger?limit=2&after=${first.nextCursor}`,
  );
  assert.equal(
    new Set([...first.items, ...second.items].map((r) => r.id)).size,
    4,
  );
  assert.equal(second.nextCursor, null);
  for (const row of first.items)
    for (const field of ["delta", "balance_before", "balance_after"])
      assert.equal(typeof row[field], "string");
});
test("query: ledger direction", async () => {
  const r = await data(
    base() + `/users/${userId}/point-ledger?direction=debit`,
  );
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].delta, "-7");
});
test("query: ledger source", async () => {
  const r = await data(base() + `/users/${userId}/point-ledger?source=refund`);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].delta, "3");
});
test("query: ledger business type", async () => {
  assert.equal(
    (
      await data(
        base() + `/users/${userId}/point-ledger?businessType=manual_adjustment`,
      )
    ).items.length,
    1,
  );
});
test("query: ledger date range", async () => {
  const r = await data(
    base() +
      `/users/${userId}/point-ledger?from=2025-01-01T00:00:00Z&to=2025-01-02T00:00:00Z`,
  );
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].source, "activity");
});
test("query: incoming inviter", async () => {
  const invitee = await one(
    db,
    "SELECT invitee_id FROM referrals WHERE bot_id=$1 LIMIT 1",
    [a.botId],
  );
  const r = await data(base() + `/users/${invitee.invitee_id}/referrals`);
  assert.equal(r.invitedBy.inviter.id, userId);
});
test("query: outgoing invitees and factual count", async () => {
  const r = await data(base() + `/users/${userId}/referrals`);
  assert.equal(r.invitedBy, null);
  assert.equal(r.invitedCount, "4999");
  assert.equal(r.items.length, 50);
  assert.ok(!("validCount" in r));
});
test("query: Bot referral filters and user searches", async () => {
  const r = await data(
    base() +
      "/referrals?status=qualified&rewardStatus=rewarded&inviter=10000001&invitee=user_00002&from=2025-03-01T00:00:00Z&to=2025-03-02T00:00:00Z",
  );
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].invitee.telegramUserId, "10000002");
});
test("query: referral page cursor tied to direction and filters", async () => {
  const r = await data(base() + "/referrals?limit=2");
  assert.equal(
    (await get(base() + "/referrals?status=bound&after=" + r.nextCursor))
      .statusCode,
    400,
  );
  assert.equal(
    (await get(base() + `/users/${userId}/referrals?after=` + r.nextCursor))
      .statusCode,
    400,
  );
});
test("query: scoped Audit filters", async () => {
  const r = await data(
    base() +
      `/audit-logs?adminId=${admin}&action=points.adjust&objectType=point_ledger&from=2025-04-01T00:00:00Z&to=2025-04-02T00:00:00Z`,
  );
  assert.equal(r.items.length, 50);
  assert.equal(r.items[0].result, "committed");
});
test("query: Audit excludes nested before/after, raw notes and authentication metadata", async () => {
  const r = await data(base() + "/audit-logs");
  const output = JSON.stringify(r);
  assert.ok(!output.includes("DO_NOT_DISCLOSE"));
  for (const row of r.items)
    for (const key of ["before_data", "after_data", "note", "ip", "request_id"])
      assert.ok(!(key in row));
});
test("query: Viewer cannot read Audit even with a valid URL", async () => {
  assert.equal((await get(base() + "/audit-logs", viewer)).statusCode, 403);
  assert.equal((await get(base() + "/users", viewer)).statusCode, 200);
});
test("query: Super Admin scoped audit and scope-admin denial", async () => {
  assert.equal(
    (await get(path(b) + "/audit-logs", superAdmin)).statusCode,
    200,
  );
  assert.equal((await get(path(b) + "/audit-logs")).statusCode, 403);
});
test("query: cross Brand search denied", async () => {
  assert.equal((await get(path(b) + "/users?q=Member")).statusCode, 403);
});
test("query: cross Bot detail denied and foreign user hidden", async () => {
  assert.equal((await get(path(a2) + "/users/" + otherUser)).statusCode, 403);
  assert.equal((await get(base() + "/users/" + otherUser)).statusCode, 404);
});
test("query: cross Bot ledger denied", async () => {
  assert.equal(
    (await get(base() + `/users/${otherUser}/point-ledger`)).statusCode,
    404,
  );
  assert.equal(
    (await get(path(a2) + `/users/${otherUser}/point-ledger`)).statusCode,
    403,
  );
});
test("query: cross Bot referral denied", async () => {
  assert.equal(
    (await get(base() + `/users/${otherUser}/referrals`)).statusCode,
    404,
  );
  assert.equal((await get(path(a2) + "/referrals")).statusCode, 403);
});
test("query: scale ID pagination has no duplicate or omitted users", async () => {
  const start = performance.now();
  const rows = await collect(base() + "/users");
  const ids = (
    await db.query(
      "SELECT id FROM telegram_users WHERE bot_id=$1 ORDER BY id",
      [a.botId],
    )
  ).rows.map((r) => r.id);
  assert.deepEqual(
    rows.map((r) => r.id),
    ids,
  );
  console.log(
    `Query scale users: 5000 rows / 50 pages / ${(performance.now() - start).toFixed(1)} ms (${process.env.TEST_DATABASE_URL ? "PostgreSQL17" : "PGlite"})`,
  );
});
test("query: scale referral and Audit pagination have no duplicate or missing rows", async () => {
  const start = performance.now();
  for (const [route, expected] of [
    ["referrals", 4999],
    ["audit-logs", 5000],
  ] as const) {
    const rows = await collect(base() + "/" + route);
    assert.equal(rows.length, expected);
    assert.equal(new Set(rows.map((r) => r.id)).size, expected);
  }
  console.log(
    `Query scale referral+audit: 9999 rows / 100 pages / ${(performance.now() - start).toFixed(1)} ms`,
  );
});
test("query: first-batch user fields and balance endpoint remain compatible", async () => {
  const r = await data(base() + "/users?limit=50");
  for (const key of [
    "id",
    "telegram_user_id",
    "username",
    "first_name",
    "last_name",
    "telegram_language_code",
    "preferred_language",
    "first_started_at",
    "last_interaction_at",
    "status",
  ])
    assert.ok(key in r.items[0]);
  assert.equal(typeof r.nextCursor, "string");
  assert.deepEqual(await data(base() + `/users/${userId}/points`), {
    balance: "9007199254740999",
  });
});
test("query: strict params prevent SQL field injection and invalid date ranges", async () => {
  for (const query of [
    "sort=password",
    "sort=id%3BDROP%20TABLE%20users",
    "status=unknown",
    "limit=101",
    "startedFrom=2025-02-02T00:00:00Z&startedTo=2025-02-01T00:00:00Z",
  ])
    assert.equal((await get(base() + "/users?" + query)).statusCode, 400);
});
test("query: actual Session authentication protects every new route", async () => {
  for (const route of [
    "/users/count",
    `/users/${userId}`,
    `/users/${userId}/points/summary`,
    `/users/${userId}/point-ledger`,
    `/users/${userId}/referrals`,
    "/referrals",
    "/audit-logs",
  ]) {
    assert.equal(
      (await sessionApp.inject({ url: base() + route })).statusCode,
      401,
    );
    assert.equal(
      (await sessionApp.inject({ url: base() + route, headers: { cookie } }))
        .statusCode,
      200,
    );
  }
});
test("query: indexes exist and migration replay is safe", async () => {
  await migrate(db);
  const indexes = (
    await db.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN ('users_username_prefix','ledger_user_page','referrals_inviter_page','audit_scope_page')",
    )
  ).rows;
  assert.equal(indexes.length, 4);
});
test("query: representative SQL plans and timing on scale fixtures", async () => {
  for (const sql of [
    "SELECT id FROM telegram_users WHERE brand_id=$1 AND bot_id=$2 ORDER BY last_interaction_at,id LIMIT 51",
    "SELECT id FROM telegram_users WHERE brand_id=$1 AND bot_id=$2 AND lower(username) LIKE 'user\\_00001%' ORDER BY id LIMIT 51",
    "SELECT id FROM point_ledger WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3 ORDER BY created_at DESC,id DESC LIMIT 51",
  ]) {
    const plan = await db.query(
      "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + sql,
      sql.includes("$3") ? [a.brandId, a.botId, userId] : [a.brandId, a.botId],
    );
    console.log("Query EXPLAIN:", JSON.stringify(plan.rows[0]));
  }
});

test("query: scale single-user ledger pagination has no duplicates or omissions", async () => {
  const start = performance.now();
  const rows = await collect(base() + `/users/${ledgerScaleUser}/point-ledger`);
  assert.equal(rows.length, 1001);
  assert.equal(new Set(rows.map((r) => r.id)).size, 1001);
  const r = await data(base() + `/users/${ledgerScaleUser}/points/summary`);
  assert.deepEqual(r, {
    balance: "1010",
    totalEarned: "1010",
    totalSpent: "0",
  });
  console.log(
    `Query scale ledger: 1001 rows / 11 pages / ${(performance.now() - start).toFixed(1)} ms`,
  );
});
test("query: ledger cursor is bound to user and filters", async () => {
  const r = await data(base() + `/users/${userId}/point-ledger?limit=1`);
  assert.equal(
    (
      await get(
        base() + `/users/${ledgerScaleUser}/point-ledger?after=${r.nextCursor}`,
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await get(
        base() +
          `/users/${userId}/point-ledger?source=refund&after=${r.nextCursor}`,
      )
    ).statusCode,
    400,
  );
});
test("query: Audit cursor filters and limit bounds enforced", async () => {
  const r = await data(base() + "/audit-logs?limit=1");
  assert.equal(
    (await get(base() + `/audit-logs?adminId=${admin}&after=${r.nextCursor}`))
      .statusCode,
    400,
  );
  assert.equal((await get(base() + "/audit-logs?limit=1000")).statusCode, 400);
});
