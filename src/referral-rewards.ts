import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainError, one, type Database, type Queryable, type Scope } from "./db.js";
import { authorize, type Principal } from "./auth.js";
import { postPoints } from "./points.js";

/**
 * Batch 2A is a separately approved write path. Any value other than the
 * exact string "true" keeps automatic, internal, and manual evaluation off.
 */
export const referralRewardsEnabled = () =>
  process.env.BATCH2A_REFERRAL_REWARDS_ENABLED === "true";

const referralRewardScopeSchema = z.object({
  brandId: z.uuid(),
  botId: z.uuid(),
  platformId: z.uuid(),
}).strict();

type ReferralRewardScope = z.infer<typeof referralRewardScopeSchema>;

const scopeKey = (scope: ReferralRewardScope) =>
  `${scope.brandId}:${scope.botId}:${scope.platformId}`;

/**
 * Fail-closed server-side allowlist. A configured entry is one exact
 * Brand/Bot/Platform tuple; separate ID lists would accidentally allow their
 * Cartesian product. Invalid, empty, duplicate, or missing JSON disables all
 * referral reward writes.
 */
const referralRewardAllowedScopes = () => {
  if (!referralRewardsEnabled()) return null;
  const raw = process.env.BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON;
  if (!raw) return null;
  try {
    const parsed = z.array(referralRewardScopeSchema).min(1).max(100).safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const keys = parsed.data.map(scopeKey);
    if (new Set(keys).size !== keys.length) return null;
    return new Set(keys);
  } catch {
    return null;
  }
};

export const referralRewardScopeEnabled = (scope: ReferralRewardScope) =>
  referralRewardAllowedScopes()?.has(scopeKey(scope)) === true;

export async function authorizeBrand(tx: Queryable, p: Principal, brandId: string, permission: string) {
  const row = (await tx.query(
    `SELECT a.id FROM admins a JOIN admin_roles ar ON ar.admin_id=a.id
      JOIN roles r ON r.id=ar.role_id JOIN role_permissions rp ON rp.role_id=r.id
      JOIN permissions pm ON pm.id=rp.permission_id
     WHERE a.id=$1 AND a.status='active' AND pm.name=$2
       AND ((ar.brand_id=$3 AND ar.bot_id IS NULL) OR (ar.brand_id IS NULL AND r.name='Super Admin'))
     LIMIT 1`, [p.adminId, permission, brandId])).rows[0];
  if (!row) throw new DomainError("forbidden", 403);
}

const ruleBody = z.object({
  platformId: z.uuid(),
  campaignKey: z.string().trim().min(1).max(120),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  inviteeEnabled: z.boolean().default(false),
}).strict();

export const stableReferralUidFingerprint = (brandId: string, platformId: string, uid: string) =>
  createHash("sha256").update(`uid_fp_v1|${brandId}|${platformId}|${uid}`).digest("hex");

const evidenceFingerprint = (parts: string[]) =>
  createHash("sha256").update(`referral_evidence_v1|${parts.join("|")}`).digest("hex");

async function audit(tx: Queryable, brandId: string, botId: string | null, action: string, objectId: string, requestId: string, adminId: string | null = null, data: unknown = {}) {
  await tx.query(
    `INSERT INTO audit_logs(admin_id,brand_id,bot_id,action,object_type,object_id,request_id,after_data)
     VALUES($1,$2,$3,$4,'referral_reward',$5,$6,$7)`,
    [adminId, brandId, botId, action, objectId, requestId, JSON.stringify(data)],
  );
}

async function ruleForDate(tx: Queryable, brandId: string, platformId: string, date: string) {
  const rows = (await tx.query(
    `SELECT * FROM referral_reward_rule_versions
      WHERE brand_id=$1 AND platform_id=$2 AND status='published'
        AND effective_from <= $3::date
        AND (effective_until IS NULL OR effective_until >= $3::date)
      ORDER BY version DESC LIMIT 2 FOR UPDATE`,
    [brandId, platformId, date],
  )).rows;
  if (rows.length !== 1) throw new DomainError("referral_rule_not_available", 409);
  return rows[0]!;
}

async function businessDate(tx: Queryable, platformId: string, brandId: string) {
  return String((await one(tx,
    `SELECT ((clock_timestamp() AT TIME ZONE timezone)::date)::text AS date
       FROM platforms WHERE brand_id=$1 AND id=$2`, [brandId, platformId])).date);
}

async function existingOutcome(tx: Queryable, brandId: string, platformId: string, referralId: string) {
  const evidence = (await tx.query(
    `SELECT * FROM referral_qualification_evidence
      WHERE brand_id=$1 AND platform_id=$2 AND referral_id=$3
      ORDER BY created_at DESC,id DESC LIMIT 1`, [brandId, platformId, referralId])).rows[0];
  const events = (await tx.query(
    `SELECT id,reward_role,points,status FROM referral_reward_events
      WHERE brand_id=$1 AND platform_id=$2 AND referral_id=$3 ORDER BY reward_role`, [brandId, platformId, referralId])).rows;
  return evidence ? { evidence, events } : null;
}

/** Evaluate one verified platform identity. Caller may already hold the identity lock. */
export async function evaluateReferralByIdentityTx(tx: Queryable, identityId: string, requestId: string, adminId: string | null = null) {
  const allowedScopes = referralRewardAllowedScopes();
  if (!allowedScopes) return { status: "disabled" as const };
  const identity = await one(tx,
    `SELECT i.*,p.uid_case,p.timezone,p.status AS platform_status,p.id AS checked_platform_id
       FROM platform_identities i JOIN platforms p ON p.brand_id=i.brand_id AND p.id=i.platform_id
      WHERE i.id=$1`, [identityId]);
  if (!allowedScopes.has(scopeKey({
    brandId: identity.brand_id,
    botId: identity.bot_id,
    platformId: identity.platform_id,
  }))) return { status: "disabled" as const };
  const referral = (await tx.query(
    `SELECT * FROM referrals WHERE brand_id=$1 AND bot_id=$2 AND invitee_id=$3 FOR UPDATE`,
    [identity.brand_id, identity.bot_id, identity.user_id],
  )).rows[0];
  if (!referral) return { status: "no_referral" };
  if (identity.platform_status !== "active") return { status: "platform_unavailable" };
  const platformDate = await businessDate(tx, identity.platform_id, identity.brand_id);
  const previous = await existingOutcome(tx, identity.brand_id, identity.platform_id, referral.id);
  if (previous?.events.some((e: any) => e.status === "granted")) return { status: "already_rewarded", ...previous };
  if (previous?.evidence?.status === "cap_exceeded") return { status: "cap_exceeded", ...previous };

  let rule: any;
  try { rule = await ruleForDate(tx, identity.brand_id, identity.platform_id, platformDate); }
  catch (e) {
    if (e instanceof DomainError && e.code === "referral_rule_not_available")
      return { status: "rule_unavailable" };
    throw e;
  }
  const uid = identity.uid_case === "upper" ? String(identity.platform_uid).toUpperCase() : String(identity.platform_uid);
  const uidFingerprint = stableReferralUidFingerprint(identity.brand_id, identity.platform_id, uid);
  const priorUid = (await tx.query(
    `SELECT referral_id FROM referral_reward_events
      WHERE brand_id=$1 AND platform_id=$2 AND verified_uid_fingerprint=$3 AND status='granted'
     UNION ALL
     SELECT referral_id FROM referral_qualification_evidence
      WHERE brand_id=$1 AND platform_id=$2 AND verified_uid_fingerprint=$3 AND status IN ('verified','cap_exceeded')
     LIMIT 1`,
    [identity.brand_id, identity.platform_id, uidFingerprint])).rows[0];
  const status = identity.status === "verified" && referral.status !== "invalid" ? "verified" : identity.status === "revoked" ? "revoked" : "conflict";
  if (priorUid && priorUid.referral_id !== referral.id) {
    const fp = evidenceFingerprint([referral.id, identity.id, rule.id, platformDate, "uid_bound_elsewhere"]);
    const ev = await one(tx, `INSERT INTO referral_qualification_evidence
      (brand_id,platform_id,bot_id,referral_id,invitee_user_id,platform_identity_id,verified_uid_fingerprint,rule_version_id,campaign_version,business_date,status,evidence_fingerprint,request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'manual_review',$11,$12)
      ON CONFLICT (brand_id,platform_id,referral_id,evidence_fingerprint) DO NOTHING RETURNING *`,
      [identity.brand_id,identity.platform_id,identity.bot_id,referral.id,identity.user_id,identity.id,uidFingerprint,rule.id,rule.campaign_key,platformDate,fp,requestId]);
    if (ev) await audit(tx, identity.brand_id, identity.bot_id, "referral.reward.review_required", ev.id, requestId, adminId, { reason: "uid_bound_elsewhere" });
    return { status: "manual_review", evidence: ev ?? (await existingOutcome(tx, identity.brand_id, identity.platform_id, referral.id))?.evidence };
  }
  const fp = evidenceFingerprint([referral.id, identity.id, rule.id, platformDate, status]);
  if (status !== "verified") {
    const ev = await one(tx, `INSERT INTO referral_qualification_evidence
      (brand_id,platform_id,bot_id,referral_id,invitee_user_id,platform_identity_id,verified_uid_fingerprint,rule_version_id,campaign_version,business_date,status,evidence_fingerprint,request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (brand_id,platform_id,referral_id,evidence_fingerprint) DO NOTHING RETURNING *`,
      [identity.brand_id,identity.platform_id,identity.bot_id,referral.id,identity.user_id,identity.id,uidFingerprint,rule.id,rule.campaign_key,platformDate,status,fp,requestId]);
    if (ev) await audit(tx, identity.brand_id, identity.bot_id, "referral.qualification.recorded", ev.id, requestId, adminId, { status });
    return { status, evidence: ev ?? (await existingOutcome(tx, identity.brand_id, identity.platform_id, referral.id))?.evidence };
  }
  const inviterMember = (await tx.query(
    `SELECT member_id FROM member_user_links WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3`,
    [identity.brand_id, identity.bot_id, referral.inviter_id])).rows[0];
  if (!inviterMember) return { status: "member_required" };
  await tx.query(
    `INSERT INTO referral_reward_daily_counters(brand_id,platform_id,inviter_member_id,business_date)
       VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [identity.brand_id,identity.platform_id,inviterMember.member_id,platformDate]);
  const locked = await one(tx, `SELECT * FROM referral_reward_daily_counters
    WHERE brand_id=$1 AND platform_id=$2 AND inviter_member_id=$3 AND business_date=$4 FOR UPDATE`,
    [identity.brand_id,identity.platform_id,inviterMember.member_id,platformDate]);
  const overCap = Number(locked.qualified_count) >= Number(locked.cap);
  await tx.query(`UPDATE referral_reward_daily_counters SET qualified_count=qualified_count+1,updated_at=now()
    WHERE brand_id=$1 AND platform_id=$2 AND inviter_member_id=$3 AND business_date=$4`,
    [identity.brand_id,identity.platform_id,inviterMember.member_id,platformDate]);
  const evidenceStatus = status === "verified" && !overCap ? "verified" : overCap ? "cap_exceeded" : status;
  const evidence = await one(tx, `INSERT INTO referral_qualification_evidence
    (brand_id,platform_id,bot_id,referral_id,invitee_user_id,platform_identity_id,verified_uid_fingerprint,rule_version_id,campaign_version,business_date,status,evidence_fingerprint,request_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (brand_id,platform_id,referral_id,evidence_fingerprint) DO NOTHING RETURNING *`,
    [identity.brand_id,identity.platform_id,identity.bot_id,referral.id,identity.user_id,identity.id,uidFingerprint,rule.id,rule.campaign_key,platformDate,evidenceStatus,fp,requestId]);
  if (!evidence) return { status: "duplicate", ...(await existingOutcome(tx, identity.brand_id, identity.platform_id, referral.id)) };
  if (evidenceStatus !== "verified") {
    await audit(tx, identity.brand_id, identity.bot_id, "referral.qualification.recorded", evidence.id, requestId, adminId, { status: evidenceStatus });
    return { status: evidenceStatus, evidence };
  }
  if (referral.status === "bound") await tx.query("UPDATE referrals SET status='qualified' WHERE id=$1", [referral.id]);
  const roles: Array<[string,string,string]> = [["inviter", referral.inviter_id, String(rule.inviter_points)]];
  if (rule.invitee_enabled) roles.push(["invitee", referral.invitee_id, String(rule.invitee_points)]);
  const events: any[] = [];
  for (const [role, recipient, points] of roles) {
    const event = await one(tx, `INSERT INTO referral_reward_events
      (brand_id,platform_id,bot_id,referral_id,evidence_id,rule_version_id,verified_uid_fingerprint,reward_role,recipient_user_id,points,status,idempotency_key,request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'granted',$11,$12) RETURNING *`,
      [identity.brand_id,identity.platform_id,identity.bot_id,referral.id,evidence.id,rule.id,uidFingerprint,role,recipient,points,`referral:${referral.id}:${role}`,requestId]);
    await postPoints(tx, { brandId: identity.brand_id, botId: identity.bot_id, userId: recipient, delta: points, source: "referral", businessType: "referral_reward", businessId: event.id, idempotencyKey: `referral:${event.id}:${role}`, note: "Batch 2A verified referral reward" });
    events.push(event);
    await audit(tx, identity.brand_id, identity.bot_id, "referral.reward.granted", event.id, requestId, adminId, { role, points, evidenceId: evidence.id, ruleVersionId: rule.id });
  }
  await tx.query(`UPDATE referral_reward_daily_counters SET rewarded_count=rewarded_count+1,updated_at=now()
    WHERE brand_id=$1 AND platform_id=$2 AND inviter_member_id=$3 AND business_date=$4`,
    [identity.brand_id,identity.platform_id,inviterMember.member_id,platformDate]);
  await tx.query("UPDATE referrals SET reward_status='rewarded' WHERE id=$1", [referral.id]);
  return { status: "granted", evidence, events };
}

export async function evaluateReferralReward(db: Database, p: Principal, s: Scope, referralId: string, requestId: string) {
  return db.transaction(async (tx) => {
    await authorize(tx, p, s, "referrals.evaluate");
    if (!referralRewardAllowedScopes()) return { status: "disabled" as const };
    const referral = await one(tx, "SELECT invitee_id FROM referrals WHERE brand_id=$1 AND bot_id=$2 AND id=$3", [s.brandId,s.botId,referralId]);
    const identity = (await tx.query(`SELECT id FROM platform_identities WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3 AND status IN ('verified','conflict','revoked') ORDER BY submitted_at DESC,id DESC LIMIT 1`, [s.brandId,s.botId,referral.invitee_id])).rows[0];
    if (!identity) return { status: "waiting_for_verified_uid" };
    return evaluateReferralByIdentityTx(tx, identity.id, requestId, p.adminId);
  });
}

export async function reviewReferralReward(db: Database, p: Principal, s: Scope, referralId: string, raw: unknown, requestId: string) {
  const body = z.object({ note: z.string().trim().min(1).max(500) }).strict().parse(raw);
  return db.transaction(async tx => {
    await authorize(tx, p, s, "referrals.reward.review");
    const referral = await one(tx, "SELECT id,status,reward_status FROM referrals WHERE brand_id=$1 AND bot_id=$2 AND id=$3", [s.brandId,s.botId,referralId]);
    await audit(tx, s.brandId, s.botId, "referral.reward.review", referralId, requestId, p.adminId, { note: body.note });
    return { referral, reviewed: true };
  });
}

export async function createReferralRule(db: Database, p: Principal, brandId: string, body: unknown, requestId: string) {
  const v = ruleBody.parse(body);
  if (v.effectiveUntil && v.effectiveUntil < v.effectiveFrom) throw new DomainError("invalid_effective_window", 400);
  return db.transaction(async tx => {
    await authorizeBrand(tx, p, brandId, "referrals.rules.manage");
    const platform = await one(tx, "SELECT status FROM platforms WHERE brand_id=$1 AND id=$2", [brandId,v.platformId]);
    if (platform.status !== "active") throw new DomainError("platform_unavailable", 409);
    const row = await one(tx, `INSERT INTO referral_reward_rule_versions
      (brand_id,platform_id,campaign_key,version,effective_from,effective_until,invitee_enabled,created_by)
      SELECT $1,$2,$3,coalesce(max(version),0)+1,$4,$5,$6,$7 FROM referral_reward_rule_versions WHERE brand_id=$1 AND platform_id=$2 RETURNING *`,
      [brandId,v.platformId,v.campaignKey,v.effectiveFrom,v.effectiveUntil ?? null,v.inviteeEnabled,p.adminId]);
    await audit(tx,brandId,null,"referral.rule.create",row.id,requestId,p.adminId,{version:row.version});
    return row;
  });
}

export async function changeReferralRule(db: Database, p: Principal, brandId: string, id: string, action: "publish"|"disable", requestId: string) {
  return db.transaction(async tx => {
    await tx.query("SELECT id FROM referral_reward_rule_versions WHERE brand_id=$1 AND id=$2 FOR UPDATE",[brandId,id]);
    await authorizeBrand(tx,p,brandId,"referrals.rules."+(action === "publish" ? "publish" : "manage"));
    const row = await one(tx,"SELECT * FROM referral_reward_rule_versions WHERE brand_id=$1 AND id=$2 FOR UPDATE",[brandId,id]);
    if (action === "publish") {
      if (row.status !== "draft") throw new DomainError("referral_rule_not_draft",409);
      await tx.query("UPDATE referral_reward_rule_versions SET status='published',published_at=now(),published_by=$3 WHERE brand_id=$1 AND id=$2",[brandId,id,p.adminId]);
    } else {
      if (row.status !== "published") throw new DomainError("referral_rule_not_published",409);
      await tx.query("UPDATE referral_reward_rule_versions SET status='disabled',disabled_at=now(),disabled_by=$3 WHERE brand_id=$1 AND id=$2",[brandId,id,p.adminId]);
    }
    await audit(tx,brandId,null,`referral.rule.${action}`,id,requestId,p.adminId,{});
    return one(tx,"SELECT * FROM referral_reward_rule_versions WHERE id=$1",[id]);
  });
}
