import { test } from "node:test";
import assert from "node:assert/strict";
import {
  legacyApproval,
  mappingApproval,
  resolveMappingSemantics,
} from "../src/entitlement-mapping.js";
import { fields, digest, stable } from "../src/platform-data-input.js";
function fixture(
  value: string | null = "100.010000",
  completeness = "complete",
) {
  const b: any = {
    id: "b",
    brand_id: "brand",
    platform_id: "p",
    business_date: "2026-09-26",
    timezone: "America/Sao_Paulo",
    currency: "BRL",
    source_type: "csv",
    mapping: { uid: "UID", deposit: "Amount" },
    mapping_digest: "0".repeat(64),
    coverage: { kind: "full", filter: "" },
    completeness,
    replacement: false,
    reason: "SYNTHETIC",
    row_count: 1,
  };
  b.metadata_digest = digest(
    stable({
      platformId: b.platform_id,
      businessDate: b.business_date,
      timezone: b.timezone,
      currency: b.currency,
      sourceType: b.source_type,
      mapping: b.mapping,
      coverage: b.coverage,
      completeness: b.completeness,
      replacement: b.replacement,
      reason: b.reason,
    }),
  );
  b.scope_digest = digest(
    stable({
      coverage: b.coverage,
      timezone: b.timezone,
      currency: b.currency,
    }),
  );
  const n: any = Object.fromEntries(fields.map((k) => [k, null]));
  n.uid = "SYNTHETIC";
  n.deposit = value;
  const e: any = {
    id: "e",
    brand_id: "brand",
    platform_id: "p",
    business_date: b.business_date,
    batch_id: "b",
    raw_values: { UID: "SYNTHETIC", Amount: value ?? "" },
    normalized: n,
    issues: [],
  };
  e.row_digest = digest(stable(e.raw_values));
  const r: any = {
    id: "r",
    evidence_id: "e",
    brand_id: "brand",
    platform_id: "p",
    business_date: b.business_date,
    batch_id: "b",
    deposit: value,
    normalized: n,
    value_digest: digest(stable({ normalized: n, completeness })),
  };
  return { b, e, r };
}
const modern = {
  adapterId: "explicit-canonical",
  mappingVersion: "1",
  status: "active",
  fieldAvailability: { deposit: true },
  definition: { mapping: { deposit: "deposit" } },
};
test("mapping: explicit historical decimal, NULL and incomplete are semantic proofs, not eligibility", () => {
  for (const [v, c] of [
    ["100.010000", "complete"],
    [null, "complete"],
    ["0.000000", "incomplete"],
  ] as const) {
    const f = fixture(v, c);
    assert.equal(
      legacyApproval(f.b, [f.e], [f.r]).semanticsSource,
      "legacy_explicit_canonical_v1",
    );
    assert.equal(f.r.deposit, v);
  }
});
for (const [name, mutate] of Object.entries<
  (f: ReturnType<typeof fixture>) => void
>({
  unknown: (f) => (f.b.mapping = {}),
  modernMarker: (f) => (f.b.mapping_digest = "f".repeat(64)),
  date: (f) => (f.b.business_date = "2026-02-30"),
  metadata: (f) => (f.b.metadata_digest = "0".repeat(64)),
  scope: (f) => (f.b.scope_digest = "0".repeat(64)),
  noncanonical: (f) => (f.b.mapping.deposit_amount = "Amount"),
  unit: (f) => (f.e.raw_values.Amount = "10001"),
  precision: (f) => (f.e.raw_values.Amount = "0.1234567"),
  rawHash: (f) => (f.e.row_digest = "0".repeat(64)),
  evidenceScope: (f) => (f.e.brand_id = "other"),
  revisionLink: (f) => (f.r.evidence_id = "other"),
  numericValue: (f) => (f.r.deposit = "1.000000"),
  revisionHash: (f) => (f.r.value_digest = "0".repeat(64)),
  fatal: (f) => (f.e.issues = [{ severity: "fatal" }]),
}))
  test("mapping: reject historical " + name, () => {
    const f = fixture();
    mutate(f);
    assert.throws(
      () => legacyApproval(f.b, [f.e], [f.r]),
      /entitlement_metric_semantics_unapproved/,
    );
  });
test("mapping: modern approved; incomplete modern never downgrades", async () => {
  assert.equal(mappingApproval(modern).adapterId, "explicit-canonical");
  for (const key of [
    "mappingVersion",
    "fieldAvailability",
    "adapterId",
    "status",
  ]) {
    const mapping: any = structuredClone(modern);
    delete mapping[key];
    const f = fixture();
    f.b.mapping = mapping;
    let queries = 0;
    const tx: any = {
      query: async () => {
        queries++;
        return { rows: [f.b] };
      },
    };
    await assert.rejects(
      () =>
        resolveMappingSemantics(
          tx,
          { brandId: "brand", botId: "bot" },
          "p",
          "b",
          "BRL",
          "America/Sao_Paulo",
        ),
      /entitlement_metric_semantics_unapproved/,
    );
    assert.equal(queries, 1);
  }
  assert.throws(
    () =>
      mappingApproval({
        adapterId: "external",
        mappingVersion: "1",
        status: "active",
        fieldAvailability: { deposit: true },
        definition: {
          fields: [{ target: "deposit", semantics: "unknown", review: false }],
        },
      }),
    /entitlement_metric_semantics_unapproved/,
  );
});
test("mapping: currency/timezone must match both modern and historical context", async () => {
  for (const mapping of [modern, fixture().b.mapping]) {
    const f = fixture();
    f.b.mapping = mapping;
    const tx: any = { query: async () => ({ rows: [f.b] }) };
    for (const [currency, tz] of [
      ["USD", "America/Sao_Paulo"],
      ["BRL", "UTC"],
    ])
      await assert.rejects(
        () =>
          resolveMappingSemantics(
            tx,
            { brandId: "brand", botId: "bot" },
            "p",
            "b",
            currency!,
            tz!,
          ),
        /entitlement_metric_semantics_unapproved/,
      );
  }
});
