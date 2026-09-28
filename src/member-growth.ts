import { randomUUID } from "node:crypto";
import {
  DomainError,
  one,
  type Database,
  type Queryable,
  type Scope,
} from "./db.js";
import type { Principal } from "./auth.js";
import {
  dateInZone,
  calendarDay,
  wallInstant,
  decideEntitlement,
} from "./entitlement-domain.js";
import { resolveMappingSemantics } from "./entitlement-mapping.js";
import { readTrustedPlatformInput } from "./platform-trusted-input.js";
import {
  allocateDay,
  nextLevel,
  validateConfig,
  versionInput,
  growthConfig,
  platformConfig,
  inputFingerprint,
  type GrowthSource,
} from "./member-domain.js";
export const memberGrowthEnabled = () =>
  process.env.MEMBER_GROWTH_ENABLED === "true";
export function requireGrowth() {
  if (!memberGrowthEnabled())
    throw new DomainError("member_growth_disabled", 409);
}
export async function memberSchema(db: Queryable) {
  return (
    (await one(db, "SELECT to_regclass('members') IS NOT NULL AS ready"))
      .ready === true
  );
}
export async function memberAuthorize(
  tx: Queryable,
  p: Principal,
  brandId: string,
  permission: string,
) {
  const r = await tx.query(
    `SELECT a.id FROM admins a JOIN admin_roles ar ON ar.admin_id=a.id JOIN roles r ON r.id=ar.role_id JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions pm ON pm.id=rp.permission_id WHERE a.id=$1 AND a.status='active' AND pm.name=$2 AND ((ar.brand_id=$3 AND ar.bot_id IS NULL) OR (ar.brand_id IS NULL AND r.name='Super Admin')) LIMIT 1`,
    [p.adminId, permission, brandId],
  );
  if (!r.rows.length) throw new DomainError("forbidden", 403);
}
export async function growthAudit(
  tx: Queryable,
  brandId: string,
  action: string,
  id: string,
  requestId: string,
  adminId: string | null = null,
  data: unknown = {},
) {
  await tx.query(
    `INSERT INTO audit_logs(brand_id,admin_id,action,object_type,object_id,request_id,after_data) VALUES($1,$2,$3,'member_growth',$4,$5,$6)`,
    [brandId, adminId, action, id, requestId, JSON.stringify(data)],
  );
}
export async function activeMemberRule(
  tx: Queryable,
  brandId: string,
  kind: string,
  date: string,
  platformId: string | null = null,
) {
  const rows = (
    await tx.query(
      `SELECT * FROM member_rule_versions WHERE brand_id=$1 AND kind=$2 AND platform_id IS NOT DISTINCT FROM $3::uuid AND status='published' AND effective_from<=$4::date AND effective_until>=$4::date`,
      [brandId, kind, platformId, date],
    )
  ).rows;
  if (rows.length !== 1)
    throw new DomainError("member_rule_not_available", 409);
  return rows[0]!;
}
export async function createMemberRule(
  db: Database,
  p: Principal,
  brandId: string,
  raw: unknown,
  requestId: string,
) {
  const v = versionInput.parse(raw),
    config = validateConfig(v.kind, v.config);
  return db.transaction(async (tx) => {
    await memberAuthorize(
      tx,
      p,
      brandId,
      v.kind === "level" ? "member.levels.manage" : "growth.rules.manage",
    );
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      brandId,
    ]);
    let approval = null;
    if (v.kind === "platform") {
      const c = platformConfig.parse(config);
      const platform = await one(
        tx,
        "SELECT * FROM platforms WHERE brand_id=$1 AND id=$2",
        [brandId, v.platformId],
      );
      if (platform.currency !== c.currency || platform.timezone !== c.timezone)
        throw new DomainError("growth_platform_config_mismatch", 409);
      approval = await resolveMappingSemantics(
        tx,
        { brandId, botId: "" },
        v.platformId!,
        c.mappingBatchId,
        c.currency,
        c.timezone,
      );
    }
    const row = await one(
      tx,
      `INSERT INTO member_rule_versions(brand_id,kind,platform_id,version,effective_from,effective_until,config,mapping_approval,created_by) SELECT $1,$2,$3,coalesce(max(version),0)+1,$4,$5,$6,$7,$8 FROM member_rule_versions WHERE brand_id=$1 AND kind=$2 AND platform_id IS NOT DISTINCT FROM $3::uuid RETURNING *`,
      [
        brandId,
        v.kind,
        v.platformId,
        v.effectiveFrom,
        v.effectiveUntil,
        JSON.stringify(config),
        approval ? JSON.stringify(approval) : null,
        p.adminId,
      ],
    );
    await growthAudit(
      tx,
      brandId,
      "member.rule.create",
      row.id,
      requestId,
      p.adminId,
      { kind: v.kind, version: row.version },
    );
    return row;
  });
}
export async function publishMemberRule(
  db: Database,
  p: Principal,
  brandId: string,
  id: string,
  requestId: string,
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      brandId,
    ]);
    const row = await one(
      tx,
      "SELECT *,effective_from::text,effective_until::text FROM member_rule_versions WHERE brand_id=$1 AND id=$2 FOR UPDATE",
      [brandId, id],
    );
    await memberAuthorize(
      tx,
      p,
      brandId,
      row.kind === "level" ? "member.levels.publish" : "growth.rules.publish",
    );
    if (row.status !== "draft")
      throw new DomainError("member_rule_not_draft", 409);
    validateConfig(row.kind, row.config);
    const zone =
      row.config.timezone ??
      (
        await tx.query(
          `SELECT config->>'timezone' AS zone FROM member_rule_versions WHERE brand_id=$1 AND kind='growth' AND status='published' ORDER BY version DESC LIMIT 1`,
          [brandId],
        )
      ).rows[0]?.zone;
    if (!zone) throw new DomainError("member_timezone_required", 409);
    if (row.effective_until < dateInZone(now, zone))
      throw new DomainError("member_rule_date_expired", 409);
    if (row.kind === "platform") {
      const fresh = await resolveMappingSemantics(
        tx,
        { brandId, botId: "" },
        row.platform_id,
        row.config.mappingBatchId,
        row.config.currency,
        row.config.timezone,
      );
      if (inputFingerprint(fresh) !== inputFingerprint(row.mapping_approval))
        throw new DomainError("member_mapping_changed", 409);
    }
    if (row.kind === "growth") {
      const prior = (
        await tx.query(
          `SELECT config->>'timezone' AS zone FROM member_rule_versions WHERE brand_id=$1 AND kind='growth' AND status='published' LIMIT 1`,
          [brandId],
        )
      ).rows[0];
      if (prior && prior.zone !== row.config.timezone)
        throw new DomainError("member_timezone_change_requires_review", 409);
    }
    const overlaps = await tx.query(
      `SELECT id FROM member_rule_versions WHERE brand_id=$1 AND kind=$2 AND platform_id IS NOT DISTINCT FROM $3::uuid AND status='published' AND effective_from<=$4::date AND effective_until>=$5::date`,
      [
        brandId,
        row.kind,
        row.platform_id,
        row.effective_until,
        row.effective_from,
      ],
    );
    if (overlaps.rows.length) throw new DomainError("member_rule_overlap", 409);
    await tx.query(
      "UPDATE member_rule_versions SET status='published',published_at=$3,published_by=$4 WHERE brand_id=$1 AND id=$2",
      [brandId, id, now, p.adminId],
    );
    await growthAudit(
      tx,
      brandId,
      "member.rule.publish",
      id,
      requestId,
      p.adminId,
    );
    return { id, status: "published" };
  });
}
export async function dryRunMembers(tx: Queryable, brandId: string) {
  return one(
    tx,
    `SELECT (SELECT count(*)::int FROM members WHERE brand_id=$1) AS existing_members,count(DISTINCT u.telegram_user_id)::int AS eligible_identities,count(*)::int AS eligible_links,count(DISTINCT u.telegram_user_id) FILTER(WHERE m.id IS NULL)::int AS new_members,count(*) FILTER(WHERE l.user_id IS NULL)::int AS new_links FROM telegram_users u LEFT JOIN members m ON m.brand_id=u.brand_id AND m.telegram_user_id=u.telegram_user_id LEFT JOIN member_user_links l ON l.brand_id=u.brand_id AND l.bot_id=u.bot_id AND l.user_id=u.id WHERE u.brand_id=$1 AND u.status='active'`,
    [brandId],
  );
}
// Cutover invokes this service only after its separate approval. No cutover endpoint.
export async function initializeMember(
  tx: Queryable,
  s: Scope & { userId: string },
  now = new Date(),
) {
  const u = await one(
    tx,
    "SELECT telegram_user_id FROM telegram_users WHERE brand_id=$1 AND bot_id=$2 AND id=$3 AND status='active'",
    [s.brandId, s.botId, s.userId],
  );
  const existing = (
    await tx.query(
      "SELECT * FROM members WHERE brand_id=$1 AND telegram_user_id=$2",
      [s.brandId, u.telegram_user_id],
    )
  ).rows[0];
  let m = existing;
  if (!m) {
    const policy = (
      await tx.query(
        `SELECT * FROM member_rule_versions WHERE brand_id=$1 AND kind='growth' AND status='published' ORDER BY version DESC LIMIT 1`,
        [s.brandId],
      )
    ).rows[0];
    if (!policy) throw new DomainError("member_rule_not_available", 409);
    const day = dateInZone(now, policy.config.timezone);
    const level = await activeMemberRule(tx, s.brandId, "level", day);
    m = (
      await tx.query(
        `INSERT INTO members(brand_id,telegram_user_id,level_rule_id,initialized_at,created_at) VALUES($1,$2,$3,$4,$4) ON CONFLICT(brand_id,telegram_user_id) DO NOTHING RETURNING *`,
        [s.brandId, u.telegram_user_id, level.id, now],
      )
    ).rows[0];
    if (m) {
      await tx.query(
        "INSERT INTO growth_accounts(brand_id,member_id) VALUES($1,$2)",
        [s.brandId, m.id],
      );
      await tx.query(
        `INSERT INTO member_level_history(brand_id,member_id,new_level,growth_balance,rule_version_id,reason_code,created_at) VALUES($1,$2,1,0,$3,'initialization',$4)`,
        [s.brandId, m.id, level.id, now],
      );
      await growthAudit(
        tx,
        s.brandId,
        "member.initialized",
        m.id,
        "member-initialize",
      );
    } else
      m = await one(
        tx,
        "SELECT * FROM members WHERE brand_id=$1 AND telegram_user_id=$2",
        [s.brandId, u.telegram_user_id],
      );
  }
  await tx.query(
    `INSERT INTO member_user_links(brand_id,bot_id,user_id,member_id,telegram_user_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [s.brandId, s.botId, s.userId, m.id, u.telegram_user_id],
  );
  return m;
}
async function updateMemberLevel(
  tx: Queryable,
  brandId: string,
  memberId: string,
  day: string,
  requestId: string,
  now = new Date(),
) {
  const m = await one(
    tx,
    "SELECT m.*,a.balance::text FROM members m JOIN growth_accounts a ON a.member_id=m.id WHERE m.brand_id=$1 AND m.id=$2 FOR UPDATE OF m",
    [brandId, memberId],
  );
  const rule = await activeMemberRule(tx, brandId, "level", day);
  const level = nextLevel(BigInt(m.balance), m.level, rule.config);
  const protectedLevel =
    BigInt(m.balance) < BigInt(rule.config.levels[m.level - 1].threshold);
  if (level > m.level) {
    await tx.query(
      "UPDATE members SET level=$3,level_rule_id=$4 WHERE brand_id=$1 AND id=$2",
      [brandId, memberId, level, rule.id],
    );
    await tx.query(
      `INSERT INTO member_level_history(brand_id,member_id,previous_level,new_level,growth_balance,rule_version_id,reason_code,created_at) VALUES($1,$2,$3,$4,$5,$6,'growth_threshold',$7)`,
      [brandId, memberId, m.level, level, m.balance, rule.id, now],
    );
    await growthAudit(
      tx,
      brandId,
      "member.level.changed",
      memberId,
      requestId,
      null,
      { previous: m.level, level },
    );
  } else if (protectedLevel) {
    const last = (
      await tx.query(
        "SELECT reason_code,growth_balance::text,rule_version_id FROM member_level_history WHERE member_id=$1 ORDER BY ordinal DESC LIMIT 1",
        [memberId],
      )
    ).rows[0];
    if (
      last?.reason_code !== "level_protected_v1" ||
      last.growth_balance !== m.balance ||
      last.rule_version_id !== rule.id
    )
      await tx.query(
        `INSERT INTO member_level_history(brand_id,member_id,previous_level,new_level,growth_balance,rule_version_id,reason_code,created_at) VALUES($1,$2,$3,$3,$4,$5,'level_protected_v1',$6)`,
        [brandId, memberId, m.level, m.balance, rule.id, now],
      );
  }
}
export async function reconcileGrowthDay(
  tx: Queryable,
  brandId: string,
  memberId: string,
  day: string,
  requestId: string,
  now = new Date(),
) {
  await one(
    tx,
    "SELECT member_id FROM growth_accounts WHERE brand_id=$1 AND member_id=$2 FOR UPDATE",
    [brandId, memberId],
  );
  const policy = await activeMemberRule(tx, brandId, "growth", day);
  growthConfig.parse(policy.config);
  const sources = (
    await tx.query(
      `SELECT s.*,e.id AS evaluation_id,e.status,e.requested_growth FROM growth_sources s JOIN growth_evaluation_revisions e ON e.id=s.current_evaluation_id WHERE s.brand_id=$1 AND s.member_id=$2 AND s.business_date=$3::date ORDER BY s.id`,
      [brandId, memberId, day],
    )
  ).rows;
  // Unknown evidence is not zero: retain previously credited attribution; other confirmed sources can proceed.
  for (const s of sources) {
    if (s.status === "pending" || s.status === "review_required") {
      const prior = await one(
        tx,
        "SELECT coalesce(sum(delta),0)::int AS n FROM growth_ledger WHERE member_id=$1 AND source_id=$2",
        [memberId, s.id],
      );
      s.requested_growth = prior.n;
      s.allocation_status = "eligible";
    } else s.allocation_status = s.status;
  }
  const allocation = allocateDay(
    sources.map((s) => ({
      id: s.id,
      orderKey: s.source_key,
      kind: s.source_type,
      requested: s.requested_growth,
      occurredAt: new Date(s.occurred_at).toISOString(),
      status: s.allocation_status,
    })),
  );
  const fingerprint = inputFingerprint({
    policy: policy.id,
    sources: sources.map((s) => [s.id, s.evaluation_id]),
    allocation,
  });
  const old = (
    await tx.query(
      "SELECT id FROM growth_daily_reconciliations WHERE member_id=$1 AND business_date=$2 AND input_fingerprint=$3",
      [memberId, day, fingerprint],
    )
  ).rows[0];
  if (old) return { id: old.id, unchanged: true };
  const rec = await one(
    tx,
    `INSERT INTO growth_daily_reconciliations(brand_id,member_id,business_date,policy_id,input_fingerprint,allocation,total) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      brandId,
      memberId,
      day,
      policy.id,
      fingerprint,
      JSON.stringify(allocation),
      allocation.reduce((n, a) => n + a.granted, 0),
    ],
  );
  const deltas = [];
  for (const a of allocation) {
    const prior = await one(
      tx,
      "SELECT coalesce(sum(delta),0)::text AS n,count(*)::int AS count FROM growth_ledger WHERE member_id=$1 AND source_id=$2",
      [memberId, a.id],
    );
    const delta = BigInt(a.granted) - BigInt(prior.n);
    if (delta !== 0n)
      deltas.push({
        id: a.id,
        delta,
        kind: prior.count ? "correction" : "grant",
      });
  }
  const account = await one(
    tx,
    "SELECT balance::text FROM growth_accounts WHERE member_id=$1",
    [memberId],
  );
  if (BigInt(account.balance) + deltas.reduce((n, d) => n + d.delta, 0n) < 0n)
    throw new DomainError("growth_correction_review_required", 409);
  // Positive deltas first avoid transient negative balances during attribution redistribution.
  deltas.sort((a, b) => (a.delta > b.delta ? -1 : 1));
  for (const d of deltas) {
    const ledger = await one(
      tx,
      `INSERT INTO growth_ledger(brand_id,member_id,source_id,reconciliation_id,delta,business_date,kind,reason_code,idempotency_key,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,'daily_reconciliation',$8,$9) RETURNING id`,
      [
        brandId,
        memberId,
        d.id,
        rec.id,
        String(d.delta),
        day,
        d.kind,
        `${rec.id}:${d.id}`,
        requestId,
      ],
    );
    await growthAudit(
      tx,
      brandId,
      d.kind === "grant" ? "growth.credited" : "growth.corrected",
      ledger.id,
      requestId,
      null,
      { delta: String(d.delta), reconciliationId: rec.id },
    );
  }
  const levelDay = dateInZone(now, policy.config.timezone);
  await updateMemberLevel(tx, brandId, memberId, levelDay, requestId, now);
  await growthAudit(tx, brandId, "growth.reconciled", rec.id, requestId, null, {
    entries: deltas.length,
    total: allocation.reduce((n, a) => n + a.granted, 0),
  });
  return { id: rec.id, allocation };
}
export async function recordGrowthEvaluation(
  tx: Queryable,
  input: {
    brandId: string;
    memberId: string;
    kind: GrowthSource;
    key: string;
    day: string;
    occurredAt: Date;
    policyId: string;
    ruleId: string;
    status: string;
    reason: string;
    requested: number;
    evidence: Record<string, unknown>;
  },
  requestId: string,
  now = new Date(),
) {
  requireGrowth();
  await one(
    tx,
    "SELECT member_id FROM growth_accounts WHERE brand_id=$1 AND member_id=$2 FOR UPDATE",
    [input.brandId, input.memberId],
  );
  let source = (
    await tx.query(
      `INSERT INTO growth_sources(brand_id,member_id,source_type,source_key,business_date,occurred_at,policy_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING *,business_date::text`,
      [
        input.brandId,
        input.memberId,
        input.kind,
        input.key,
        input.day,
        input.occurredAt,
        input.policyId,
      ],
    )
  ).rows[0];
  source ??= await one(
    tx,
    "SELECT *,business_date::text FROM growth_sources WHERE brand_id=$1 AND member_id=$2 AND source_type=$3 AND source_key=$4",
    [input.brandId, input.memberId, input.kind, input.key],
  );
  if (String(source.business_date).slice(0, 10) !== input.day)
    throw new DomainError("growth_source_date_conflict", 409);
  const fingerprint = inputFingerprint({
    rule: input.ruleId,
    status: input.status,
    requested: input.requested,
    evidence: input.evidence,
  });
  let e = (
    await tx.query(
      `INSERT INTO growth_evaluation_revisions(brand_id,member_id,source_id,rule_version_id,input_fingerprint,status,reason_code,requested_growth,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
      [
        input.brandId,
        input.memberId,
        source.id,
        input.ruleId,
        fingerprint,
        input.status,
        input.reason,
        input.requested,
        JSON.stringify(input.evidence),
      ],
    )
  ).rows[0];
  if (!e) {
    e = await one(
      tx,
      "SELECT id FROM growth_evaluation_revisions WHERE source_id=$1 AND input_fingerprint=$2",
      [source.id, fingerprint],
    );
    if (source.current_evaluation_id !== e.id)
      return { unchanged: true, stale: true };
  }
  await tx.query(
    "UPDATE growth_sources SET current_evaluation_id=$2 WHERE id=$1",
    [source.id, e.id],
  );
  return reconcileGrowthDay(
    tx,
    input.brandId,
    input.memberId,
    input.day,
    requestId,
    now,
  );
}
export async function evaluatePlatformGrowth(
  db: Database,
  t: Scope & { userId: string; platformId: string; sourceDate: string },
  requestId: string,
  now = new Date(),
) {
  requireGrowth();
  return db.transaction(async (tx) => {
    await one(
      tx,
      "SELECT id FROM platforms WHERE brand_id=$1 AND id=$2 FOR UPDATE",
      [t.brandId, t.platformId],
    );
    await requireActiveSource(tx, t);
    const x = await readTrustedPlatformInput(tx, t, t.sourceDate);
    const m = await initializeMember(tx, t, now);
    const entitlementDate = calendarDay(t.sourceDate, 1);
    const instant = wallInstant(entitlementDate, "00:00", x.platform.timezone);
    if (new Date(instant) > now)
      throw new DomainError("growth_day_not_due", 409);
    // Attribution begins after member cutover and verified identity; never backfill previous ownership.
    if (
      !x.identity ||
      new Date(x.identity.verified_at ?? now) >
        new Date(wallInstant(t.sourceDate, "00:00", x.platform.timezone)) ||
      new Date(m.initialized_at) >
        new Date(wallInstant(t.sourceDate, "00:00", x.platform.timezone))
    )
      throw new DomainError("growth_before_attribution", 409);
    const currentPolicy = (
      await tx.query(
        `SELECT * FROM member_rule_versions WHERE brand_id=$1 AND kind='growth' AND status='published' ORDER BY version DESC LIMIT 1`,
        [t.brandId],
      )
    ).rows[0];
    if (!currentPolicy) throw new DomainError("member_rule_not_available", 409);
    const day = dateInZone(new Date(instant), currentPolicy.config.timezone),
      policy = await activeMemberRule(tx, t.brandId, "growth", day),
      rule = await activeMemberRule(
        tx,
        t.brandId,
        "platform",
        entitlementDate,
        t.platformId,
      ),
      c = platformConfig.parse(rule.config);
    let mapping: Record<string, unknown> = {},
      compatible = false;
    if (x.fact)
      try {
        mapping = await resolveMappingSemantics(
          tx,
          t,
          t.platformId,
          x.fact.batch_id,
          c.currency,
          c.timezone,
        );
        compatible =
          inputFingerprint(mapping) === inputFingerprint(rule.mapping_approval);
      } catch {}
    const decision = decideEntitlement({
      identityStatus: x.identity.status,
      ruleAvailable: true,
      factPresent: !!x.fact,
      completeness: x.fact?.completeness,
      conflicting:
        x.conflicts.length > 0 || x.fact?.batch_status === "review_required",
      metricAvailable: mapping.canonicalField === "deposit",
      mappingCompatible: compatible,
      value: x.fact?.deposit ?? null,
      factCurrency: x.fact?.currency,
      ruleCurrency: c.currency,
      cutoffReached:
        now >= new Date(wallInstant(entitlementDate, "12:00", c.timezone)),
      tiers: c.tiers.map((a, i) => ({
        key: String(i),
        threshold: a.threshold,
      })),
    });
    const status =
      decision.status === "ineligible" ? "not_applicable" : decision.status;
    const requested =
      status === "eligible" ? c.tiers[Number(decision.matchedTier)]!.growth : 0;
    return recordGrowthEvaluation(
      tx,
      {
        brandId: t.brandId,
        memberId: m.id,
        kind: "platform_daily",
        key: `${t.platformId}:${t.sourceDate}`,
        day,
        occurredAt: new Date(instant),
        policyId: policy.id,
        ruleId: rule.id,
        status,
        reason: decision.reasonCode,
        requested,
        evidence: {
          platformId: t.platformId,
          identityId: x.identity.id,
          sourceDate: t.sourceDate,
          factId: x.fact?.id ?? null,
          factRevisionId: x.fact?.current_revision_id ?? null,
          mapping,
          conflicts: x.conflicts,
        },
      },
      requestId,
      now,
    );
  });
}
export async function memberPolicy(tx: Queryable, brandId: string, now: Date) {
  const p = (
    await tx.query(
      `SELECT config->>'timezone' AS timezone FROM member_rule_versions WHERE brand_id=$1 AND kind='growth' AND status='published' ORDER BY version DESC LIMIT 1`,
      [brandId],
    )
  ).rows[0];
  if (!p) throw new DomainError("member_rule_not_available", 409);
  return activeMemberRule(tx, brandId, "growth", dateInZone(now, p.timezone));
}
export async function checkinGrowth(
  db: Database,
  s: Scope & { userId: string },
  requestId: string,
  now = new Date(),
) {
  requireGrowth();
  return db.transaction(async (tx) => {
    await requireActiveSource(tx, s);
    const policy = await memberPolicy(tx, s.brandId, now),
      m = await initializeMember(tx, s, now),
      day = dateInZone(now, policy.config.timezone);
    return recordGrowthEvaluation(
      tx,
      {
        brandId: s.brandId,
        memberId: m.id,
        kind: "daily_checkin",
        key: day,
        day,
        occurredAt: new Date(wallInstant(day, "00:00", policy.config.timezone)),
        policyId: policy.id,
        ruleId: policy.id,
        status: "eligible",
        reason: "daily_checkin",
        requested: 5,
        evidence: { day },
      },
      requestId,
      now,
    );
  });
}
// Internal completion contract: no HTTP endpoint accepting client-asserted task/referral success.
// The producer revalidates authoritative completion inside this transaction.
export async function confirmedGrowth(
  db: Database,
  s: Scope & { userId: string },
  verify: (tx: Queryable) => Promise<{
    kind: "qualified_referral" | "member_task";
    key: string;
    at: Date;
    growth: number;
    evidenceId: string;
  }>,
  requestId: string,
  now = new Date(),
) {
  requireGrowth();
  return db.transaction(async (tx) => {
    await requireActiveSource(tx, s);
    const c = await verify(tx);
    if (
      c.at > now ||
      !c.evidenceId ||
      !c.key ||
      c.key.length > 160 ||
      (c.kind === "qualified_referral"
        ? c.growth !== 50
        : ![10, 20, 30, 50].includes(c.growth))
    )
      throw new DomainError("growth_completion_invalid", 400);
    const policy = await memberPolicy(tx, s.brandId, c.at),
      m = await initializeMember(tx, s, now);
    if (c.at < new Date(m.initialized_at))
      throw new DomainError("growth_before_attribution", 409);
    const day = dateInZone(c.at, policy.config.timezone);
    return recordGrowthEvaluation(
      tx,
      {
        brandId: s.brandId,
        memberId: m.id,
        kind: c.kind,
        key: c.key,
        day,
        occurredAt: c.at,
        policyId: policy.id,
        ruleId: policy.id,
        status: "eligible",
        reason: c.kind,
        requested: c.growth,
        evidence: { completionId: c.evidenceId },
      },
      requestId,
      now,
    );
  });
}
export async function adjustGrowth(
  db: Database,
  p: Principal,
  brandId: string,
  memberId: string,
  delta: string,
  reason: string,
  key: string,
  requestId: string,
  now = new Date(),
) {
  requireGrowth();
  if (!/^-?[1-9]\d{0,8}$/.test(delta) || !reason.trim() || reason.length > 100)
    throw new DomainError("growth_adjustment_invalid", 400);
  return db.transaction(async (tx) => {
    await memberAuthorize(tx, p, brandId, "growth.adjust");
    const a = await one(
      tx,
      "SELECT balance::text FROM growth_accounts WHERE brand_id=$1 AND member_id=$2 FOR UPDATE",
      [brandId, memberId],
    );
    const previous = (
      await tx.query(
        "SELECT id,delta::text,reason_code,admin_id FROM growth_ledger WHERE member_id=$1 AND idempotency_key=$2",
        [memberId, `admin:${key}`],
      )
    ).rows[0];
    if (previous) {
      if (
        previous.delta !== delta ||
        previous.reason_code !== reason ||
        previous.admin_id !== p.adminId
      )
        throw new DomainError("growth_idempotency_conflict", 409);
      return { id: previous.id, unchanged: true };
    }
    if (BigInt(a.balance) + BigInt(delta) < 0n)
      throw new DomainError("growth_insufficient_balance", 409);
    const policy = await memberPolicy(tx, brandId, now),
      day = dateInZone(now, policy.config.timezone);
    const l = await one(
      tx,
      `INSERT INTO growth_ledger(brand_id,member_id,delta,business_date,kind,reason_code,idempotency_key,admin_id,request_id) VALUES($1,$2,$3,$4,'admin_adjustment',$5,$6,$7,$8) RETURNING id`,
      [
        brandId,
        memberId,
        delta,
        day,
        reason,
        `admin:${key}`,
        p.adminId,
        requestId,
      ],
    );
    await updateMemberLevel(tx, brandId, memberId, day, requestId, now);
    await growthAudit(
      tx,
      brandId,
      "growth.adjusted",
      l.id,
      requestId,
      p.adminId,
      { delta },
    );
    return l;
  });
}
export async function miniMemberSummary(
  db: Database,
  s: Scope & { userId: string },
  now = new Date(),
) {
  if (!memberGrowthEnabled() || !(await memberSchema(db)))
    return { enabled: false, available: false };
  return db.transaction(async (tx) => {
    const m = await initializeMember(tx, s, now),
      policy = await memberPolicy(tx, s.brandId, now),
      day = dateInZone(now, policy.config.timezone);
    await one(
      tx,
      "SELECT member_id FROM growth_accounts WHERE member_id=$1 FOR UPDATE",
      [m.id],
    );
    await updateMemberLevel(tx, s.brandId, m.id, day, "member-summary");
    const current = await one(
      tx,
      "SELECT m.level,a.balance::text FROM members m JOIN growth_accounts a ON a.member_id=m.id WHERE m.id=$1",
      [m.id],
    );
    const rule = await activeMemberRule(tx, s.brandId, "level", day);
    const levels = rule.config.levels,
      threshold = BigInt(levels[current.level - 1].threshold),
      next = levels[current.level],
      growth = BigInt(current.balance);
    const today = await one(
      tx,
      "SELECT coalesce(sum(delta),0)::text AS n FROM growth_ledger WHERE member_id=$1 AND business_date=$2 AND kind<>'admin_adjustment'",
      [m.id, day],
    );
    return {
      enabled: true,
      available: true,
      level: current.level,
      levelName: levels[current.level - 1].name,
      growth: current.balance,
      nextThreshold: next ? String(next.threshold) : null,
      progress: next
        ? Math.max(
            0,
            Math.min(
              100,
              Number(
                ((growth - threshold) * 100n) /
                  BigInt(next.threshold - levels[current.level - 1].threshold),
              ),
            ),
          )
        : 100,
      protected: growth < threshold,
      todayGrowth: today.n,
      dailyCap: 350,
      levels: levels.map((l: any) => ({
        key: l.key,
        name: l.name,
        threshold: l.threshold,
      })),
      benefitsAvailable: false,
    };
  });
}
export async function runGrowthTasks(
  db: Database,
  limit = 10,
  now = new Date(),
) {
  requireGrowth();
  const out = [];
  for (let i = 0; i < limit; i++) {
    const token = randomUUID();
    const task = await db.transaction(
      async (tx) =>
        (
          await tx.query(
            `WITH q AS (SELECT id FROM growth_evaluation_tasks WHERE attempts<5 AND ((status='queued' AND next_attempt_at<=$1) OR (status='running' AND lease_until<$1)) ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE growth_evaluation_tasks t SET status='running',attempts=attempts+1,lease_token=$2,lease_until=$1::timestamptz+interval '2 minutes' FROM q WHERE t.id=q.id RETURNING t.*,t.source_business_date::text`,
            [now, token],
          )
        ).rows[0],
    );
    if (!task) break;
    try {
      const result = await evaluatePlatformGrowth(
        db,
        {
          brandId: task.brand_id,
          botId: task.bot_id,
          userId: task.user_id,
          platformId: task.platform_id,
          sourceDate: task.source_business_date,
        },
        `growth-task:${task.id}`,
        now,
      );
      await db.query(
        `UPDATE growth_evaluation_tasks SET status='completed',completed_at=$3,lease_until=NULL WHERE id=$1 AND lease_token=$2`,
        [task.id, token, now],
      );
      out.push({ id: task.id, result });
    } catch (e) {
      const code = e instanceof DomainError ? e.code : "growth_task_failed";
      const retry =
        (!(e instanceof DomainError) && task.attempts < 5) ||
        code === "growth_day_not_due";
      await db.query(
        `UPDATE growth_evaluation_tasks SET status=$3,last_error_code=$4,attempts=CASE WHEN $4='growth_day_not_due' THEN greatest(attempts-1,0) ELSE attempts END,next_attempt_at=$5::timestamptz+interval '5 minutes',lease_until=NULL WHERE id=$1 AND lease_token=$2`,
        [task.id, token, retry ? "queued" : "failed", code, now],
      );
      out.push({ id: task.id, error: code });
    }
  }
  return out;
}
// Durable daily catch-up. The timer is only a wake-up mechanism; dates and jobs live in PostgreSQL.
export async function scheduleGrowthTasks(db: Database, now = new Date()) {
  if (!memberGrowthEnabled()) return 0;
  const r = await db.query(
    `INSERT INTO growth_evaluation_tasks(brand_id,bot_id,user_id,platform_id,source_business_date,event_key,next_attempt_at)
 SELECT i.brand_id,i.bot_id,i.user_id,i.platform_id,(d.day::date-1),'daily:'||d.day::date::text,$1
 FROM platform_identities i JOIN member_user_links l ON (l.brand_id,l.bot_id,l.user_id)=(i.brand_id,i.bot_id,i.user_id)
 JOIN members m ON m.id=l.member_id JOIN member_rule_versions r ON r.brand_id=i.brand_id AND r.platform_id=i.platform_id AND r.kind='platform' AND r.status='published'
 CROSS JOIN LATERAL generate_series(greatest(r.effective_from,((greatest(i.verified_at,m.initialized_at) AT TIME ZONE (r.config->>'timezone'))::date+2)),least(r.effective_until,($1::timestamptz AT TIME ZONE (r.config->>'timezone'))::date),interval '1 day') d(day)
 WHERE i.status='verified' AND NOT EXISTS(SELECT 1 FROM growth_evaluation_tasks t WHERE t.brand_id=i.brand_id AND t.bot_id=i.bot_id AND t.user_id=i.user_id AND t.platform_id=i.platform_id AND t.source_business_date=d.day::date-1 AND t.event_key='daily:'||d.day::date::text) ORDER BY d.day,i.brand_id,i.user_id LIMIT 200 ON CONFLICT DO NOTHING RETURNING id`,
    [now],
  );
  return r.rows.length;
}

async function requireActiveSource(
  tx: Queryable,
  s: Scope & { userId: string },
) {
  const rows = await tx.query(
    "SELECT u.id FROM telegram_users u JOIN telegram_bots b ON b.id=u.bot_id JOIN brands br ON br.id=u.brand_id WHERE u.brand_id=$1 AND u.bot_id=$2 AND u.id=$3 AND u.status='active' AND b.status='active' AND br.status='active'",
    [s.brandId, s.botId, s.userId],
  );
  if (!rows.rows.length) throw new DomainError("member_source_inactive", 409);
}
