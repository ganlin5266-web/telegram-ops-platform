import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/migrations.js";
import { one, postgres, type Database, type Queryable } from "../src/db.js";
import { postPoints } from "../src/points.js";
import {
  createPolicy,
  publishPolicy,
  pointSummary,
  reconcileAccount,
  policyExpiry,
} from "../src/point-lots.js";
import {
  cutoverBot,
  legacyPreflight,
  expirePointsBatch,
} from "../src/point-lot-maintenance.js";
import {
  reserveRedemption,
  failRedemption,
  assignCode,
} from "../src/redemptions.js";
let db: Database, close: () => Promise<void>;
before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    const pg = postgres(process.env.TEST_DATABASE_URL);
    db = pg;
    close = pg.close;
  } else {
    const pg = new PGlite();
    const adapt = (c: any): Queryable => ({
      query: async (s, p) =>
        p === undefined
          ? ((await c.exec(s)).at(-1) ?? { rows: [] })
          : c.query(s, p),
    });
    db = {
      ...adapt(pg),
      transaction: (f) => pg.transaction((t) => f(adapt(t))),
    };
    close = () => pg.close();
  }
  await migrate(db);
  process.env.POINT_LOTS_ENABLED = "true";
});
after(async () => {
  delete process.env.POINT_LOTS_ENABLED;
  await close();
});
async function fixture(managed = true) {
  const b = await one(
    db,
    "INSERT INTO brands(name,slug,default_language) VALUES('Lot TEST',$1,'en') RETURNING id",
    [randomUUID()],
  );
  const bot = await one(
    db,
    "INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status) VALUES($1,'Lot TEST',$2,$3,$4,'en',ARRAY['en'],'disabled') RETURNING id",
    [b.id, randomUUID(), randomUUID(), randomUUID()],
  );
  const user = await one(
    db,
    "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,9007199254740801) RETURNING id",
    [b.id, bot.id],
  );
  const admin = await one(
    db,
    "INSERT INTO admins(auth_subject,display_name) VALUES($1,'Lot Tester') RETURNING id",
    [randomUUID()],
  );
  const f = {
    brandId: b.id,
    botId: bot.id,
    userId: user.id,
    adminId: admin.id,
  };
  if (managed) await db.transaction((tx) => cutoverBot(tx, f));
  return f;
}
async function policy(f: any, mode = "permanent", extra: any = {}) {
  return db.transaction(async (tx) => {
    const p = await createPolicy(
      tx,
      f,
      f.adminId,
      {
        name: "STAGING TEST ONLY",
        source: "*",
        mode,
        timezone: "UTC",
        effectiveAt: new Date(Date.now() - 60000).toISOString(),
        ...extra,
      },
      "test",
    );
    return publishPolicy(tx, f, f.adminId, p.id, "test");
  });
}
const event = (
  f: any,
  delta: string,
  key: string = randomUUID(),
  extra: any = {},
) => ({
  ...f,
  delta,
  source: "test",
  businessType: "test",
  businessId: key,
  idempotencyKey: key,
  ...extra,
});
const post = (f: any, delta: string, key?: string, extra?: any) =>
  db.transaction((tx) => postPoints(tx, event(f, delta, key, extra)));
async function account(f: any) {
  return one(
    db,
    "SELECT * FROM point_accounts WHERE bot_id=$1 AND user_id=$2",
    [f.botId, f.userId],
  );
}
async function balance(f: any, value: string) {
  const a = await account(f);
  assert.equal(String(a.balance), value);
  assert.equal((await reconcileAccount(db, a.id)).consistent, true);
}
async function rule(f: any, cost = 150) {
  return one(
    db,
    "INSERT INTO redemption_rules(brand_id,bot_id,name,mode,points_cost,exchange_rate,enabled) VALUES($1,$2,'TEST','fixed',$3,1,true) RETURNING id",
    [f.brandId, f.botId, cost],
  );
}
for (const mode of ["permanent", "rolling_days", "fixed_deadline"])
  test(`policy ${mode}: grant, snapshot and immutable published version`, async () => {
    const f = await fixture(),
      extra =
        mode === "rolling_days"
          ? { rollingDays: 7 }
          : mode === "fixed_deadline"
            ? { deadline: new Date(Date.now() + 86400000).toISOString() }
            : {};
    const p = await policy(f, mode, extra);
    await post(f, "100");
    const l = await one(db, "SELECT * FROM point_lots WHERE bot_id=$1", [
      f.botId,
    ]);
    assert.equal(String(l.remaining_amount), "100");
    assert.equal(l.policy_version_id, p.id);
    if (mode === "permanent") assert.equal(l.expires_at, null);
    else if (mode === "rolling_days")
      assert.equal(
        new Date(l.expires_at).getTime() - new Date(l.granted_at).getTime(),
        7 * 86400000,
      );
    else
      assert.equal(
        new Date(l.expires_at).toISOString(),
        (extra as any).deadline,
      );
    await assert.rejects(
      () =>
        db.query(
          "UPDATE point_expiry_policy_versions SET rolling_days=1 WHERE id=$1",
          [p.id],
        ),
      /immutable/,
    );
    await balance(f, "100");
  });
test("missing policy fails closed and rolls back account/ledger", async () => {
  const f = await fixture();
  await assert.rejects(() => post(f, "1"), /point_expiry_policy_required/);
  assert.equal(
    (await db.query("SELECT id FROM point_accounts WHERE bot_id=$1", [f.botId]))
      .rows.length,
    0,
  );
});
test("missing cutover blocks enabled path", async () => {
  const f = await fixture(false);
  await policy(f);
  await assert.rejects(() => post(f, "1"), /point_lot_cutover_required/);
});
test("source and explicit policy precedence; new version does not change old lots", async () => {
  const f = await fixture();
  const p = await policy(f);
  const q = await policy(f, "rolling_days", {
    source: "test",
    rollingDays: 30,
  });
  await post(f, "10");
  await post(f, "20", undefined, { policyVersionId: p.id });
  const v2 = await policy(f, "rolling_days", {
    source: "test",
    rollingDays: 7,
    effectiveAt: new Date(Date.now() - 1000).toISOString(),
  });
  await post(f, "30");
  const lots = (
    await db.query(
      "SELECT policy_version_id,granted_amount::text FROM point_lots WHERE bot_id=$1 ORDER BY granted_amount",
      [f.botId],
    )
  ).rows;
  assert.deepEqual(
    lots.map((l) => l.policy_version_id),
    [q.id, p.id, v2.id],
  );
});
test("FEFO, permanent last, allocation sum and duplicate spend", async () => {
  const f = await fixture();
  const p = await policy(f);
  const a = await policy(f, "rolling_days", {
    source: "early",
    rollingDays: 1,
  });
  const b = await policy(f, "rolling_days", {
    source: "late",
    rollingDays: 30,
  });
  await post(f, "500", undefined, { policyVersionId: p.id });
  await post(f, "200", undefined, { policyVersionId: b.id });
  await post(f, "100", undefined, { policyVersionId: a.id });
  const key = randomUUID(),
    debit = await post(f, "-150", key);
  assert.equal((await post(f, "-150", key)).id, debit.id);
  const rows = (
    await db.query(
      "SELECT l.policy_version_id,a.amount::text FROM point_lot_allocations a JOIN point_lots l ON l.id=a.lot_id WHERE negative_ledger_id=$1 ORDER BY a.amount DESC",
      [debit.id],
    )
  ).rows;
  assert.deepEqual(rows, [
    { policy_version_id: a.id, amount: "100" },
    { policy_version_id: b.id, amount: "50" },
  ]);
  await balance(f, "650");
});
test("permanent FIFO and conflicting duplicate amount", async () => {
  const f = await fixture();
  await policy(f);
  const a = await post(f, "10");
  await post(f, "20");
  const d = await post(f, "-5");
  assert.equal(
    (
      await one(
        db,
        "SELECT l.positive_ledger_id FROM point_lot_allocations a JOIN point_lots l ON l.id=a.lot_id WHERE a.negative_ledger_id=$1",
        [d.id],
      )
    ).positive_ledger_id,
    a.id,
  );
  await assert.rejects(
    () => post(f, "11", a.business_id),
    /idempotency_conflict/,
  );
});
test("integer-only points, nonzero and overflow", async () => {
  const f = await fixture();
  await policy(f);
  for (const d of ["0", "0.5", "9223372036854775808"])
    await assert.rejects(() => post(f, d), /invalid_points/);
});
test("two concurrent spends cannot overdraft", async () => {
  const f = await fixture();
  await policy(f);
  await post(f, "100");
  const r = await Promise.allSettled([post(f, "-80"), post(f, "-80")]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  await balance(f, "20");
});
test("expiry unavailable before job, ledger settlement once", async () => {
  const f = await fixture();
  await policy(f, "fixed_deadline", {
    deadline: new Date(Date.now() + 1200).toISOString(),
  });
  await post(f, "100");
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal((await pointSummary(db, f)).availableBalance, "0");
  await assert.rejects(() => post(f, "-1"), /insufficient_available_points/);
  await expirePointsBatch(db);
  await expirePointsBatch(db);
  await balance(f, "0");
  assert.equal(
    (
      await db.query(
        "SELECT id FROM point_ledger WHERE bot_id=$1 AND business_type='point_expired'",
        [f.botId],
      )
    ).rows.length,
    1,
  );
});
test("deferred guard rejects missing lot and rolls back ledger", async () => {
  const f = await fixture();
  await policy(f);
  await post(f, "100");
  const a = await account(f);
  await assert.rejects(
    () =>
      db.transaction((tx) =>
        tx.query(
          "INSERT INTO point_ledger(brand_id,bot_id,user_id,account_id,delta,balance_before,balance_after,source,business_type,business_id,idempotency_key) VALUES($1,$2,$3,$4,10,0,0,'test','test','bad','bad')",
          [f.brandId, f.botId, f.userId, a.id],
        ),
      ),
    /point_lot_ledger_mismatch/,
  );
  await balance(f, "100");
});
test("direct lot edits and ledger history deletion are rejected", async () => {
  const f = await fixture();
  await policy(f);
  await post(f, "100");
  await assert.rejects(
    () =>
      db.query("UPDATE point_lots SET remaining_amount=0 WHERE bot_id=$1", [
        f.botId,
      ]),
    /use_lot_allocation/,
  );
  await assert.rejects(
    () => db.query("DELETE FROM point_lots WHERE bot_id=$1", [f.botId]),
    /immutable/,
  );
  await assert.rejects(
    () => db.query("DELETE FROM point_ledger WHERE bot_id=$1", [f.botId]),
    /immutable/,
  );
});
test("full multi-lot refund retains lineage and is idempotent", async () => {
  const f = await fixture();
  const p = await policy(f);
  const q = await policy(f, "rolling_days", {
    source: "short",
    rollingDays: 1,
    refundMinCompensationDays: 7,
  });
  await post(f, "100", undefined, { policyVersionId: q.id });
  await post(f, "100", undefined, { policyVersionId: p.id });
  const r = await rule(f);
  const order = await db.transaction((tx) =>
    reserveRedemption(tx, f, f.userId, r.id, "refund-test"),
  );
  await db.transaction((tx) => failRedemption(tx, f, order.id, "test"));
  await db.transaction((tx) => failRedemption(tx, f, order.id, "test"));
  const lots = (
    await db.query(
      "SELECT * FROM point_lots WHERE bot_id=$1 AND lot_type='refund_compensation'",
      [f.botId],
    )
  ).rows;
  assert.equal(lots.length, 2);
  assert.ok(lots.every((l) => l.refund_allocation_id));
  assert.equal(lots.filter((l) => l.expires_at === null).length, 1);
  await balance(f, "200");
});
test("partial refund explicitly rejected", async () => {
  const f = await fixture();
  await policy(f);
  await post(f, "100");
  const d = await post(f, "-100", undefined, {
    businessType: "redemption_debit",
  });
  await assert.rejects(
    () =>
      post(f, "40", undefined, {
        refundLedgerId: d.id,
        businessType: "redemption_refund",
        businessId: d.business_id,
      }),
    /unsupported_partial_refund/,
  );
});
test("legacy opening preserves balance and ledger, repeat creates zero", async () => {
  const f = await fixture(false);
  process.env.POINT_LOTS_ENABLED = "false";
  try {
    await post(f, "100");
    await post(f, "-20");
  } finally {
    process.env.POINT_LOTS_ENABLED = "true";
  }
  const before = await legacyPreflight(db, f);
  assert.equal(before.balance, "80");
  assert.equal(before.ready, true);
  assert.equal((await db.transaction((tx) => cutoverBot(tx, f))).openings, 1);
  assert.equal(
    (await db.transaction((tx) => cutoverBot(tx, f))).status,
    "already_cut_over",
  );
  await balance(f, "80");
  assert.equal((await legacyPreflight(db, f)).ledgerCount, 2);
});
test("no account read does not create account", async () => {
  const f = await fixture();
  assert.equal((await pointSummary(db, f)).accountExists, false);
  assert.equal((await legacyPreflight(db, f)).accounts, 0);
});
test("rolling duration is N times 24h across DST", () => {
  const at = new Date("2026-03-07T12:00:00-05:00");
  assert.equal(
    policyExpiry({ mode: "rolling_days", rolling_days: 2 }, at),
    new Date(at.getTime() + 172800000).toISOString(),
  );
});
test("maintenance write pause rejects all new points", async () => {
  const f = await fixture();
  process.env.POINT_WRITES_PAUSED = "true";
  try {
    await assert.rejects(() => post(f, "1"), /point_writes_paused/);
  } finally {
    delete process.env.POINT_WRITES_PAUSED;
  }
});
test("zero balance cutover creates no zero lot", async () => {
  const f = await fixture(false);
  process.env.POINT_LOTS_ENABLED = "false";
  try {
    await post(f, "10");
    await post(f, "-10");
  } finally {
    process.env.POINT_LOTS_ENABLED = "true";
  }
  assert.equal((await db.transaction((tx) => cutoverBot(tx, f))).openings, 0);
  assert.equal(
    (await db.query("SELECT id FROM point_lots WHERE bot_id=$1", [f.botId]))
      .rows.length,
    0,
  );
  await balance(f, "0");
});
test("cross-Bot explicit policy rejected", async () => {
  const a = await fixture(),
    b = await fixture();
  const p = await policy(b);
  await assert.rejects(
    () => post(a, "10", undefined, { policyVersionId: p.id }),
    /point_expiry_policy_required/,
  );
});
test("allocation cross-account rejected and entire transaction rolled back", async () => {
  const a = await fixture(),
    b = await fixture();
  await policy(a);
  await policy(b);
  await post(a, "100");
  await post(b, "100");
  const foreign = await one(db, "SELECT id FROM point_lots WHERE bot_id=$1", [
    b.botId,
  ]);
  await assert.rejects(() =>
    db.transaction(async (tx) => {
      const d = await postPoints(tx, event(a, "-10"));
      await tx.query(
        "INSERT INTO point_lot_allocations(brand_id,bot_id,account_id,negative_ledger_id,lot_id,amount,kind) VALUES($1,$2,$3,$4,$5,1,'consume')",
        [a.brandId, a.botId, d.account_id, d.id, foreign.id],
      );
    }),
  );
  await balance(a, "100");
  await balance(b, "100");
});
test("no double refund under concurrent callbacks", async () => {
  const f = await fixture();
  await policy(f);
  await post(f, "200");
  const r = await rule(f);
  const o = await db.transaction((tx) =>
    reserveRedemption(tx, f, f.userId, r.id, randomUUID()),
  );
  await Promise.all([
    db.transaction((tx) => failRedemption(tx, f, o.id, "test")),
    db.transaction((tx) => failRedemption(tx, f, o.id, "test")),
  ]);
  await balance(f, "200");
  assert.equal(
    (
      await db.query(
        "SELECT id FROM point_ledger WHERE bot_id=$1 AND business_type='redemption_refund'",
        [f.botId],
      )
    ).rows.length,
    1,
  );
});
test("assigned code still blocks automatic refund", async () => {
  const f = await fixture();
  await policy(f);
  await post(f, "200");
  const r = await rule(f);
  const o = await db.transaction((tx) =>
    reserveRedemption(tx, f, f.userId, r.id, randomUUID()),
  );
  await db.query(
    "INSERT INTO redemption_codes(brand_id,bot_id,rule_id,code_secret_ref,code_fingerprint) VALUES($1,$2,$3,$4,$5)",
    [f.brandId, f.botId, r.id, randomUUID(), randomUUID()],
  );
  await db.transaction((tx) => assignCode(tx, f, o.id));
  await assert.rejects(
    () => db.transaction((tx) => failRedemption(tx, f, o.id, "test")),
    /manual_reconciliation/,
  );
  await balance(f, "50");
});
for (const compensation of [null, 7])
  test(`expired allocation refund compensation ${compensation === null ? "requires review" : "has configured minimum"}`, async () => {
    const f = await fixture();
    await policy(f, "fixed_deadline", {
      deadline: new Date(Date.now() + 1300).toISOString(),
      refundMinCompensationDays: compensation,
    });
    await post(f, "200");
    const r = await rule(f);
    const o = await db.transaction((tx) =>
      reserveRedemption(tx, f, f.userId, r.id, randomUUID()),
    );
    await new Promise((r) => setTimeout(r, 1400));
    if (compensation === null) {
      await assert.rejects(
        () => db.transaction((tx) => failRedemption(tx, f, o.id, "test")),
        /refund_review_required/,
      );
      await balance(f, "50");
    } else {
      await Promise.all([
        expirePointsBatch(db),
        db.transaction((tx) => failRedemption(tx, f, o.id, "test")),
      ]);
      await balance(f, "150");
      const lot = await one(
        db,
        "SELECT * FROM point_lots WHERE bot_id=$1 AND lot_type='refund_compensation'",
        [f.botId],
      );
      assert.equal(
        new Date(lot.expires_at).getTime() - new Date(lot.granted_at).getTime(),
        7 * 86400000,
      );
    }
  });
test("legacy unfinished redemption classified; explicit legacy refund policy required", async () => {
  const f = await fixture(false);
  process.env.POINT_LOTS_ENABLED = "false";
  let order: any;
  try {
    await post(f, "200");
    const r = await rule(f);
    order = await db.transaction((tx) =>
      reserveRedemption(tx, f, f.userId, r.id, randomUUID()),
    );
  } finally {
    process.env.POINT_LOTS_ENABLED = "true";
  }
  const pre = await legacyPreflight(db, f);
  assert.equal(pre.unfinished, 1);
  assert.equal(pre.unclassified, 0);
  await db.transaction((tx) => cutoverBot(tx, f));
  await policy(f);
  await assert.rejects(
    () => db.transaction((tx) => failRedemption(tx, f, order.id, "test")),
    /legacy_refund_policy_required/,
  );
  await policy(f, "permanent", { source: "legacy_refund" });
  await db.transaction((tx) => failRedemption(tx, f, order.id, "test"));
  await balance(f, "200");
});
test("rollback after allocation restores all three accounting views", async () => {
  const f = await fixture();
  await policy(f);
  await post(f, "100");
  await assert.rejects(
    () =>
      db.transaction(async (tx) => {
        await postPoints(tx, event(f, "-60"));
        throw Error("rollback probe");
      }),
    /rollback probe/,
  );
  await balance(f, "100");
  assert.equal(
    (
      await db.query("SELECT id FROM point_lot_allocations WHERE bot_id=$1", [
        f.botId,
      ])
    ).rows.length,
    0,
  );
});
test("duplicate expiry workers produce one event; exhausted lots produce no zero event", async () => {
  const f = await fixture();
  await policy(f, "fixed_deadline", {
    deadline: new Date(Date.now() + 1300).toISOString(),
  });
  await post(f, "100");
  await post(f, "-50");
  await new Promise((r) => setTimeout(r, 1400));
  await Promise.all([expirePointsBatch(db), expirePointsBatch(db)]);
  await balance(f, "0");
  assert.equal(
    (
      await db.query(
        "SELECT id FROM point_ledger WHERE bot_id=$1 AND business_type='point_expired'",
        [f.botId],
      )
    ).rows.length,
    1,
  );
});
test("expiry competing with spend never spends expired lot", async () => {
  const f = await fixture();
  await policy(f, "fixed_deadline", {
    deadline: new Date(Date.now() + 1300).toISOString(),
  });
  await post(f, "100");
  await new Promise((r) => setTimeout(r, 1400));
  const results = await Promise.allSettled([
    expirePointsBatch(db),
    post(f, "-80"),
  ]);
  assert.equal(results[1]!.status, "rejected");
  await balance(f, "0");
});
test(
  "PG17 independent runtime LOGIN enforces minimum grants",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const { readFile } = await import("node:fs/promises");
    const role = "p5a_rt_" + randomUUID().replaceAll("-", "");
    const password = randomUUID();
    await db.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    let rt: ReturnType<typeof postgres> | undefined;
    try {
      await db.query(
        (await readFile("db/runtime-grants.sql", "utf8")).replaceAll(
          "telegram_app",
          role,
        ),
      );
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.username = role;
      url.password = password;
      rt = postgres(url.toString());
      const identity = await one(rt, "SELECT current_user,session_user");
      assert.equal(identity.current_user, role);
      assert.equal(identity.session_user, role);
      const f = await fixture();
      await policy(f);
      await rt.transaction((tx) => postPoints(tx, event(f, "100")));
      await rt.transaction((tx) => postPoints(tx, event(f, "-20")));
      await balance(f, "80");
      for (const sql of [
        "UPDATE point_accounts SET balance=0",
        "UPDATE point_ledger SET delta=1",
        "DELETE FROM point_ledger",
        "DELETE FROM point_lots",
        "TRUNCATE point_lots",
        "UPDATE audit_logs SET note='x'",
        "CREATE TABLE public.p5a_forbidden(id int)",
        "UPDATE point_expiry_policy_versions SET mode='permanent'",
        "UPDATE point_lots SET remaining_amount=0",
      ])
        await assert.rejects(() => rt!.query(sql), /permission denied/);
      const caps = await one(
        rt,
        `SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user`,
      );
      assert.ok(Object.values(caps).every((x) => x === false));
    } finally {
      await rt?.close();
      await db.query(`DROP OWNED BY ${role}`);
      await db.query(`DROP ROLE ${role}`);
    }
  },
);
test("admin expiry HTTP routes enforce RBAC and scope", async () => {
  const { createApp } = await import("../src/app.js");
  const f = await fixture(),
    other = await fixture();
  const app = createApp(
    db,
    () => undefined,
    async () => ({ adminId: f.adminId }),
  );
  const base = `/v1/brands/${f.brandId}/bots/${f.botId}/point-expiry`;
  try {
    assert.equal(
      (await app.inject({ url: base + "/policies" })).statusCode,
      403,
    );
    await db.query(
      "INSERT INTO admin_roles(admin_id,role_id,brand_id,bot_id) SELECT $1,id,$2,$3 FROM roles WHERE name='Super Admin'",
      [f.adminId, f.brandId, f.botId],
    );
    const p = await policy(f);
    await post(f, "100");
    const lot = await one(db, "SELECT id FROM point_lots WHERE bot_id=$1", [
      f.botId,
    ]);
    assert.equal(
      (await app.inject({ url: base + "/policies" })).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: base + "/lots" })).json().items.length,
      1,
    );
    const d = await app.inject({ url: base + "/lots/" + lot.id });
    assert.equal(d.statusCode, 200);
    assert.equal(d.json().reconciliation.consistent, true);
    assert.equal(
      (await app.inject({ url: base + "/accounts/" + other.userId }))
        .statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          url: `/v1/brands/${other.brandId}/bots/${other.botId}/point-expiry/policies`,
        })
      ).statusCode,
      403,
    );
    const wrong = await app.inject({
      method: "POST",
      url: base + "/policies/" + p.id + "/publish",
      payload: { confirm: false },
    });
    assert.equal(wrong.statusCode, 400);
  } finally {
    await app.close();
  }
});
test("fixed deadline local date converts to exclusive next midnight", async () => {
  const { normalizePolicy } = await import("../src/point-lots.js");
  const p = await normalizePolicy(db, {
    name: "TEST",
    source: "test",
    mode: "fixed_deadline",
    deadlineDate: "2026-12-31",
    timezone: "America/Sao_Paulo",
    effectiveAt: "2026-01-01T00:00:00Z",
  });
  assert.equal(p.deadline, "2027-01-01T03:00:00.000Z");
});
test("flag false after cutover stops writes but retains available-balance reads", async () => {
  const f = await fixture();
  await policy(f);
  await post(f, "40");
  process.env.POINT_LOTS_ENABLED = "false";
  try {
    assert.equal((await pointSummary(db, f)).availableBalance, "40");
    await assert.rejects(() => post(f, "1"), /point_writes_paused/);
  } finally {
    process.env.POINT_LOTS_ENABLED = "true";
  }
});
test("maintenance CLI refuses cutover and does not expose malformed connection input", async () => {
  const { spawnSync } = await import("node:child_process");
  const marker = "DO_NOT_PRINT_TEST_CONNECTION";
  for (const args of [[], ["--cutover"], ["--apply"], ["--expire", "extra"]]) {
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/point-maintenance-cli.ts", ...args],
      { env: { ...process.env, DATABASE_URL: marker }, encoding: "utf8" },
    );
    assert.equal(r.status, 1);
    assert.equal((r.stdout + r.stderr).includes(marker), false);
    assert.equal(JSON.parse(r.stderr.trim()).stage, "input");
  }
});
test(
  "PG17 current-lot and due-lot queries have usable partial indexes",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const f = await fixture();
    await policy(f);
    await post(f, "10");
    const a = await account(f);
    await db.transaction(async (tx) => {
      await tx.query("SET LOCAL enable_seqscan=off");
      const plan = (
        await tx.query(
          "EXPLAIN SELECT id FROM point_lots WHERE account_id=$1 AND remaining_amount>0 ORDER BY expires_at ASC NULLS LAST,granted_at,id",
          [a.id],
        )
      ).rows;
      assert.match(JSON.stringify(plan), /point_lot_fefo/);
      const due = (
        await tx.query(
          "EXPLAIN SELECT id FROM point_lots WHERE remaining_amount>0 AND expires_at<=statement_timestamp() ORDER BY expires_at LIMIT 50",
        )
      ).rows;
      assert.match(JSON.stringify(due), /point_lot_due/);
    });
  },
);
