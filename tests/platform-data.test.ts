import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import ExcelJS from "exceljs";
import {
  postgres,
  one,
  type Database,
  type Queryable,
  DomainError,
} from "../src/db.js";
import { migrate } from "../src/migrations.js";
import {
  createPlatform,
  submitIdentity,
  reviewIdentity,
} from "../src/platform-identities.js";
import {
  preflightImport,
  activateImport,
  miniDataStatus,
} from "../src/platform-data.js";
import {
  fields,
  decimal,
  businessDate,
  importInput,
  parseFile,
  normalizeRow,
} from "../src/platform-data-input.js";
import { createApp } from "../src/app.js";
let db: Database, close: () => Promise<void>;
const adapt = (p: any): Queryable => ({
  query: async (s, a) =>
    a === undefined
      ? ((await p.exec(s)).at(-1) ?? { rows: [] })
      : p.query(s, a),
});
before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    const p = postgres(process.env.TEST_DATABASE_URL);
    db = p;
    close = p.close;
  } else {
    const p = new PGlite();
    db = { ...adapt(p), transaction: (f) => p.transaction((t) => f(adapt(t))) };
    close = () => p.close();
  }
  await migrate(db);
});
after(async () => close());
async function fixture() {
  const b = await one(
    db,
    "INSERT INTO brands(name,slug,default_language) VALUES('P4 Test',$1,'en') RETURNING id",
    [randomUUID()],
  );
  const bot = await one(
    db,
    "INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status) VALUES($1,'P4 Test',$2,$3,$4,'en',ARRAY['en'],'disabled') RETURNING id",
    [b.id, randomUUID(), "TEST_" + randomUUID(), "TEST_" + randomUUID()],
  );
  const admin = await one(
    db,
    "INSERT INTO admins(auth_subject,display_name) VALUES($1,'P4 Reviewer') RETURNING id",
    [randomUUID()],
  );
  await db.query(
    "INSERT INTO admin_roles(admin_id,role_id) SELECT $1,id FROM roles WHERE name='Super Admin'",
    [admin.id],
  );
  const s = { brandId: b.id, botId: bot.id },
    p = { adminId: admin.id };
  const platform = await createPlatform(
    db,
    p,
    s,
    {
      code: "P4_TEST",
      displayName: "Synthetic",
      market: "BR",
      timezone: "America/Sao_Paulo",
      currency: "BRL",
      verificationMethod: "manual_admin",
      uidFormat: "alphanumeric",
      uidCase: "upper",
      uidMinLength: 1,
      uidMaxLength: 64,
    },
    "p4",
  );
  const u = await one(
    db,
    "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,900001) RETURNING id",
    [b.id, bot.id],
  );
  // Identity Service does not require Telegram network; this is disposable local test data.
  const ident = await submitIdentity(
    db,
    {
      ...s,
      userId: u.id,
      sessionId: randomUUID(),
      appKey: "test",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
    platform.id,
    "BRTEST10001",
    randomUUID(),
    "p4",
  );
  await reviewIdentity(
    db,
    p,
    s,
    ident.id,
    { action: "verify", evidenceReference: "CASE-P4-SYNTHETIC" },
    "p4",
  );
  const input = (
    rows: Record<string, string>[] = [
      row("BRTEST10001"),
      row("BRTEST_UNKNOWN01"),
    ],
    over: Record<string, unknown> = {},
  ) => ({
    platformId: platform.id,
    businessDate: "2026-09-26",
    timezone: "America/Sao_Paulo",
    currency: "BRL",
    sourceType: "csv",
    filename: "STAGING-SYNTHETIC.csv",
    fileBase64: Buffer.from(
      [
        fields.join(","),
        ...rows.map((r) => fields.map((k) => r[k] ?? "").join(",")),
      ].join("\n"),
    ).toString("base64"),
    mapping: Object.fromEntries(fields.map((k) => [k, k])),
    coverage: { kind: "full", filter: "" },
    completeness: "complete",
    replacement: false,
    reason: "STAGING SYNTHETIC",
    ...over,
  });
  const pre = (v: unknown = input()) => preflightImport(db, p, s, v, "p4");
  const activate = (id: string, review = false) =>
    activateImport(db, p, s, id, review, "p4");
  return { s, p, platform, u, ident, input, pre, activate };
}
function row(uid: string, extra: Record<string, string> = {}) {
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
    gift: "0",
    withdrawal: "30.00",
    source_net: "70.00",
    bet: "250",
    payout: "230",
    game_profit: "-20",
    first_deposit_date: "2026-09-20",
    first_deposit: "50",
    ...extra,
  };
}
const error = (c: string) => (e: unknown) =>
  e instanceof DomainError && e.code === c;
async function facts(f: any) {
  return (
    await db.query(
      "SELECT f.id,f.current_revision_id,r.*,f.business_date::text AS business_date FROM platform_user_daily_facts f JOIN platform_user_daily_fact_revisions r ON r.id=f.current_revision_id WHERE f.brand_id=$1 ORDER BY f.id",
      [f.s.brandId],
    )
  ).rows;
}

test("P4 dates explicit real calendar; Decimal exact and no rounding", () => {
  assert.equal(businessDate("2026-02-30"), false);
  assert.equal(decimal("0.1"), "0.100000");
  assert.equal(decimal("0"), "0.000000");
  assert.equal(decimal(""), null);
  assert.throws(() => decimal("1,000"));
  assert.throws(() => decimal("0.1234567"));
  assert.equal(decimal("-20"), "-20.000000");
});
test("P4 missing date and invalid metadata rejected without upload", async () => {
  const f = await fixture();
  for (const v of [
    { businessDate: undefined },
    { businessDate: "2026-02-30" },
    { timezone: "UTC" },
    { currency: "USD" },
    { coverage: undefined },
  ])
    await assert.rejects(() => f.pre(f.input(undefined, v)));
  assert.equal(
    (
      await db.query(
        "SELECT id FROM platform_import_batches WHERE brand_id=$1",
        [f.s.brandId],
      )
    ).rows.length,
    0,
  );
});
test("P4 preflight persists evidence only; complete activate known and unknown account without TG/rewards", async () => {
  const f = await fixture(),
    b = await f.pre();
  assert.equal(b.status, "ready");
  assert.equal((await facts(f)).length, 0);
  assert.equal(
    (
      await db.query("SELECT id FROM platform_accounts WHERE brand_id=$1", [
        f.s.brandId,
      ])
    ).rows.length,
    0,
  );
  await f.activate(b.id);
  const r = await facts(f);
  assert.equal(r.length, 2);
  assert.equal(r.filter((x) => x.identity_id).length, 1);
  assert.equal(r.find((x) => x.identity_id)?.identity_id, f.ident.id);
  assert.equal(
    (
      await db.query("SELECT id FROM telegram_users WHERE brand_id=$1", [
        f.s.brandId,
      ])
    ).rows.length,
    1,
  );
  for (const t of [
    "point_accounts",
    "point_ledger",
    "referrals",
    "redemptions",
    "redemption_codes",
  ])
    assert.equal(
      (
        await db.query("SELECT id FROM " + t + " WHERE brand_id=$1", [
          f.s.brandId,
        ])
      ).rows.length,
      0,
    );
});
test("P4 duplicate upload and activation are idempotent with no audit noise", async () => {
  const f = await fixture(),
    b = await f.pre();
  assert.equal((await f.pre()).id, b.id);
  await f.activate(b.id);
  assert.equal((await f.activate(b.id)).duplicate, true);
  assert.equal(
    (
      await db.query(
        "SELECT id FROM platform_user_daily_fact_revisions WHERE brand_id=$1",
        [f.s.brandId],
      )
    ).rows.length,
    2,
  );
  assert.equal(
    (
      await db.query(
        "SELECT id FROM audit_logs WHERE brand_id=$1 AND action='platform_data.activate'",
        [f.s.brandId],
      )
    ).rows.length,
    1,
  );
  await assert.rejects(
    () => f.pre(f.input(undefined, { completeness: "unknown" })),
    error("duplicate_metadata_conflict"),
  );
});
test("P4 duplicate canonical UID rows fatal, never sum", async () => {
  const f = await fixture(),
    b = await f.pre(f.input([row("BRTEST10001"), row(" brtest10001 ")]));
  assert.equal(b.status, "rejected");
  await assert.rejects(() => f.activate(b.id), error("batch_not_approved"));
  assert.equal((await facts(f)).length, 0);
});
test("P4 missing UID column mapping fails; empty UID row rejected", async () => {
  const f = await fixture();
  await assert.rejects(
    () => f.pre(f.input(undefined, { mapping: { deposit: "deposit" } })),
    error("explicit_mapping_invalid"),
  );
  const b = await f.pre(f.input([row("")]));
  assert.equal(b.status, "rejected");
});
test("P4 NULL stays NULL and explicit zero stays Decimal zero; login date does not select business day", async () => {
  const f = await fixture(),
    b = await f.pre(
      f.input([
        row("BRTEST10001", { gift: "", withdrawal: "0", source_net: "100" }),
      ]),
    );
  await f.activate(b.id);
  const r = (await facts(f))[0]!;
  assert.equal(r.gift, null);
  assert.equal(Number(r.withdrawal), 0);
  assert.equal(r.normalized.gift, null);
  assert.equal(r.normalized.withdrawal, "0.000000");
  assert.equal(r.normalized.login_time, "2026-09-26T02:50:00.000Z");
  assert.equal(
    new Date(r.business_date).toISOString().slice(0, 10),
    "2026-09-26",
  );
});
test("P4 invalid money and date rows fatal; source net warning never overwritten", async () => {
  const f = await fixture();
  for (const extra of [
    { deposit: "oops" },
    { first_deposit_date: "2026-02-30" },
    { login_time: "2026-09-26 15:30" },
  ] as Record<string, string>[]) {
    const b = await f.pre(
      f.input([row("BRTEST10001", extra as Record<string, string>)]),
    );
    assert.equal(b.status, "rejected");
  }
  const b = await f.pre(f.input([row("BRTEST10001", { source_net: "69" })]));
  assert.equal(b.status, "ready");
  await f.activate(b.id);
  assert.equal((await facts(f))[0]!.normalized.source_net, "69.000000");
  const e = await one(
    db,
    "SELECT issues FROM platform_import_batches WHERE id=$1",
    [b.id],
  );
  assert(e.issues.some((x: any) => x.code === "source_net_mismatch"));
});
test("P4 replacement immutable revision, atomic current, superseded original", async () => {
  const f = await fixture(),
    b = await f.pre();
  await f.activate(b.id);
  const next = await f.pre(
    f.input(
      [
        row("BRTEST10001", { deposit: "120", source_net: "90" }),
        row("BRTEST_UNKNOWN01", { deposit: "120", source_net: "90" }),
      ],
      { replacement: true, reason: "STAGING SYNTHETIC correction" },
    ),
  );
  await f.activate(next.id);
  const r = await facts(f);
  assert(r.every((x) => x.data_version === 2 && x.supersedes));
  assert.equal(
    (
      await one(db, "SELECT status FROM platform_import_batches WHERE id=$1", [
        b.id,
      ])
    ).status,
    "superseded",
  );
  assert.equal(
    (
      await db.query(
        "SELECT id FROM platform_user_daily_fact_revisions WHERE brand_id=$1",
        [f.s.brandId],
      )
    ).rows.length,
    4,
  );
  await assert.rejects(() =>
    db.query(
      "UPDATE platform_user_daily_fact_revisions SET reason=$1 WHERE id=$2",
      ["changed", r[0]!.id],
    ),
  );
  await assert.rejects(() =>
    db.query("DELETE FROM platform_import_evidence WHERE batch_id=$1", [b.id]),
  );
});
test("P4 conflict requires explicit review; stale preflight rollback", async () => {
  const f = await fixture();
  await f.activate((await f.pre()).id);
  const b = await f.pre(
    f.input([row("BRTEST10001", { deposit: "101" }), row("BRTEST_UNKNOWN01")]),
  );
  assert.equal(b.status, "review_required");
  await assert.rejects(() => f.activate(b.id), error("batch_not_approved"));
  const c = await f.pre(
    f.input([row("BRTEST10001", { deposit: "102" }), row("BRTEST_UNKNOWN01")], {
      replacement: true,
    }),
  );
  await f.activate(c.id);
  await assert.rejects(() => f.activate(b.id, true), error("preflight_stale"));
  assert.equal(
    (
      await one(db, "SELECT status FROM platform_import_batches WHERE id=$1", [
        b.id,
      ])
    ).status,
    "review_required",
  );
});
test("P4 approved review produces review audit", async () => {
  const f = await fixture();
  await f.activate((await f.pre()).id);
  const b = await f.pre(
    f.input([row("BRTEST10001", { deposit: "103" }), row("BRTEST_UNKNOWN01")]),
  );
  await f.activate(b.id, true);
  assert.equal(
    (
      await db.query(
        "SELECT id FROM audit_logs WHERE object_id=$1 AND action='platform_data.review'",
        [b.id],
      )
    ).rows.length,
    1,
  );
});
test("P4 incomplete then late complete keeps fact ID and creates revision", async () => {
  const f = await fixture(),
    b = await f.pre(
      f.input([row("BRTEST10001", { deposit: "" })], {
        completeness: "incomplete",
      }),
    );
  await f.activate(b.id);
  const old = (await facts(f))[0]!;
  const c = await f.pre(f.input([row("BRTEST10001")], { replacement: true }));
  await f.activate(c.id);
  const latest = (await facts(f))[0]!;
  assert.equal(latest.fact_id, old.fact_id);
  assert.equal(latest.data_version, 2);
});
test("P4 completeness defaults unknown; full replacement cannot omit current accounts or change coverage", async () => {
  const f = await fixture();
  assert.equal(
    importInput.parse({ ...f.input(), completeness: undefined }).completeness,
    "unknown",
  );
  await f.activate((await f.pre()).id);
  const b = await f.pre(
    f.input([row("BRTEST10001", { deposit: "101" })], { replacement: true }),
  );
  assert.equal(b.status, "rejected");
  const c = await f.pre(
    f.input([row("BRTEST10001", { deposit: "102" })], {
      coverage: { kind: "filtered", filter: "x" },
      replacement: true,
    }),
  );
  assert.equal(c.status, "rejected");
});
test("P4 identical values new file do not create additive revisions", async () => {
  const f = await fixture();
  await f.activate((await f.pre()).id);
  const v = f.input();
  v.fileBase64 = Buffer.from(
    Buffer.from(v.fileBase64, "base64").toString() + "\n",
  ).toString("base64");
  const b = await f.pre(v);
  await f.activate(b.id);
  assert.equal(
    (
      await db.query(
        "SELECT id FROM platform_user_daily_fact_revisions WHERE brand_id=$1",
        [f.s.brandId],
      )
    ).rows.length,
    2,
  );
});
test("P4 Mini safe summary only own verified snapshot, no financial fields, no historical transfer", async () => {
  const f = await fixture();
  assert.equal(
    (await miniDataStatus(db, { ...f.s, userId: f.u.id })).items[0]?.latestDate,
    null,
  );
  await f.activate((await f.pre()).id);
  const summary = await miniDataStatus(db, { ...f.s, userId: f.u.id });
  assert.equal(summary.items[0]?.latestDate, "2026-09-26");
  assert(!JSON.stringify(summary).includes("deposit"));
  assert(!JSON.stringify(summary).includes("BRTEST"));
  await reviewIdentity(
    db,
    f.p,
    f.s,
    f.ident.id,
    { action: "revoke", reasonCode: "user_request" },
    "p4",
  );
  assert.equal(
    (await miniDataStatus(db, { ...f.s, userId: f.u.id })).items.length,
    0,
  );
  const other = await one(
    db,
    "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,900002) RETURNING id",
    [f.s.brandId, f.s.botId],
  );
  const ident = await submitIdentity(
    db,
    {
      ...f.s,
      userId: other.id,
      sessionId: randomUUID(),
      appKey: "test",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
    f.platform.id,
    "BRTEST10001",
    randomUUID(),
    "p4",
  );
  await reviewIdentity(
    db,
    f.p,
    f.s,
    ident.id,
    { action: "verify", evidenceReference: "CASE-P4-NEW" },
    "p4",
  );
  assert.equal(
    (await miniDataStatus(db, { ...f.s, userId: other.id })).items[0]
      ?.latestDate,
    null,
  );
});
test("P4 strict XLSX parser supports synthetic workbook; formulas rejected", async () => {
  const f = await fixture(),
    w = new ExcelJS.Workbook(),
    s = w.addWorksheet("Synthetic");
  s.addRow([...fields]);
  s.addRow(fields.map((k) => (row("BRTEST10001") as any)[k] ?? ""));
  const v = f.input(undefined, {
    sourceType: "xlsx",
    filename: "synthetic.xlsx",
    fileBase64: Buffer.from(await w.xlsx.writeBuffer()).toString("base64"),
  });
  const b = await f.pre(v);
  assert.equal(b.status, "ready");
  s.getCell("A2").value = { formula: "1+1", result: 2 };
  await assert.rejects(
    async () =>
      f.pre({
        ...v,
        fileBase64: Buffer.from(await w.xlsx.writeBuffer()).toString("base64"),
      }),
    error("xlsx_text_or_number_required"),
  );
});
test("P4 raw evidence exact row and digest retained; audit excludes UID and raw values", async () => {
  const f = await fixture(),
    b = await f.pre();
  await f.activate(b.id);
  const e = await one(
    db,
    "SELECT * FROM platform_import_evidence WHERE batch_id=$1 ORDER BY row_number",
    [b.id],
  );
  assert.equal(e.row_number, 2);
  assert.equal(e.raw_values.deposit, "100.00");
  assert.equal(e.normalized.deposit, "100.000000");
  assert.match(e.row_digest, /^[a-f0-9]{64}$/);
  const a = (
    await db.query("SELECT * FROM audit_logs WHERE brand_id=$1", [f.s.brandId])
  ).rows;
  assert(!JSON.stringify(a).includes("BRTEST10001"));
  assert(!JSON.stringify(a).includes("100.000000"));
});
test("P4 API RBAC, Brand/platform scope and explicit raw evidence access", async () => {
  const f = await fixture(),
    g = await fixture(),
    b = await f.pre();
  const app = createApp(
    db,
    () => undefined,
    async () => f.p,
  );
  await app.ready();
  try {
    const base = `/v1/brands/${f.s.brandId}/bots/${f.s.botId}/platform-data`;
    assert.equal(
      (await app.inject({ url: base + "/batches?platformId=" + f.platform.id }))
        .statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: base + "/batches/" + (await g.pre()).id }))
        .statusCode,
      404,
    );
    const e = await one(
      db,
      "SELECT id FROM platform_import_evidence WHERE batch_id=$1",
      [b.id],
    );
    assert.equal(
      (
        await app.inject({
          url: base + "/batches/" + b.id + "/evidence/" + e.id,
        })
      ).statusCode,
      200,
    );
    await db.query("DELETE FROM admin_roles WHERE admin_id=$1", [f.p.adminId]);
    assert.equal(
      (await app.inject({ url: base + "/batches/" + b.id })).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: base + "/preflight",
          payload: f.input(),
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});
test("P4 cross Platform request cannot reuse another platform batch or identity", async () => {
  const f = await fixture(),
    g = await fixture();
  await assert.rejects(
    () => f.pre({ ...f.input(), platformId: g.platform.id }),
    error("not_found"),
  );
  const b = await g.pre();
  await assert.rejects(() => f.activate(b.id), error("not_found"));
});
test("P4 runtime minimal grants and transaction rollback", async () => {
  const f = await fixture();
  await db.query(
    "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='telegram_app') THEN CREATE ROLE telegram_app NOLOGIN; END IF; END $$",
  );
  await db.query(await readFile("db/runtime-grants.sql", "utf8"));
  const runtime: Database = {
    query: (s, a) =>
      db.transaction(async (t) => {
        await t.query("SET LOCAL ROLE telegram_app");
        return t.query(s, a);
      }),
    transaction: (fn) =>
      db.transaction(async (t) => {
        await t.query("SET LOCAL ROLE telegram_app");
        return fn(t);
      }),
  };
  const b = await preflightImport(runtime, f.p, f.s, f.input(), "p4");
  await activateImport(runtime, f.p, f.s, b.id, false, "p4");
  for (const t of [
    "platform_accounts",
    "platform_import_batches",
    "platform_import_evidence",
    "platform_user_daily_facts",
    "platform_user_daily_fact_revisions",
  ]) {
    const r = await one(
      db,
      "SELECT has_table_privilege('telegram_app',$1,'DELETE') AS d,has_table_privilege('telegram_app',$1,'TRUNCATE') AS t",
      [t],
    );
    assert.equal(r.d, false);
    assert.equal(r.t, false);
  }
  const bad = await f.pre(
    f.input(
      [
        row("BRTEST10001", { deposit: "102" }),
        row("BRTEST_UNKNOWN01", { deposit: "103" }),
      ],
      { replacement: true },
    ),
  );
  const crash: Database = {
    ...db,
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          query: async (s, a) => {
            if (s.includes("SET current_revision_id"))
              throw new DomainError("injected_failure");
            return tx.query(s, a);
          },
        }),
      ),
  };
  await assert.rejects(() =>
    activateImport(crash, f.p, f.s, bad.id, false, "p4"),
  );
  assert((await facts(f)).every((r) => r.data_version === 1));
  assert.equal(
    (
      await one(db, "SELECT status FROM platform_import_batches WHERE id=$1", [
        bad.id,
      ])
    ).status,
    "ready",
  );
});
test(
  "P4 concurrent activation has one current revision and single activation audit",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const f = await fixture(),
      b = await f.pre();
    await Promise.all([f.activate(b.id), f.activate(b.id)]);
    assert.equal((await facts(f)).length, 2);
    assert.equal(
      (
        await db.query(
          "SELECT id FROM audit_logs WHERE object_id=$1 AND action='platform_data.activate'",
          [b.id],
        )
      ).rows.length,
      1,
    );
  },
);

test("P4 Bot-only permission cannot access Brand-wide platform facts", async () => {
  const f = await fixture();
  await db.query(
    "UPDATE admin_roles SET brand_id=$2,bot_id=$3 WHERE admin_id=$1",
    [f.p.adminId, f.s.brandId, f.s.botId],
  );
  await assert.rejects(() => f.pre(), error("forbidden"));
  const app = createApp(
    db,
    () => undefined,
    async () => f.p,
  );
  try {
    await app.ready();
    const r = await app.inject({
      url: `/v1/brands/${f.s.brandId}/bots/${f.s.botId}/platform-data/facts?platformId=${f.platform.id}`,
    });
    assert.equal(r.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("P4 filtered complete batch cannot claim whole-day freshness", async () => {
  const f = await fixture();
  const b = await f.pre({
    ...f.input(),
    coverage: { kind: "filtered", filter: "STAGING SYNTHETIC subset" },
    completeness: "complete",
  });
  await f.activate(b.id);
  const app = createApp(
    db,
    () => undefined,
    async () => f.p,
  );
  try {
    await app.ready();
    const r = await app.inject({
      url: `/v1/brands/${f.s.brandId}/bots/${f.s.botId}/platform-data/batches?platformId=${f.platform.id}&businessDate=2026-09-26`,
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().freshness.complete_active, false);
  } finally {
    await app.close();
  }
});
