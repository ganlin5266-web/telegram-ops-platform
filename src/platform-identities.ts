import {queueGrowthSourceChange} from './member-task-queue.js';
import {enqueueEntitlementSourceChange} from './entitlements.js';
import { z } from "zod";
import {
  DomainError,
  one,
  type Database,
  type Queryable,
  type Scope,
} from "./db.js";
import { authorize, type Principal } from "./auth.js";
import type { MiniPrincipal } from "./mini-sessions.js";
export const platformInput = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,47}$/),
    displayName: z.string().trim().min(1).max(100),
    market: z.string().regex(/^[A-Z]{2}$/),
    timezone: z
      .string()
      .max(100)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }),
    currency: z.string().regex(/^[A-Z]{3}$/),
    verificationMethod: z.enum([
      "manual_admin",
      "platform_api",
      "platform_import",
      "automation",
    ]),
    uidFormat: z.enum(["digits", "alphanumeric"]),
    uidCase: z.enum(["upper", "sensitive"]),
    uidMinLength: z.number().int().min(1).max(64),
    uidMaxLength: z.number().int().min(1).max(64),
  })
  .strict()
  .refine((v) => v.uidMaxLength >= v.uidMinLength);
export const maskUid = (v: string) =>
  v.length < 5 ? "****" : `${v.slice(0, 2)}****${v.slice(-2)}`;
export function canonicalUid(raw: string, p: Record<string, any>) {
  let uid = raw.trim();
  if (p.uid_case === "upper") uid = uid.toUpperCase();
  if (
    uid.length < p.uid_min_length ||
    uid.length > p.uid_max_length ||
    !(p.uid_format === "digits" ? /^[0-9]+$/ : /^[A-Za-z0-9_-]+$/).test(uid)
  )
    throw new DomainError("uid_format_invalid", 400);
  return uid;
}
export function safeIdentity(r: Record<string, any>, admin = false) {
  return {
    id: r.id,
    platformId: r.platform_id,
    platformName: r.display_name,
    uidMasked: maskUid(r.platform_uid),
    status: r.status,
    verificationMethod: r.verification_method,
    submittedAt: r.submitted_at,
    verifiedAt: r.verified_at,
    rejectedAt: r.rejected_at,
    revokedAt: r.revoked_at,
    ...(admin
      ? { userId: r.user_id, botId: r.bot_id, reasonCode: r.reason_code }
      : {}),
  };
}
export async function identityAudit(
  tx: Queryable,
  s: Scope,
  action: string,
  id: string,
  requestId: string,
  adminId: string | null = null,
  reason?: string,
) {
  await tx.query(
    `INSERT INTO audit_logs(admin_id,brand_id,bot_id,action,object_type,object_id,request_id,after_data) VALUES($1,$2,$3,$4,'platform_identity',$5,$6,$7)`,
    [
      adminId,
      s.brandId,
      s.botId,
      action,
      id,
      requestId,
      JSON.stringify(reason ? { reasonCode: reason } : {}),
    ],
  );
}
export async function authorizePlatformBrand(
  tx: Queryable,
  p: Principal,
  s: Scope,
) {
  await authorize(tx, p, s, "platforms.manage");
  const r = (
    await tx.query(
      `SELECT 1 FROM admins a JOIN admin_roles ar ON ar.admin_id=a.id JOIN roles r ON r.id=ar.role_id JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions pm ON pm.id=rp.permission_id
 WHERE a.id=$1 AND a.status='active' AND pm.name='platforms.manage' AND ar.bot_id IS NULL AND (ar.brand_id=$2 OR (ar.brand_id IS NULL AND r.name='Super Admin'))`,
      [p.adminId, s.brandId],
    )
  ).rows[0];
  if (!r) throw new DomainError("forbidden", 403);
}
export async function createPlatform(
  db: Database,
  p: Principal,
  s: Scope,
  input: unknown,
  requestId: string,
) {
  const v = platformInput.parse(input);
  return db.transaction(async (tx) => {
    await authorizePlatformBrand(tx, p, s);
    const r = (
      await tx.query(
        `INSERT INTO platforms(brand_id,code,display_name,market,timezone,currency,verification_method,uid_format,uid_case,uid_min_length,uid_max_length) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(brand_id,code) DO NOTHING RETURNING *`,
        [
          s.brandId,
          v.code,
          v.displayName,
          v.market,
          v.timezone,
          v.currency,
          v.verificationMethod,
          v.uidFormat,
          v.uidCase,
          v.uidMinLength,
          v.uidMaxLength,
        ],
      )
    ).rows[0];
    if (!r) throw new DomainError("platform_exists", 409);
    await tx.query(
      `INSERT INTO audit_logs(admin_id,brand_id,action,object_type,object_id,request_id) VALUES($1,$2,'platform.create','platform',$3,$4)`,
      [p.adminId, s.brandId, r.id, requestId],
    );
    return r;
  });
}
export async function submitIdentity(
  db: Database,
  p: MiniPrincipal,
  platformId: string,
  raw: string,
  key: string,
  requestId: string,
) {
  return db.transaction(async (tx) => {
    // One short lock per platform serializes submit/review. Unique indexes also protect
    // non-service writers. Low-volume manual P3 deliberately avoids distributed locks.
    const platform = await one(
      tx,
      "SELECT * FROM platforms WHERE brand_id=$1 AND id=$2 FOR UPDATE",
      [p.brandId, platformId],
    );
    if (platform.status !== "active")
      throw new DomainError("platform_unavailable", 409);
    if (platform.verification_method !== "manual_admin")
      throw new DomainError("verification_unavailable", 409);
    const uid = canonicalUid(raw, platform);
    const old = (
      await tx.query(
        "SELECT * FROM platform_identities WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3 AND submission_key=$4",
        [p.brandId, p.botId, p.userId, key],
      )
    ).rows[0];
    if (old) {
      if (old.platform_id !== platformId || old.platform_uid !== uid)
        throw new DomainError("idempotency_conflict", 409);
      return safeIdentity({ ...old, display_name: platform.display_name });
    }
    const user = await one(
      tx,
      "SELECT telegram_user_id FROM telegram_users WHERE brand_id=$1 AND bot_id=$2 AND id=$3 AND status='active'",
      [p.brandId, p.botId, p.userId],
    );
    const current = (
      await tx.query(
        "SELECT * FROM platform_identities WHERE brand_id=$1 AND platform_id=$2 AND telegram_user_id=$3 AND status IN ('pending','verified')",
        [p.brandId, platformId, user.telegram_user_id],
      )
    ).rows[0];
    if (current) {
      if (
        current.user_id === p.userId &&
        current.bot_id === p.botId &&
        current.platform_uid === uid
      )
        return safeIdentity({
          ...current,
          display_name: platform.display_name,
        });
      throw new DomainError("identity_current_exists", 409);
    }
    const limit = await one(
      tx,
      "SELECT count(*)::int AS attempts,bool_or(submitted_at>now()-interval '30 seconds') AS recent FROM platform_identities WHERE brand_id=$1 AND platform_id=$2 AND telegram_user_id=$3 AND submitted_at>now()-interval '1 day'",
      [p.brandId, platformId, user.telegram_user_id],
    );
    if (limit.attempts >= 10 || limit.recent === true)
      throw new DomainError("identity_rate_limited", 429);
    const owner = (
      await tx.query(
        "SELECT id FROM platform_identities WHERE brand_id=$1 AND platform_id=$2 AND platform_uid=$3 AND status IN ('pending','verified')",
        [p.brandId, platformId, uid],
      )
    ).rows[0];
    const previous = (
      await tx.query(
        "SELECT id FROM platform_identities WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3 AND platform_id=$4 ORDER BY submitted_at DESC,id DESC LIMIT 1",
        [p.brandId, p.botId, p.userId, platformId],
      )
    ).rows[0];
    const r = await one(
      tx,
      `INSERT INTO platform_identities(brand_id,bot_id,user_id,telegram_user_id,platform_id,platform_uid,status,verification_method,submission_key,previous_identity_id,reason_code)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        p.brandId,
        p.botId,
        p.userId,
        user.telegram_user_id,
        platformId,
        uid,
        owner ? "conflict" : "pending",
        platform.verification_method,
        key,
        previous?.id ?? null,
        owner ? "uid_in_use" : null,
      ],
    );
    await identityAudit(
      tx,
      p,
      owner ? "identity.conflict" : "identity.submit",
      r.id,
      requestId,
      null,
      owner ? "uid_in_use" : undefined,
    );
    return safeIdentity({ ...r, display_name: platform.display_name });
  });
}
export const reviewInput = z
  .object({
    action: z.enum(["verify", "reject", "revoke"]),
    reasonCode: z
      .enum([
        "evidence_missing",
        "ownership_not_proven",
        "incorrect_uid",
        "user_request",
        "security_review",
      ])
      .optional(),
    evidenceReference: z
      .string()
      .regex(/^CASE-[A-Z0-9-]{1,64}$/)
      .optional(),
  })
  .strict();
export async function reviewIdentity(
  db: Database,
  p: Principal,
  s: Scope,
  id: string,
  body: unknown,
  requestId: string,
) {
  const v = reviewInput.parse(body);
  if (v.action === "verify" && !v.evidenceReference)
    throw new DomainError("evidence_required", 400);
  if (v.action !== "verify" && !v.reasonCode)
    throw new DomainError("reason_required", 400);
  return db.transaction(async (tx) => {
    await authorize(tx, p, s, "platform_identities.verify");
    const ref = await one(
      tx,
      "SELECT platform_id FROM platform_identities WHERE brand_id=$1 AND bot_id=$2 AND id=$3",
      [s.brandId, s.botId, id],
    );
    const platform = await one(
      tx,
      "SELECT * FROM platforms WHERE brand_id=$1 AND id=$2 FOR UPDATE",
      [s.brandId, ref.platform_id],
    );
    const r = await one(
      tx,
      "SELECT * FROM platform_identities WHERE brand_id=$1 AND bot_id=$2 AND id=$3",
      [s.brandId, s.botId, id],
    );
    const target = {
      verify: "verified",
      reject: "rejected",
      revoke: "revoked",
    }[v.action];
    if (r.status === target) {
      if (
        v.action === "verify"
          ? r.evidence_reference !== v.evidenceReference
          : r.reason_code !== v.reasonCode
      )
        throw new DomainError("identity_state_conflict", 409);
      return safeIdentity({ ...r, display_name: platform.display_name }, true);
    }
    if (r.status !== (v.action === "revoke" ? "verified" : "pending"))
      throw new DomainError("identity_state_conflict", 409);
    if (
      v.action === "verify" &&
      (platform.status !== "active" || r.verification_method !== "manual_admin")
    )
      throw new DomainError("verification_unavailable", 409);
    const assignments =
      v.action === "verify"
        ? "verified_at=now(),verified_by=$4,evidence_reference=$5"
        : v.action === "reject"
          ? "rejected_at=now(),rejected_by=$4,reason_code=$5"
          : "revoked_at=now(),revoked_by=$4,reason_code=$5";
    const updated = await one(
      tx,
      `UPDATE platform_identities SET status=$6,${assignments} WHERE brand_id=$1 AND bot_id=$2 AND id=$3 RETURNING *`,
      [
        s.brandId,
        s.botId,
        id,
        p.adminId,
        v.action === "verify" ? v.evidenceReference : v.reasonCode,
        target,
      ],
    );
    await identityAudit(
      tx,
      s,
      "identity." + v.action,
      id,
      requestId,
      p.adminId,
      v.reasonCode,
    );
    await enqueueEntitlementSourceChange(tx,s.brandId,r.platform_id,'identity_change',`${id}:${target}`,undefined,r.user_id,s.botId);
    await queueGrowthSourceChange(tx,s.brandId,r.platform_id,`identity:${id}:${target}`,undefined,r.user_id,s.botId);
    return safeIdentity(
      { ...updated, display_name: platform.display_name },
      true,
    );
  });
}
