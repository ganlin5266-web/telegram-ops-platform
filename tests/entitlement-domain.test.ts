import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calendarDay,
  decimalUnits,
  decideEntitlement,
  wallInstant,
  dateInZone,
  ruleInput,
  validateCalendar,
  inputFingerprint,
  type EvaluationInput,
} from "../src/entitlement-domain.js";
const input: EvaluationInput = {
  identityStatus: "verified",
  ruleAvailable: true,
  factPresent: true,
  completeness: "complete",
  metricAvailable: true,
  mappingCompatible: true,
  value: "100",
  factCurrency: "BRL",
  ruleCurrency: "BRL",
  cutoffReached: false,
  tiers: [
    { key: "tier_1", threshold: "100" },
    { key: "tier_2", threshold: "500" },
    { key: "tier_3", threshold: "1000" },
  ],
};
for (const [value, tier] of [
  ["0", null],
  ["99.99", null],
  ["100", "tier_1"],
  ["100.01", "tier_1"],
  ["499.99", "tier_1"],
  ["500", "tier_2"],
  ["500.01", "tier_2"],
  ["999.99", "tier_2"],
  ["1000", "tier_3"],
  ["1000.01", "tier_3"],
  ["1500", "tier_3"],
] as const)
  test("entitlement decimal boundary " + value, () => {
    const r = decideEntitlement({ ...input, value });
    assert.equal(r.matchedTier, tier);
    assert.equal(r.status, tier ? "eligible" : "ineligible");
  });
for (const [patch, status, reason] of [
  [{ identityStatus: null }, "pending", "waiting_for_identity"],
  [{ identityStatus: "revoked" }, "pending", "waiting_for_identity"],
  [{ identityStatus: "conflict" }, "review_required", "identity_conflict"],
  [{ ruleAvailable: false }, "pending", "rule_not_available"],
  [{ ruleConflict: true }, "review_required", "rule_conflict"],
  [{ factPresent: false }, "pending", "waiting_for_data"],
  [{ factPresent: false, cutoffReached: true }, "pending", "stale_data"],
  [{ value: null }, "pending", "metric_not_available"],
  [{ metricAvailable: false }, "pending", "metric_not_available"],
  [{ completeness: "incomplete" }, "pending", "incomplete_data"],
  [{ completeness: "unknown" }, "pending", "incomplete_data"],
  [{ completeness: "conflicting" }, "review_required", "conflicting_data"],
  [{ factCurrency: "USD" }, "review_required", "currency_mismatch"],
  [
    { mappingCompatible: false },
    "review_required",
    "mapping_semantics_conflict",
  ],
  [{ value: "-1" }, "review_required", "invalid_metric_value"],
] as const)
  test("entitlement quality " + reason + JSON.stringify(patch), () => {
    assert.deepEqual(decideEntitlement({ ...input, ...patch }), {
      status,
      reasonCode: reason,
      matchedTier: null,
    });
  });
test("entitlement highest tier independent of query order", () =>
  assert.equal(
    decideEntitlement({
      ...input,
      value: "700",
      tiers: [...input.tiers].reverse(),
    }).matchedTier,
    "tier_2",
  ));
test("decimal rejects float/scientific/inexact and keeps large precision", () => {
  assert.equal(
    decimalUnits("9999999999999999999999.999999"),
    9999999999999999999999999999n,
  );
  for (const v of ["1e2", "NaN", "1.0000001", "-1"])
    assert.throws(() => decimalUnits(v));
});
test("calendar leap/year boundaries", () => {
  assert.equal(calendarDay("2028-02-28", 1), "2028-02-29");
  assert.equal(calendarDay("2028-02-29", 1), "2028-03-01");
  assert.equal(calendarDay("2026-12-31", 1), "2027-01-01");
});
test("cutoff local time and DST use IANA not server timezone", () => {
  assert.equal(
    wallInstant("2026-09-27", "12:00", "America/Sao_Paulo"),
    "2026-09-27T15:00:00.000Z",
  );
  assert.equal(
    wallInstant("2026-03-08", "12:00", "America/New_York"),
    "2026-03-08T16:00:00.000Z",
  );
  assert.throws(() => wallInstant("2026-03-08", "02:30", "America/New_York"));
  assert.throws(() => wallInstant("2026-11-01", "01:30", "America/New_York"));
  assert.equal(
    dateInZone(new Date("2026-09-27T01:00:00Z"), "America/Sao_Paulo"),
    "2026-09-26",
  );
});
test("fingerprint stable across object key order, new fact revision changes evidence", () => {
  assert.equal(
    inputFingerprint({ a: 1, b: 2 }),
    inputFingerprint({ b: 2, a: 1 }),
  );
  assert.notEqual(
    inputFingerprint({ revision: "1", value: "600" }),
    inputFingerprint({ revision: "2", value: "600" }),
  );
});
const rule = {
  platformId: "11111111-1111-4111-8111-111111111111",
  mappingBatchId: "11111111-1111-4111-8111-111111111112",
  name: "STAGING TEST ONLY",
  metric: "deposit_amount",
  operator: ">=",
  currency: "BRL",
  sourceTimezone: "America/Sao_Paulo",
  entitlementTimezone: "America/Sao_Paulo",
  cutoffTime: "12:00",
  effectiveFrom: "2026-09-27",
  effectiveUntil: "2026-10-01",
  tiers: input.tiers.map((t) => ({ ...t, name: t.key })),
};
test("rule limits metrics, operators, duplicate tiers and ordering", () => {
  ruleInput.parse(rule);
  for (const patch of [
    { metric: "bet_amount" },
    { operator: ">" },
    { tiers: [...rule.tiers].reverse() },
    { tiers: [rule.tiers[0], rule.tiers[0]] },
  ])
    assert.equal(ruleInput.safeParse({ ...rule, ...patch }).success, false);
});
test("publish validates timezone cutoff across whole bounded range", () => {
  validateCalendar(ruleInput.parse(rule));
  assert.throws(() =>
    validateCalendar(
      ruleInput.parse({
        ...rule,
        sourceTimezone: "Pacific/Honolulu",
        entitlementTimezone: "Pacific/Kiritimati",
      }),
    ),
  );
});
