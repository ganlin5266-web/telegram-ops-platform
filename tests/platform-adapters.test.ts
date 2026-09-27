import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adapterDefinition,
  mappingSnapshot,
  normalizeAdapterRow,
  scaleMoney,
  parseAdapterDate,
} from "../src/platform-adapters.js";
const a = adapterDefinition("player-report-minor-units", "1");
const p = {
  timezone: "America/Sao_Paulo",
  currency: "BRL",
  uid_format: "alphanumeric",
  uid_case: "upper",
  uid_min_length: 1,
  uid_max_length: 64,
};
const row = (over: Record<string, string> = {}) => ({
  "玩家id ": "1500",
  当日充值: "1500",
  当日充值次数: "1500",
  玩家首充日期: "1900-01-01 00:00:00",
  玩家首充金額: "0",
  ...over,
});
const n = (over: Record<string, string> = {}) =>
  normalizeAdapterRow(row(over), a, p, 2);
for (const [raw, expected] of [
  ["1500", "15.000000"],
  ["100", "1.000000"],
  ["1", "0.010000"],
  ["0", "0.000000"],
  ["", ""],
  ["-1500", "-15.000000"],
  ["1.5", "0.015000"],
  ["999999999999999999999999", "9999999999999999999999.990000"],
])
  test(`adapter Decimal ${raw || "NULL"}`, () =>
    assert.equal(scaleMoney(raw!, "100"), expected || null));
test("money invalid and precision loss fail rather than rounding", () => {
  for (const s of ["abc", "1e3", "NaN", "1,500", "0.0000001"])
    assert.throws(() => scaleMoney(s, "100"));
  assert.throws(() => scaleMoney("1", "3"));
});
test("player ID and count are not scaled", () => {
  const v = n().normalized;
  assert.equal(v.uid, "1500");
  assert.equal(v.deposit_count, "1500");
  assert.equal(v.deposit, "15.000000");
});
test("first deposit sentinel zero is false, not a 1900 fact", () => {
  const v = n().normalized;
  assert.equal(v.first_deposit_date, null);
  assert.equal(v.first_deposit, "0.000000");
  assert.equal(v.derived.has_first_deposit, false);
});
for (const [date, amount, expected, warn] of [
  ["1900-01-01 00:00:00", "100", null, true],
  ["2026-09-20 00:00:00", "100", true, false],
  ["2026-09-20 00:00:00", "", null, true],
  ["2026-09-20 00:00:00", "0", null, true],
] as const)
  test(`first deposit cross check ${date} ${amount}`, () => {
    const v = n({ 玩家首充日期: date, 玩家首充金額: amount });
    assert.equal(v.normalized.derived.has_first_deposit, expected);
    assert.equal(
      v.issues.some((i) => i.code === "first_deposit_inconsistent"),
      warn,
    );
  });
test("sentinel applies only to declared field; recent deposit semantics remain unknown", () => {
  const v = n({ 最近存款時間: "1900-01-01 00:00:00" });
  assert.equal(v.normalized.extensions.last_deposit_at.value, null);
  assert.equal(
    v.normalized.extensions.last_deposit_at.semanticStatus,
    "unconfirmed",
  );
  assert.ok(v.issues.some((i) => i.code === "unconfirmed_sentinel_semantics"));
});
test("optional missing is NULL, explicit zero stays zero", () => {
  assert.equal(n().normalized.withdrawal, null);
  assert.equal(n({ 当日提现: "0" }).normalized.withdrawal, "0.000000");
});
test("money-only field override and 1000 divisor", () => {
  const copy = structuredClone(a);
  copy.fields.find((f) => f.target === "deposit")!.divisor = "1";
  assert.equal(
    normalizeAdapterRow(row(), copy, p, 2).normalized.deposit,
    "1500.000000",
  );
  assert.equal(scaleMoney("1500", "1000"), "1.500000");
});
test("schema ignores order, requires declared ID and rejects unknown headers", () => {
  const h = Object.keys(row()),
    x = mappingSnapshot(a, h, "platform", "csv", p.timezone, p.currency);
  assert.equal(
    x.schemaFingerprint,
    mappingSnapshot(
      a,
      [...h].reverse(),
      "platform",
      "csv",
      p.timezone,
      p.currency,
    ).schemaFingerprint,
  );
  assert.throws(() =>
    mappingSnapshot(
      a,
      h.filter((h) => h !== "玩家id "),
      "p",
      "csv",
      p.timezone,
      p.currency,
    ),
  );
  assert.throws(() =>
    mappingSnapshot(
      a,
      [...h, "UnknownMoney"],
      "p",
      "csv",
      p.timezone,
      p.currency,
    ),
  );
});
test("mapping returns detached definitions, not mutable global rules", () => {
  const x = adapterDefinition(a.id, a.version);
  x.defaultMoneyDivisor = "1";
  assert.equal(adapterDefinition(a.id, a.version).defaultMoneyDivisor, "100");
  assert.throws(() => adapterDefinition(a.id, "unknown"));
});
test("date parsing explicit and source timezone independent", () => {
  assert.equal(
    parseAdapterDate("26/09/2026 15:30:00", "dmy", p.timezone),
    "2026-09-26T18:30:00.000Z",
  );
  assert.equal(
    parseAdapterDate("09/26/2026", "mdy", p.timezone, true),
    "2026-09-26",
  );
  assert.equal(
    parseAdapterDate("46291", "excel_serial", p.timezone, true),
    "2026-09-26",
  );
  for (const v of ["2026-02-30 12:00:00", "2026-09-26 25:00:00"])
    assert.throws(() => parseAdapterDate(v, "local", p.timezone));
  assert.throws(() =>
    parseAdapterDate("2026-11-01 01:30:00", "local", "America/New_York"),
  );
  assert.throws(() =>
    parseAdapterDate("2026-03-08 02:30:00", "local", "America/New_York"),
  );
});
test("invalid date/amount/required value fatal", () => {
  for (const over of [
    { 玩家首充日期: "bad" },
    { 当日充值: "bad" },
    { "玩家id ": "" },
  ])
    assert.ok(
      n(over as unknown as Record<string, string>).issues.some(
        (i) => i.severity === "fatal",
      ),
    );
});
test("third schema separate names, missing metrics and explicit dates", () => {
  const m = adapterDefinition("synthetic-mx", "1");
  const v = normalizeAdapterRow(
    {
      Player: "TEST_USER_001",
      "Deposit MXN": "15.00",
      "Bet Reported": "20",
      Joined: "26/09/2026 12:00:00",
      "First date": "25/09/2026",
      "First amount": "1",
    },
    m,
    { ...p, timezone: "America/Mexico_City", currency: "MXN" },
    2,
  );
  assert.equal(v.normalized.withdrawal, null);
  assert.equal(v.normalized.payout, null);
  assert.equal(v.normalized.deposit, "15.000000");
  assert.equal(v.normalized.registered_at, "2026-09-26T18:00:00.000Z");
  assert.equal(v.normalized.derived.has_first_deposit, true);
});
test("unconfirmed wagering semantics never silently map to core", () => {
  const v = n({ 当日投注: "1500", 当日返奖: "100", 当日盈亏: "-100" });
  assert.equal(v.normalized.bet, null);
  assert.equal(v.normalized.payout, null);
  assert.equal(v.normalized.game_profit, null);
  assert.equal(v.normalized.extensions.reported_daily_bet.value, "15.000000");
});

test("published mapping definitions are frozen: change requires new version", async () => {
  const { digest, stable } = await import("../src/platform-data-input.js");
  assert.equal(
    digest(stable(adapterDefinition("player-report-minor-units", "1"))),
    "ecd948bb8aa4e22eeab6efb7c97c8c35c814d98c7bd70e5099d9f10bf4866174",
  );
  assert.equal(
    digest(stable(adapterDefinition("synthetic-mx", "1"))),
    "9be005495b29fac508084199bcecf4fc76afa93d3fd9da1d0e2980501f94681e",
  );
});
