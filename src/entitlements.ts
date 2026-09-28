import {readTrustedPlatformInput} from './platform-trusted-input.js';
import { resolveMappingSemantics } from "./entitlement-mapping.js";
import { randomUUID } from "node:crypto";
import {
  DomainError,
  one,
  type Database,
  type Queryable,
  type Scope,
} from "./db.js";
import { authorize, type Principal } from "./auth.js";
import {
  ruleInput,
  validateCalendar,
  canonicalAmount,
  inputFingerprint,
  decideEntitlement,
  calendarDay,
  wallInstant,
  dateInZone,
  type RuleInput,
} from "./entitlement-domain.js";
export const entitlementsEnabled = () =>
  process.env.DAILY_ENTITLEMENTS_ENABLED === "true";
export type Target = Scope & {
  userId: string;
  platformId: string;
  entitlementDate: string;
};
export async function entitlementAudit(
  tx: Queryable,
  s: Scope,
  action: string,
  id: string,
  requestId: string,
  adminId: string | null,
  summary: Record<string, unknown> = {},
) {
  await tx.query(
    `INSERT INTO audit_logs(admin_id,brand_id,bot_id,action,object_type,object_id,request_id,after_data) VALUES($1,$2,$3,$4,'entitlement',$5,$6,$7)`,
    [
      adminId,
      s.brandId,
      s.botId,
      action,
      id,
      requestId,
      JSON.stringify(summary),
    ],
  );
}
export async function validateRule(tx: Queryable, s: Scope, r: RuleInput) {
  validateCalendar(r);
  const platform = await one(
    tx,
    "SELECT * FROM platforms WHERE brand_id=$1 AND id=$2",
    [s.brandId, r.platformId],
  );
  if (
    platform.status !== "active" ||
    platform.currency !== r.currency ||
    platform.timezone !== r.sourceTimezone
  )
    throw new DomainError("entitlement_platform_mismatch", 400);
  return resolveMappingSemantics(
    tx,
    s,
    r.platformId,
    r.mappingBatchId,
    r.currency,
    r.sourceTimezone,
  );
}
export async function createEntitlementRule(
  db: Database,
  p: Principal,
  s: Scope,
  body: unknown,
  requestId: string,
) {
  const r = ruleInput.parse(body);
  return db.transaction(async (tx) => {
    await authorize(tx, p, s, "entitlements.rules.manage");
    const approval = await validateRule(tx, s, r);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,51))", [
      `${s.brandId}:${s.botId}:${r.platformId}`,
    ]);
    let rule = (
      await tx.query(
        "SELECT * FROM entitlement_rules WHERE brand_id=$1 AND bot_id=$2 AND platform_id=$3",
        [s.brandId, s.botId, r.platformId],
      )
    ).rows[0];
    if (!rule)
      rule = await one(
        tx,
        "INSERT INTO entitlement_rules(brand_id,bot_id,platform_id,name,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [s.brandId, s.botId, r.platformId, r.name, p.adminId],
      );
    const version = await one(
      tx,
      `INSERT INTO entitlement_rule_versions(brand_id,bot_id,platform_id,rule_id,version,metric,operator,currency,source_timezone,entitlement_timezone,cutoff_time,effective_from,effective_until,mapping_batch_id,mapping_approval,created_by)
 SELECT $1,$2,$3,$4,coalesce(max(version),0)+1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15 FROM entitlement_rule_versions WHERE rule_id=$4 RETURNING *`,
      [
        s.brandId,
        s.botId,
        r.platformId,
        rule.id,
        r.metric,
        r.operator,
        r.currency,
        r.sourceTimezone,
        r.entitlementTimezone,
        r.cutoffTime,
        r.effectiveFrom,
        r.effectiveUntil,
        r.mappingBatchId,
        JSON.stringify(approval),
        p.adminId,
      ],
    );
    for (const [index, tier] of r.tiers.entries())
      await tx.query(
        "INSERT INTO entitlement_rule_tiers(version_id,tier_key,position,display_name,threshold) VALUES($1,$2,$3,$4,$5)",
        [
          version.id,
          tier.key,
          index + 1,
          tier.name,
          canonicalAmount(tier.threshold),
        ],
      );
    await entitlementAudit(
      tx,
      s,
      "entitlement.rule.create",
      version.id,
      requestId,
      p.adminId,
      { ruleId: rule.id },
    );
    return { ruleId: rule.id, versionId: version.id, status: "draft" };
  });
}
export async function changeEntitlementRule(
  db: Database,
  p: Principal,
  s: Scope,
  id: string,
  action: "publish" | "retire",
  requestId: string,
) {
  return db.transaction(async (tx) => {
    await authorize(tx, p, s, "entitlements.rules.manage");
    const ref = await one(
      tx,
      "SELECT platform_id FROM entitlement_rule_versions WHERE brand_id=$1 AND bot_id=$2 AND id=$3",
      [s.brandId, s.botId, id],
    );
    await one(
      tx,
      "SELECT id FROM platforms WHERE brand_id=$1 AND id=$2 FOR UPDATE",
      [s.brandId, ref.platform_id],
    );
    const v = await one(
      tx,
      "SELECT *,effective_from::text,effective_until::text FROM entitlement_rule_versions WHERE brand_id=$1 AND bot_id=$2 AND id=$3 FOR UPDATE",
      [s.brandId, s.botId, id],
    );
    if (v.status === (action === "publish" ? "published" : "retired"))
      return { id, status: v.status };
    if (action === "publish") {
      const tiers = (
        await tx.query(
          "SELECT tier_key AS key,display_name AS name,threshold::text FROM entitlement_rule_tiers WHERE version_id=$1 ORDER BY position",
          [id],
        )
      ).rows;
      const r = ruleInput.parse({
        platformId: v.platform_id,
        name: "validate",
        metric: v.metric,
        operator: v.operator,
        currency: v.currency,
        sourceTimezone: v.source_timezone,
        entitlementTimezone: v.entitlement_timezone,
        cutoffTime: v.cutoff_time.slice(0, 5),
        effectiveFrom: v.effective_from,
        effectiveUntil: v.effective_until,
        mappingBatchId: v.mapping_batch_id,
        tiers,
      });
      const approved = await validateRule(tx, s, r);
      if (inputFingerprint(approved) !== inputFingerprint(v.mapping_approval))
        throw new DomainError("entitlement_mapping_changed", 409);
      await tx.query(
        `UPDATE entitlement_rule_versions SET status='published',published_at=now(),published_by=$2 WHERE id=$1`,
        [id, p.adminId],
      );
    } else
      await tx.query(
        `UPDATE entitlement_rule_versions SET status='retired',retired_at=now() WHERE id=$1`,
        [id],
      );
    await enqueueEntitlementSourceChange(
      tx,
      s.brandId,
      v.platform_id,
      "rule_change",
      `${id}:${action}`,
      undefined,
      undefined,
      s.botId,
    );
    await entitlementAudit(
      tx,
      s,
      "entitlement.rule." + action,
      id,
      requestId,
      p.adminId,
    );
    return { id, status: action === "publish" ? "published" : "retired" };
  });
}
export async function queueEntitlement(
  tx: Queryable,
  t: Target,
  trigger: string,
  key: string,
  due?: string,
) {
  if (!entitlementsEnabled()) return null;
  return (
    (
      await tx.query(
        `INSERT INTO entitlement_evaluation_tasks(brand_id,bot_id,user_id,platform_id,entitlement_date,trigger_reason,business_key,next_attempt_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,coalesce($8::timestamptz,now())) ON CONFLICT(business_key) DO NOTHING RETURNING id`,
        [
          t.brandId,
          t.botId,
          t.userId,
          t.platformId,
          t.entitlementDate,
          trigger,
          key,
          due ?? null,
        ],
      )
    ).rows[0]?.id ?? null
  );
}
export async function readEvaluationInput(tx: Queryable, t: Target, now: Date) {
  const sourceDate = calendarDay(t.entitlementDate, -1);
  const {platform,identity,fact,conflicts}=await readTrustedPlatformInput(tx,t,sourceDate);
  const versions = (
    await tx.query(
      `SELECT *,effective_from::text,effective_until::text FROM entitlement_rule_versions WHERE brand_id=$1 AND bot_id=$2 AND platform_id=$3 AND status IN ('published','retired') AND effective_from<=$4::date AND effective_until>=$4::date AND (retired_at IS NULL OR $4::date < (retired_at AT TIME ZONE entitlement_timezone)::date) ORDER BY version`,
      [t.brandId, t.botId, t.platformId, t.entitlementDate],
    )
  ).rows;
  const rule = versions.length === 1 ? versions[0] : null;
  const tiers = rule
    ? (
        await tx.query<{ key: string; threshold: string; name: string }>(
          "SELECT tier_key AS key,threshold::text,display_name AS name FROM entitlement_rule_tiers WHERE version_id=$1 ORDER BY position",
          [rule.id],
        )
      ).rows
    : [];
  let mapping: Record<string, any> = {};
  let compatible = false;
  if (fact)
    try {
      mapping = await resolveMappingSemantics(
        tx,
        t,
        t.platformId,
        fact.batch_id,
        platform.currency,
        platform.timezone,
      );
      compatible =
        !!rule &&
        inputFingerprint(mapping) === inputFingerprint(rule.mapping_approval);
    } catch {}
  const cutoff = wallInstant(
    t.entitlementDate,
    rule?.cutoff_time.slice(0, 5) ?? "12:00",
    rule?.source_timezone ?? platform.timezone,
  );
  const identitySnapshot = identity
    ? {
        id: identity.id,
        status: identity.status,
        verifiedAt: identity.verified_at,
        verificationMethod: identity.verification_method,
        evidenceReference: identity.evidence_reference,
      }
    : {};
  const input = {
    identityStatus: identity?.status ?? null,
    ruleAvailable: !!rule,
    ruleConflict: versions.length > 1,
    factPresent: !!fact,
    completeness: fact?.completeness ?? null,
    conflicting: conflicts.length > 0 || fact?.batch_status === "review_required",
    metricAvailable: mapping.canonicalField === "deposit",
    mappingCompatible: compatible,
    value: fact?.deposit ?? null,
    factCurrency: fact?.currency ?? null,
    ruleCurrency: rule?.currency ?? null,
    cutoffReached: now.toISOString() >= cutoff,
    tiers,
  };
  const decision = decideEntitlement(input);
  // Time changes the fingerprint only when it changes the SLA conclusion, not on every retry.
  const fingerprint = inputFingerprint({
    target: t,
    sourceDate,
    identity: identitySnapshot,
    ruleVersionId: rule?.id ?? null,
    ruleCandidates: versions.map((v) => v.id),
    ...(conflicts.length ? { conflicts } : {}),
    factRevisionId: fact?.current_revision_id ?? null,
    value: input.value,
    completeness: input.completeness,
    metricAvailable: input.metricAvailable,
    mapping,
    currency: input.factCurrency,
    sourceTimezone: rule?.source_timezone ?? platform.timezone,
    entitlementTimezone: rule?.entitlement_timezone ?? platform.timezone,
    decision,
    slaOverdue: decision.status === "pending" && input.cutoffReached,
  });
  return {
    platform,
    identity,
    identitySnapshot,
    rule,
    fact,
    tiers,
    sourceDate,
    cutoff,
    decision,
    fingerprint,
    mapping,
    input,
    conflicts,
  };
}
export async function evaluateEntitlement(
  db: Database,
  t: Target,
  trigger: string,
  requestId: string,
  now = new Date(),
) {
  if (!entitlementsEnabled())
    throw new DomainError("entitlements_disabled", 409);
  return db.transaction(async (tx) => {
    // P3 review and P4 activation already lock this platform; share that lock so the input cannot change before commit.
    // Keep transactions per user; never hold a whole-platform batch transaction.
    await one(
      tx,
      "SELECT id FROM platforms WHERE brand_id=$1 AND id=$2 FOR UPDATE",
      [t.brandId, t.platformId],
    );
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,53))", [
      `${t.brandId}:${t.botId}:${t.userId}:${t.platformId}:${t.entitlementDate}`,
    ]);
    const x = await readEvaluationInput(tx, t, now);
    await tx.query(
      `INSERT INTO daily_entitlements(brand_id,bot_id,user_id,platform_id,entitlement_date) VALUES($1,$2,$3,$4,$5) ON CONFLICT(brand_id,bot_id,user_id,platform_id,entitlement_type,entitlement_date) DO NOTHING`,
      [t.brandId, t.botId, t.userId, t.platformId, t.entitlementDate],
    );
    const subject = await one(
      tx,
      "SELECT * FROM daily_entitlements WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3 AND platform_id=$4 AND entitlement_date=$5 FOR UPDATE",
      [t.brandId, t.botId, t.userId, t.platformId, t.entitlementDate],
    );
    const old = (
      await tx.query(
        "SELECT id,revision_number,input_fingerprint,status FROM daily_entitlement_revisions WHERE id=$1",
        [subject.current_revision_id],
      )
    ).rows[0];
    if (old?.input_fingerprint === x.fingerprint)
      return { id: subject.id, revisionId: old.id, outcome: "unchanged" };
    // Re-observing an old exact input must not move the pointer backwards.
    if (
      (
        await tx.query(
          "SELECT id FROM daily_entitlement_revisions WHERE daily_entitlement_id=$1 AND input_fingerprint=$2",
          [subject.id, x.fingerprint],
        )
      ).rows.length
    )
      return { id: subject.id, revisionId: old?.id, outcome: "unchanged" };
    const rev = await one(
      tx,
      `INSERT INTO daily_entitlement_revisions(daily_entitlement_id,brand_id,bot_id,user_id,platform_id,source_business_date,entitlement_date,revision_number,supersedes_revision_id,daily_fact_id,daily_fact_revision_id,platform_identity_id,rule_version_id,identity_snapshot,input_fingerprint,metric,source_metric_semantics,source_value,matched_tier,status,reason_code,result_snapshot,trigger_reason)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'deposit_amount',$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
      [
        subject.id,
        t.brandId,
        t.botId,
        t.userId,
        t.platformId,
        x.sourceDate,
        t.entitlementDate,
        (old?.revision_number ?? 0) + 1,
        old?.id ?? null,
        x.fact?.id ?? null,
        x.fact?.current_revision_id ?? null,
        x.identity?.id ?? null,
        x.rule?.id ?? null,
        JSON.stringify(x.identitySnapshot),
        x.fingerprint,
        JSON.stringify(x.mapping),
        x.fact?.deposit ?? null,
        x.decision.matchedTier,
        x.decision.status,
        x.decision.reasonCode,
        JSON.stringify({
          currency: x.rule?.currency ?? null,
          cutoff: x.cutoff,
          sourceTimezone: x.rule?.source_timezone ?? x.platform.timezone,
          entitlementTimezone:
            x.rule?.entitlement_timezone ?? x.platform.timezone,
          completeness: x.fact?.completeness ?? null,
          previousStatus: old?.status ?? null,
          conflicts: x.conflicts,
          matchedTier:
            x.tiers.find((tier) => tier.key === x.decision.matchedTier) ?? null,
        }),
        trigger,
      ],
    );
    await tx.query(
      "UPDATE daily_entitlements SET current_revision_id=$2 WHERE id=$1",
      [subject.id, rev.id],
    );
    if (x.input.cutoffReached && x.decision.status === "pending")
      await tx.query(
        `INSERT INTO entitlement_sla_findings(brand_id,bot_id,user_id,platform_id,entitlement_date,daily_entitlement_id,finding) VALUES($1,$2,$3,$4,$5,$6,'data_sla_missed') ON CONFLICT(daily_entitlement_id,finding) DO NOTHING`,
        [
          t.brandId,
          t.botId,
          t.userId,
          t.platformId,
          t.entitlementDate,
          subject.id,
        ],
      );
    else if (
      x.decision.status === "eligible" ||
      x.decision.status === "ineligible"
    )
      await tx.query(
        "UPDATE entitlement_sla_findings SET resolved_at=coalesce(resolved_at,now()) WHERE daily_entitlement_id=$1",
        [subject.id],
      );
    await entitlementAudit(
      tx,
      t,
      "entitlement.revision",
      subject.id,
      requestId,
      null,
      {
        revisionId: rev.id,
        factRevisionId: x.fact?.current_revision_id ?? null,
        ruleVersionId: x.rule?.id ?? null,
        reasonCode: x.decision.reasonCode,
        status: x.decision.status,
        trigger,
      },
    );
    if (
      x.decision.reasonCode === "stale_data" ||
      x.decision.status === "review_required"
    )
      await entitlementAudit(
        tx,
        t,
        x.decision.status === "review_required"
          ? "entitlement.review_required"
          : "entitlement.stale",
        subject.id,
        requestId,
        null,
        { revisionId: rev.id, reasonCode: x.decision.reasonCode },
      );
    return { id: subject.id, revisionId: rev.id, outcome: "changed" };
  });
}
export async function runEntitlementTasks(db: Database, s: Scope, limit = 20) {
  if (!entitlementsEnabled())
    throw new DomainError("entitlements_disabled", 409);
  await db.query(
    "UPDATE entitlement_evaluation_tasks SET status='failed',lease_until=NULL,lease_token=NULL,last_error_code='attempts_exhausted',outcome='transient_error' WHERE brand_id=$1 AND bot_id=$2 AND status='running' AND lease_until<now() AND attempts>=5",
    [s.brandId, s.botId],
  );
  const outcomes = [];
  for (let i = 0; i < Math.min(limit, 50); i++) {
    const token = randomUUID();
    const task = await db.transaction(
      async (tx) =>
        (
          await tx.query(
            `WITH next AS (SELECT id FROM entitlement_evaluation_tasks WHERE brand_id=$1 AND bot_id=$2 AND attempts<5 AND ((status='queued' AND next_attempt_at<=now()) OR (status='running' AND lease_until<now())) ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
 UPDATE entitlement_evaluation_tasks t SET status='running',attempts=attempts+1,lease_token=$3,lease_until=now()+interval '2 minutes' FROM next WHERE t.id=next.id RETURNING t.*,t.entitlement_date::text`,
            [s.brandId, s.botId, token],
          )
        ).rows[0],
    );
    if (!task) break;
    try {
      const result = await evaluateEntitlement(
        db,
        {
          ...s,
          userId: task.user_id,
          platformId: task.platform_id,
          entitlementDate: task.entitlement_date,
        },
        task.trigger_reason,
        task.id,
      );
      await db.query(
        `UPDATE entitlement_evaluation_tasks SET status='completed',lease_token=NULL,lease_until=NULL,completed_at=now(),outcome=$3 WHERE id=$1 AND lease_token=$2`,
        [task.id, token, result.outcome],
      );
      outcomes.push({ taskId: task.id, ...result });
    } catch (e) {
      const pgCode = (e as { code?: string }).code;
      const retry =
        ["40001", "40P01", "53300", "57P01", "08006"].includes(pgCode ?? "") &&
        task.attempts < 5;
      await db.query(
        `UPDATE entitlement_evaluation_tasks SET status=$3,lease_token=NULL,lease_until=NULL,last_error_code=$4,outcome=$5,next_attempt_at=now()+interval '30 seconds' WHERE id=$1 AND lease_token=$2`,
        [
          task.id,
          token,
          retry ? "queued" : "failed",
          retry ? "transient_error" : "evaluation_failed",
          retry ? "transient_error" : "permanent_configuration_error",
        ],
      );
      outcomes.push({
        id: task.id,
        outcome: retry ? "transient_error" : "permanent_configuration_error",
      });
    }
  }
  return outcomes;
}
// Called by a controlled runner, not an in-memory timer. Reconciliation discovers committed P3/P4 changes
// even after an API process crash and schedules current inputs plus persistent future cutoff tasks.
export async function scheduleEntitlements(
  db: Database,
  s: Scope,
  platformId: string,
  date: string,
  reason: string,
  requestId: string,
  userId?: string,
  actorId: string | null = null,
  reasonCode: string = reason,
) {
  if (!entitlementsEnabled())
    throw new DomainError("entitlements_disabled", 409);
  return db.transaction(async (tx) => {
    const users = (
      await tx.query(
        `SELECT DISTINCT user_id FROM platform_identities WHERE brand_id=$1 AND bot_id=$2 AND platform_id=$3 AND ($4::uuid IS NULL OR user_id=$4) UNION SELECT user_id FROM daily_entitlements WHERE brand_id=$1 AND bot_id=$2 AND platform_id=$3 AND entitlement_date=$5 AND ($4::uuid IS NULL OR user_id=$4) LIMIT 501`,
        [s.brandId, s.botId, platformId, userId ?? null, date],
      )
    ).rows;
    if (users.length > 500)
      throw new DomainError("entitlement_scope_too_large", 400);
    let queued = 0;
    for (const u of users) {
      const t = { ...s, platformId, userId: u.user_id, entitlementDate: date };
      const x = await readEvaluationInput(tx, t, new Date());
      if (
        await queueEntitlement(
          tx,
          t,
          reason,
          inputFingerprint({ t, fingerprint: x.fingerprint }),
        )
      )
        queued++;
      if (x.cutoff > new Date().toISOString())
        await queueEntitlement(
          tx,
          t,
          "cutoff_sla",
          inputFingerprint({ t, cutoff: x.cutoff }),
          x.cutoff,
        );
    }
    await entitlementAudit(
      tx,
      s,
      "entitlement.recalculate",
      platformId,
      requestId,
      actorId,
      {
        date,
        reason: reasonCode,
        userId: userId ?? null,
        population: users.length,
      },
    );
    return { population: users.length, queued };
  });
}
export async function enqueueEntitlementSourceChange(
  tx: Queryable,
  brandId: string,
  platformId: string,
  trigger: string,
  eventId: string,
  sourceDate?: string,
  userId?: string,
  botId?: string,
) {
  if (!entitlementsEnabled()) return;
  const platform = await one(
    tx,
    "SELECT timezone FROM platforms WHERE brand_id=$1 AND id=$2",
    [brandId, platformId],
  );
  const today = dateInZone(new Date(), platform.timezone),
    date = sourceDate ? calendarDay(sourceDate, 1) : today;
  const targets = (
    await tx.query(
      `SELECT DISTINCT i.bot_id,i.user_id,$5::date::text AS entitlement_date FROM platform_identities i WHERE i.brand_id=$1 AND i.platform_id=$2 AND ($3::uuid IS NULL OR i.user_id=$3) AND ($4::uuid IS NULL OR i.bot_id=$4)
 AND ($5::date >= $6::date OR EXISTS(SELECT 1 FROM daily_entitlements d WHERE d.brand_id=i.brand_id AND d.bot_id=i.bot_id AND d.user_id=i.user_id AND d.platform_id=i.platform_id AND d.entitlement_date=$5))
 UNION SELECT bot_id,user_id,entitlement_date::text FROM daily_entitlements WHERE brand_id=$1 AND platform_id=$2 AND ($3::uuid IS NULL OR user_id=$3) AND ($4::uuid IS NULL OR bot_id=$4) AND $7::boolean AND entitlement_date>=$6::date`,
      [
        brandId,
        platformId,
        userId ?? null,
        botId ?? null,
        date,
        today,
        !sourceDate,
      ],
    )
  ).rows;
  for (const r of targets) {
    const t = {
      brandId,
      platformId,
      botId: r.bot_id,
      userId: r.user_id,
      entitlementDate: r.entitlement_date,
    };
    await queueEntitlement(
      tx,
      t,
      trigger,
      inputFingerprint({ t, eventId, trigger }),
    );
    const v = (
      await tx.query(
        `SELECT cutoff_time,source_timezone FROM entitlement_rule_versions WHERE brand_id=$1 AND bot_id=$2 AND platform_id=$3 AND status='published' AND $4::date BETWEEN effective_from AND effective_until`,
        [brandId, r.bot_id, platformId, r.entitlement_date],
      )
    ).rows;
    if (v.length === 1) {
      const cutoff = wallInstant(
        r.entitlement_date,
        v[0]!.cutoff_time.slice(0, 5),
        v[0]!.source_timezone,
      );
      if (cutoff > new Date().toISOString())
        await queueEntitlement(
          tx,
          t,
          "cutoff_sla",
          inputFingerprint({ t, cutoff }),
          cutoff,
        );
    }
  }
}
// P5-C may read this contract later; no downstream execution belongs here.
export async function currentEntitlement(db: Queryable, t: Target) {
  return (
    (
      await db.query(
        `SELECT d.id,r.id AS current_revision_id,r.status,r.matched_tier,r.rule_version_id,r.calculated_at,d.entitlement_date::text FROM daily_entitlements d JOIN daily_entitlement_revisions r ON r.id=d.current_revision_id WHERE d.brand_id=$1 AND d.bot_id=$2 AND d.user_id=$3 AND d.platform_id=$4 AND d.entitlement_type='member_daily_status' AND d.entitlement_date=$5`,
        [t.brandId, t.botId, t.userId, t.platformId, t.entitlementDate],
      )
    ).rows[0] ?? null
  );
}
