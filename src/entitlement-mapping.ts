import { DomainError, one, type Queryable, type Scope } from "./db.js";
import { inputFingerprint } from "./entitlement-domain.js";
import {
  fields,
  decimal,
  stable,
  digest,
  businessDate,
} from "./platform-data-input.js";
export function mappingApproval(mapping: Record<string, any>) {
  const field = Array.isArray(mapping.definition?.fields)
    ? mapping.definition.fields.find((f: any) => f && f.target === "deposit")
    : undefined;
  const explicit =
    mapping.adapterId === "explicit-canonical" &&
    mapping.mappingVersion === "1" &&
    typeof mapping.definition?.mapping?.deposit === "string";
  if (
    typeof mapping.adapterId !== "string" ||
    !mapping.adapterId ||
    typeof mapping.mappingVersion !== "string" ||
    !mapping.mappingVersion ||
    mapping.status !== "active" ||
    mapping.fieldAvailability?.deposit !== true ||
    (!explicit &&
      (!field || field.review || field.semantics !== "source_reported_deposit"))
  )
    throw new DomainError("entitlement_metric_semantics_unapproved", 400);
  return {
    adapterId: mapping.adapterId,
    mappingVersion: mapping.mappingVersion,
    definitionFingerprint: inputFingerprint(mapping.definition),
    semantics: "source_reported_deposit",
    canonicalField: "deposit",
  };
}

const reject = (): never => {
  throw new DomainError("entitlement_metric_semantics_unapproved", 400);
};
// 010 deliberately preserves the zero digest on immutable 009 flat mappings.
// A missing modern key alone is NEVER evidence of the historical format.
export function legacyApproval(
  b: Record<string, any>,
  evidence: Record<string, any>[],
  revisions: Record<string, any>[],
) {
  const m = b.mapping;
  if (!m || Array.isArray(m) || typeof m !== "object") return reject();
  const keys = Object.keys(m);
  if (
    !keys.length ||
    !keys.every(
      (k) =>
        (fields as readonly string[]).includes(k) &&
        typeof m[k] === "string" &&
        m[k].length > 0 &&
        m[k].length <= 100,
    ) ||
    !m.uid ||
    !m.deposit ||
    new Set(Object.values(m)).size !== keys.length ||
    b.mapping_digest !== "0".repeat(64) ||
    !["csv", "xlsx"].includes(b.source_type) ||
    !businessDate(b.business_date) ||
    !["complete", "incomplete", "unknown", "conflicting"].includes(
      b.completeness,
    )
  )
    return reject();
  const meta = {
    platformId: b.platform_id,
    businessDate: b.business_date,
    timezone: b.timezone,
    currency: b.currency,
    sourceType: b.source_type,
    mapping: m,
    coverage: b.coverage,
    completeness: b.completeness,
    replacement: b.replacement,
    reason: b.reason,
  };
  if (
    digest(stable(meta)) !== b.metadata_digest ||
    digest(
      stable({
        coverage: b.coverage,
        timezone: b.timezone,
        currency: b.currency,
      }),
    ) !== b.scope_digest ||
    !evidence.length ||
    evidence.length !== b.row_count ||
    !revisions.length
  )
    return reject();
  for (const e of evidence) {
    if (
      e.batch_id !== b.id ||
      e.brand_id !== b.brand_id ||
      e.platform_id !== b.platform_id ||
      e.business_date !== b.business_date ||
      digest(stable(e.raw_values)) !== e.row_digest ||
      !e.normalized ||
      Object.keys(e.normalized).length !== fields.length ||
      !fields.every((f) => Object.hasOwn(e.normalized, f)) ||
      !Array.isArray(e.issues) ||
      e.issues.some((i: any) => i.severity === "fatal") ||
      !Object.hasOwn(e.raw_values, m.deposit)
    )
      return reject();
    try {
      if (
        typeof e.raw_values[m.deposit] !== "string" ||
        decimal(e.raw_values[m.deposit]) !== e.normalized.deposit
      )
        return reject();
    } catch {
      return reject();
    }
  }
  for (const r of revisions) {
    const e = evidence.find((e) => e.id === r.evidence_id);
    if (
      !e ||
      r.batch_id !== b.id ||
      r.brand_id !== b.brand_id ||
      r.platform_id !== b.platform_id ||
      r.business_date !== b.business_date ||
      stable(r.normalized) !== stable(e.normalized) ||
      r.deposit !== r.normalized.deposit ||
      digest(
        stable({ normalized: r.normalized, completeness: b.completeness }),
      ) !== r.value_digest
    )
      return reject();
  }
  return {
    semanticsSource: "legacy_explicit_canonical_v1",
    definitionFingerprint: inputFingerprint(m),
    semantics: "source_reported_deposit",
    canonicalField: "deposit",
  };
}
export async function resolveMappingSemantics(
  tx: Queryable,
  s: Scope,
  platformId: string,
  batchId: string,
  currency: string,
  timezone: string,
) {
  const b = await one(
    tx,
    "SELECT *,business_date::text AS business_date FROM platform_import_batches WHERE brand_id=$1 AND platform_id=$2 AND id=$3",
    [s.brandId, platformId, batchId],
  );
  if (b.currency !== currency || b.timezone !== timezone) return reject();
  const m = b.mapping;
  // Any non-canonical key denotes modern/unknown metadata: never downgrade.
  if (Object.keys(m).some((k) => !(fields as readonly string[]).includes(k)))
    return mappingApproval(m);
  const es = (
    await tx.query(
      "SELECT *,business_date::text AS business_date FROM platform_import_evidence WHERE batch_id=$1 ORDER BY row_number",
      [b.id],
    )
  ).rows;
  const rs = (
    await tx.query(
      "SELECT *,business_date::text AS business_date,deposit::text AS deposit FROM platform_user_daily_fact_revisions WHERE batch_id=$1 ORDER BY id",
      [b.id],
    )
  ).rows;
  return legacyApproval(b, es, rs);
}
