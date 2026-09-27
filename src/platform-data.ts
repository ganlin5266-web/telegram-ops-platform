import {enqueueEntitlementSourceChange} from './entitlements.js';
import {
  adapterDefinition,
  mappingSnapshot,
  normalizeAdapterRow,
} from "./platform-adapters.js";
import {
  type Database,
  type Queryable,
  type Scope,
  one,
  DomainError,
} from "./db.js";
import { authorize, type Principal } from "./auth.js";
import { canonicalUid, maskUid } from "./platform-identities.js";
import {
  importInput,
  parseFile,
  normalizeRow,
  digest,
  stable,
  moneyFields,
  fields,
  type Issue,
} from "./platform-data-input.js";
export async function dataAuthorize(
  tx: Queryable,
  p: Principal,
  s: Scope,
  permission: string,
) {
  await authorize(tx, p, s, permission);
  // Platform facts are Brand-wide. A Bot-limited grant must not expose other Bot/unbound accounts.
  const r = (
    await tx.query(
      `SELECT 1 FROM admin_roles ar JOIN roles r ON r.id=ar.role_id JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions pm ON pm.id=rp.permission_id WHERE ar.admin_id=$1 AND pm.name=$2 AND ar.bot_id IS NULL AND (ar.brand_id=$3 OR (ar.brand_id IS NULL AND r.name='Super Admin')) LIMIT 1`,
      [p.adminId, permission, s.brandId],
    )
  ).rows[0];
  if (!r) throw new DomainError("forbidden", 403);
}
async function audit(
  tx: Queryable,
  p: Principal,
  s: Scope,
  action: string,
  id: string,
  requestId: string,
) {
  await tx.query(
    "INSERT INTO audit_logs(admin_id,brand_id,bot_id,action,object_type,object_id,request_id) VALUES($1,$2,$3,$4,'platform_import_batch',$5,$6)",
    [p.adminId, s.brandId, s.botId, action, id, requestId],
  );
}
const valueHash = (normalized: unknown, completeness: string) =>
  digest(stable({ normalized, completeness }));
export async function preflightImport(
  db: Database,
  p: Principal,
  s: Scope,
  input: unknown,
  requestId: string,
) {
  await dataAuthorize(db, p, s, "platform_data.import");
  const v = importInput.parse(input),
    file = await parseFile(v);
  return db.transaction(async (tx) => {
    await dataAuthorize(tx, p, s, "platform_data.import");
    const platform = await one(
      tx,
      "SELECT * FROM platforms WHERE brand_id=$1 AND id=$2 FOR UPDATE",
      [s.brandId, v.platformId],
    );
    if (
      platform.status !== "active" ||
      v.timezone !== platform.timezone ||
      v.currency !== platform.currency
    )
      throw new DomainError("platform_metadata_mismatch", 400);
    const adapter = v.adapter
      ? adapterDefinition(v.adapter.id, v.adapter.version)
      : null;
    const snapshot = adapter
      ? mappingSnapshot(
          adapter,
          file.headers,
          v.platformId,
          v.sourceType,
          v.timezone,
          v.currency,
        )
      : null;
    if (adapter && Object.keys(v.mapping).length)
      throw new DomainError("adapter_mapping_override_rejected", 400);
    const mappingDigest = snapshot ? snapshot.definitionDigest : "0".repeat(64);
    const meta = { ...v, fileBase64: undefined, filename: undefined };
    const metadataDigest = digest(stable(meta)),
      scopeDigest = digest(
        stable({
          coverage: v.coverage,
          timezone: v.timezone,
          currency: v.currency,
        }),
      );
    const duplicate = (
      await tx.query(
        "SELECT id,metadata_digest,status FROM platform_import_batches WHERE brand_id=$1 AND platform_id=$2 AND business_date=$3 AND file_digest=$4 AND mapping_digest=$5",
        [
          s.brandId,
          v.platformId,
          v.businessDate,
          file.fileDigest,
          mappingDigest,
        ],
      )
    ).rows[0];
    if (duplicate) {
      if (duplicate.metadata_digest !== metadataDigest)
        throw new DomainError("duplicate_metadata_conflict", 409);
      return { id: duplicate.id, status: duplicate.status, duplicate: true };
    }
    const issues: Issue[] = [],
      seen = new Set<string>();
    const rows = [];
    let accepted = 0,
      rejected = 0,
      warnings = 0,
      changed = false;
    for (let index = 0; index < file.rows.length; index++) {
      const raw = file.rows[index]!,
        row = index + 2;
      const n = adapter
        ? normalizeAdapterRow(raw, adapter, platform, row)
        : normalizeRow(raw, v.mapping, platform, row);
      if (n.normalized.uid) {
        if (seen.has(n.normalized.uid))
          n.issues.push({ severity: "fatal", code: "duplicate_uid", row });
        seen.add(n.normalized.uid);
      }
      const current = (
        await tx.query(
          `SELECT r.id,r.value_digest,b.scope_digest FROM platform_accounts a JOIN platform_user_daily_facts f ON (f.brand_id,f.platform_id,f.account_id)=(a.brand_id,a.platform_id,a.id) JOIN platform_user_daily_fact_revisions r ON r.id=f.current_revision_id JOIN platform_import_batches b ON b.id=r.batch_id WHERE a.brand_id=$1 AND a.platform_id=$2 AND a.platform_uid=$3 AND f.business_date=$4`,
          [s.brandId, v.platformId, n.normalized.uid, v.businessDate],
        )
      ).rows[0];
      if (current && current.scope_digest !== scopeDigest)
        n.issues.push({
          severity: "fatal",
          code: "replacement_scope_mismatch",
          row,
        });
      if (
        current &&
        current.value_digest !== valueHash(n.normalized, v.completeness)
      ) {
        changed = true;
        n.issues.push({
          severity: "info",
          code: "revision_comparison_required",
          row,
        });
      }
      const bound = (
        await tx.query(
          "SELECT id,user_id,bot_id FROM platform_identities WHERE brand_id=$1 AND platform_id=$2 AND platform_uid=$3 AND status='verified'",
          [s.brandId, v.platformId, n.normalized.uid],
        )
      ).rows[0];
      if (!bound)
        n.issues.push({ severity: "warning", code: "unlinked_account", row });
      if (n.issues.some((i) => i.severity === "fatal")) rejected++;
      else accepted++;
      if (n.issues.some((i) => i.severity === "warning")) warnings++;
      issues.push(...n.issues);
      rows.push({ raw, row, ...n, expected: current?.id ?? null });
    }
    if (v.coverage.kind === "full" && v.completeness === "complete") {
      const existing = (
        await tx.query(
          "SELECT a.platform_uid FROM platform_user_daily_facts f JOIN platform_accounts a ON a.id=f.account_id WHERE f.brand_id=$1 AND f.platform_id=$2 AND f.business_date=$3",
          [s.brandId, v.platformId, v.businessDate],
        )
      ).rows;
      if (existing.some((r) => !seen.has(r.platform_uid)))
        issues.push({
          severity: "fatal",
          code: "complete_replacement_omits_existing_account",
        });
    }
    const status = issues.some((i) => i.severity === "fatal")
      ? "rejected"
      : changed && !v.replacement
        ? "review_required"
        : "ready";
    const batch = await one(
      tx,
      `INSERT INTO platform_import_batches(brand_id,platform_id,business_date,timezone,currency,source_type,original_filename,file_digest,metadata_digest,scope_digest,coverage,mapping,completeness,replacement,reason,row_count,accepted_rows,rejected_rows,warning_rows,status,issues,created_by,mapping_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id,status`,
      [
        s.brandId,
        v.platformId,
        v.businessDate,
        v.timezone,
        v.currency,
        v.sourceType,
        v.filename,
        file.fileDigest,
        metadataDigest,
        scopeDigest,
        JSON.stringify(v.coverage),
        JSON.stringify(
          snapshot ?? {
            adapterId: "explicit-canonical",
            mappingVersion: "1",
            schemaIdentifier: "explicit-canonical-v1",
            platformId: v.platformId,
            sourceType: v.sourceType,
            timezone: v.timezone,
            currency: v.currency,
            status: "active",
            fieldAvailability: Object.fromEntries(
              fields.map((f) => [f, Boolean(v.mapping[f])]),
            ),
            definition: {
              mapping: v.mapping,
              defaultMoneyDivisor: "1",
              datetimeFormat: "iso-offset",
              dateFormat: "YYYY-MM-DD",
            },
            schemaFingerprint: digest(stable([...file.headers].sort())),
          },
        ),
        v.completeness,
        v.replacement,
        v.reason,
        rows.length,
        accepted,
        rejected,
        warnings,
        status,
        JSON.stringify(issues),
        p.adminId,
        mappingDigest,
      ],
    );
    for (const row of rows)
      await tx.query(
        "INSERT INTO platform_import_evidence(brand_id,platform_id,business_date,batch_id,row_number,raw_values,row_digest,normalized,issues,expected_revision_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          s.brandId,
          v.platformId,
          v.businessDate,
          batch.id,
          row.row,
          JSON.stringify(row.raw),
          digest(stable(row.raw)),
          JSON.stringify(row.normalized),
          JSON.stringify(row.issues),
          row.expected,
        ],
      );
    if (status === "review_required") {
      for (const row of rows.filter(r => r.issues.some(i => i.code === "revision_comparison_required"))) {
        const bound = (await tx.query(
          "SELECT user_id,bot_id FROM platform_identities WHERE brand_id=$1 AND platform_id=$2 AND platform_uid=$3 AND status='verified'",
          [s.brandId,v.platformId,row.normalized.uid],
        )).rows[0];
        if (bound) await enqueueEntitlementSourceChange(tx,s.brandId,v.platformId,"data_conflict",batch.id,v.businessDate,bound.user_id,bound.bot_id);
      }
    }
    await audit(tx, p, s, "platform_data.upload", batch.id, requestId);
    await audit(tx, p, s, "platform_data.preflight", batch.id, requestId);
    return { ...batch, duplicate: false };
  });
}
export async function activateImport(
  db: Database,
  p: Principal,
  s: Scope,
  id: string,
  approveChanges: boolean,
  requestId: string,
) {
  return db.transaction(async (tx) => {
    await dataAuthorize(tx, p, s, "platform_data.activate");
    const ref = await one(
      tx,
      "SELECT platform_id FROM platform_import_batches WHERE brand_id=$1 AND id=$2",
      [s.brandId, id],
    );
    const platform = await one(
      tx,
      "SELECT * FROM platforms WHERE brand_id=$1 AND id=$2 FOR UPDATE",
      [s.brandId, ref.platform_id],
    );
    const batch = await one(
      tx,
      "SELECT *,business_date::text AS business_date FROM platform_import_batches WHERE brand_id=$1 AND id=$2 FOR UPDATE",
      [s.brandId, id],
    );
    if (batch.status === "active" || batch.status === "superseded")
      return { id, status: batch.status, duplicate: true };
    if (
      platform.status !== "active" ||
      platform.timezone !== batch.timezone ||
      platform.currency !== batch.currency
    )
      throw new DomainError("platform_metadata_mismatch", 409);
    if (
      batch.status === "rejected" ||
      (batch.status === "review_required" && !approveChanges)
    )
      throw new DomainError("batch_not_approved", 409);
    if (batch.status === "review_required")
      await audit(tx, p, s, "platform_data.review", id, requestId);
    const evidence = (
      await tx.query(
        "SELECT *,business_date::text AS business_date FROM platform_import_evidence WHERE batch_id=$1 ORDER BY row_number",
        [id],
      )
    ).rows;
    const oldBatches = new Set<string>();
    let revisions = 0;
    for (const e of evidence) {
      const n = e.normalized;
      const account = await one(
        tx,
        `INSERT INTO platform_accounts(brand_id,platform_id,platform_uid) VALUES($1,$2,$3) ON CONFLICT(brand_id,platform_id,platform_uid) DO NOTHING RETURNING *`,
        [s.brandId, batch.platform_id, n.uid],
      ).catch(async (err) => {
        if (!(err instanceof DomainError)) throw err;
        return one(
          tx,
          "SELECT * FROM platform_accounts WHERE brand_id=$1 AND platform_id=$2 AND platform_uid=$3",
          [s.brandId, batch.platform_id, n.uid],
        );
      });
      await tx.query(
        "INSERT INTO platform_user_daily_facts(brand_id,platform_id,account_id,business_date) VALUES($1,$2,$3,$4) ON CONFLICT(brand_id,platform_id,account_id,business_date) DO NOTHING",
        [s.brandId, batch.platform_id, account.id, batch.business_date],
      );
      const fact = await one(
        tx,
        "SELECT * FROM platform_user_daily_facts WHERE brand_id=$1 AND platform_id=$2 AND account_id=$3 AND business_date=$4 FOR UPDATE",
        [s.brandId, batch.platform_id, account.id, batch.business_date],
      );
      if (fact.current_revision_id !== e.expected_revision_id)
        throw new DomainError("preflight_stale", 409);
      const current = fact.current_revision_id
        ? await one(
            tx,
            "SELECT * FROM platform_user_daily_fact_revisions WHERE id=$1",
            [fact.current_revision_id],
          )
        : null;
      const hash = valueHash(n, batch.completeness);
      if (current?.value_digest === hash) continue;
      const identity = (
        await tx.query(
          "SELECT id,user_id,bot_id FROM platform_identities WHERE brand_id=$1 AND platform_id=$2 AND platform_uid=$3 AND status='verified'",
          [s.brandId, batch.platform_id, n.uid],
        )
      ).rows[0];
      const cols = [...moneyFields, "deposit_count"];
      const vals = cols.map((k) => n[k]);
      const r = await one(
        tx,
        `INSERT INTO platform_user_daily_fact_revisions(brand_id,platform_id,business_date,fact_id,batch_id,evidence_id,identity_id,data_version,supersedes,reason,normalized,value_digest,${cols.join(",")}) VALUES(${Array.from({ length: 12 + cols.length }, (_, j) => "$" + (j + 1)).join(",")}) RETURNING id`,
        [
          s.brandId,
          batch.platform_id,
          batch.business_date,
          fact.id,
          id,
          e.id,
          identity?.id ?? null,
          (current?.data_version ?? 0) + 1,
          current?.id ?? null,
          batch.reason,
          JSON.stringify(n),
          hash,
          ...vals,
        ],
      );
      await tx.query(
        "UPDATE platform_user_daily_facts SET current_revision_id=$2 WHERE id=$1",
        [fact.id, r.id],
      );
      if(identity) await enqueueEntitlementSourceChange(tx,s.brandId,batch.platform_id,'fact_revision',r.id,String(batch.business_date).slice(0,10),identity.user_id,identity.bot_id);
      if (current) oldBatches.add(current.batch_id);
      revisions++;
    }
    await tx.query(
      "UPDATE platform_import_batches SET status='active',activated_by=$2,activated_at=now() WHERE id=$1",
      [id, p.adminId],
    );
    for (const old of oldBatches) {
      const live = (
        await tx.query(
          "SELECT 1 FROM platform_user_daily_facts f JOIN platform_user_daily_fact_revisions r ON r.id=f.current_revision_id WHERE r.batch_id=$1 LIMIT 1",
          [old],
        )
      ).rows[0];
      if (!live) {
        await tx.query(
          "UPDATE platform_import_batches SET status='superseded' WHERE id=$1 AND status='active'",
          [old],
        );
        await audit(tx, p, s, "platform_data.supersede", old, requestId);
      }
    }
    await audit(tx, p, s, "platform_data.activate", id, requestId);
    return { id, status: "active", revisions, duplicate: false };
  });
}
export async function miniDataStatus(
  db: Queryable,
  s: Scope & { userId: string },
) {
  const rows = (
    await db.query(
      `SELECT p.id AS platform_id,max(f.business_date)::text AS latest_date FROM platforms p JOIN platform_identities i ON i.brand_id=p.brand_id AND i.platform_id=p.id AND i.bot_id=$2 AND i.user_id=$3 AND i.status='verified' LEFT JOIN platform_user_daily_fact_revisions r ON r.identity_id=i.id LEFT JOIN platform_user_daily_facts f ON f.current_revision_id=r.id AND f.brand_id=i.brand_id AND f.platform_id=i.platform_id WHERE p.brand_id=$1 AND p.status='active' GROUP BY p.id`,
      [s.brandId, s.botId, s.userId],
    )
  ).rows;
  return {
    items: rows.map((r) => ({
      platformId: r.platform_id,
      latestDate: r.latest_date,
      status: r.latest_date ? "updated" : "waiting",
    })),
  };
}
export { maskUid, canonicalUid };
