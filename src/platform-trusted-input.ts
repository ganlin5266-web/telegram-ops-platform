import { one, type Queryable, type Scope } from "./db.js";
// Shared read-only P4/P3 evidence. No rule selection or economic decisions.
export async function readTrustedPlatformInput(
  tx: Queryable,
  t: Scope & { userId: string; platformId: string },
  sourceDate: string,
) {
  const platform = await one(
    tx,
    "SELECT * FROM platforms WHERE brand_id=$1 AND id=$2",
    [t.brandId, t.platformId],
  );
  await one(
    tx,
    "SELECT id FROM telegram_users WHERE brand_id=$1 AND bot_id=$2 AND id=$3",
    [t.brandId, t.botId, t.userId],
  );
  const identities = (
    await tx.query(
      `SELECT id,status,verified_at,verification_method,evidence_reference,platform_uid FROM platform_identities WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3 AND platform_id=$4 ORDER BY submitted_at DESC,id DESC`,
      [t.brandId, t.botId, t.userId, t.platformId],
    )
  ).rows;
  const identity =
    identities.find((i) => i.status === "verified") ?? identities[0] ?? null;
  const fact = identity
    ? ((
        await tx.query(
          `SELECT f.id,f.current_revision_id,r.batch_id,r.evidence_id,r.deposit::text,r.value_digest,b.completeness,b.currency,b.mapping,b.status AS batch_status,b.issues
 FROM platform_accounts a JOIN platform_user_daily_facts f ON f.account_id=a.id JOIN platform_user_daily_fact_revisions r ON r.id=f.current_revision_id JOIN platform_import_batches b ON b.id=r.batch_id
 WHERE a.brand_id=$1 AND a.platform_id=$2 AND a.platform_uid=$3 AND f.business_date=$4`,
          [t.brandId, t.platformId, identity.platform_uid, sourceDate],
        )
      ).rows[0] ?? null)
    : null;
  // P4 holds the same platform lock during preflight/activation. Only row-level
  // comparison findings belonging to this verified account can block its date.
  const conflicts =
    identity?.status === "verified"
      ? (
          await tx.query(
            `SELECT b.id AS batch_id,e.id AS evidence_id,e.expected_revision_id
 FROM platform_import_batches b JOIN platform_import_evidence e
 ON (e.brand_id,e.platform_id,e.business_date,e.batch_id)=(b.brand_id,b.platform_id,b.business_date,b.id)
 WHERE b.brand_id=$1 AND b.platform_id=$2 AND b.business_date=$3
 AND b.status='review_required' AND e.normalized->>'uid'=$4
 AND e.issues @> '[{"code":"revision_comparison_required"}]'::jsonb
 ORDER BY b.id,e.id`,
            [t.brandId, t.platformId, sourceDate, identity.platform_uid],
          )
        ).rows
      : [];
  return { platform, identity, fact, conflicts };
}
