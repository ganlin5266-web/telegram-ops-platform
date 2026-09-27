import {
  DomainError,
  one,
  scopeParams,
  type Queryable,
  type Scope,
} from "./db.js";
import { z } from "zod";
export const lotsEnabled = () => process.env.POINT_LOTS_ENABLED === "true";
export async function hasLotCutover(tx: Queryable, s: Scope) {
  const schema = await one(
    tx,
    "SELECT to_regclass('point_lot_cutovers') IS NOT NULL AS ready",
  );
  return (
    schema.ready &&
    (
      await tx.query(
        "SELECT bot_id FROM point_lot_cutovers WHERE brand_id=$1 AND bot_id=$2",
        scopeParams(s),
      )
    ).rows.length > 0
  );
}
export type PointScope = Scope & { userId: string };
export const policyInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    source: z.string().min(1).max(80),
    mode: z.enum(["permanent", "rolling_days", "fixed_deadline"]),
    rollingDays: z.number().int().min(1).max(36500).nullable().default(null),
    deadline: z.iso.datetime({ offset: true }).nullable().default(null),
    timezone: z.string().min(1).max(100),
    refundMinCompensationDays: z
      .number()
      .int()
      .min(1)
      .max(36500)
      .nullable()
      .default(null),
    effectiveAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      (v.mode === "permanent" &&
        (v.rollingDays !== null || v.deadline !== null)) ||
      (v.mode === "rolling_days" &&
        (v.rollingDays === null || v.deadline !== null)) ||
      (v.mode === "fixed_deadline" &&
        (v.rollingDays !== null ||
          v.deadline === null ||
          Date.parse(v.deadline) <= Date.parse(v.effectiveAt)))
    )
      c.addIssue({ code: "custom", message: "invalid_policy" });
    try {
      new Intl.DateTimeFormat("en", { timeZone: v.timezone });
    } catch {
      c.addIssue({ code: "custom", message: "invalid_timezone" });
    }
  });
export async function pointAudit(
  tx: Queryable,
  s: Scope,
  action: string,
  id: string,
  data: unknown,
  adminId: string | null = null,
  requestId = "system",
) {
  await tx.query(
    `INSERT INTO audit_logs(admin_id,brand_id,bot_id,action,object_type,object_id,after_data,request_id) VALUES($1,$2,$3,$4,'point_expiry',$5,$6,$7)`,
    [adminId, ...scopeParams(s), action, id, JSON.stringify(data), requestId],
  );
}
export async function normalizePolicy(tx: Queryable, input: unknown) {
  let candidate = input;
  if (input && typeof input === "object" && "deadlineDate" in input) {
    const raw = z
      .object({
        deadlineDate: z.iso.date(),
        timezone: z.string().min(1).max(100),
      })
      .passthrough()
      .parse(input);
    try {
      new Intl.DateTimeFormat("en", { timeZone: raw.timezone });
    } catch {
      throw new DomainError("invalid_timezone", 400);
    }
    if ("deadline" in raw) throw new DomainError("invalid_policy", 400);
    const date = await one(
      tx,
      "SELECT (($1::date+1)::timestamp AT TIME ZONE $2) AS deadline",
      [raw.deadlineDate, raw.timezone],
    );
    const { deadlineDate, ...rest } = raw;
    candidate = { ...rest, deadline: new Date(date.deadline).toISOString() };
  }
  return policyInput.parse(candidate);
}
export async function createPolicy(
  tx: Queryable,
  s: Scope,
  adminId: string,
  input: unknown,
  requestId: string,
) {
  const v = await normalizePolicy(tx, input);
  await one(
    tx,
    "SELECT id FROM telegram_bots WHERE brand_id=$1 AND id=$2 FOR UPDATE",
    scopeParams(s),
  );
  await tx.query(
    "INSERT INTO point_expiry_policies(brand_id,bot_id,name,source) VALUES($1,$2,$3,$4) ON CONFLICT(brand_id,bot_id,source) DO NOTHING",
    [...scopeParams(s), v.name, v.source],
  );
  const p = await one(
    tx,
    "SELECT * FROM point_expiry_policies WHERE brand_id=$1 AND bot_id=$2 AND source=$3",
    [...scopeParams(s), v.source],
  );
  const row = await one(
    tx,
    `INSERT INTO point_expiry_policy_versions(brand_id,bot_id,policy_id,version,mode,rolling_days,deadline,timezone,refund_min_compensation_days,effective_at,created_by)
 SELECT $1,$2,$3,COALESCE(max(version),0)+1,$4,$5,$6,$7,$8,$9,$10 FROM point_expiry_policy_versions WHERE policy_id=$3 RETURNING *`,
    [
      ...scopeParams(s),
      p.id,
      v.mode,
      v.rollingDays,
      v.deadline,
      v.timezone,
      v.refundMinCompensationDays,
      v.effectiveAt,
      adminId,
    ],
  );
  await pointAudit(
    tx,
    s,
    "expiry_policy.create",
    row.id,
    { version: row.version, mode: row.mode },
    adminId,
    requestId,
  );
  return row;
}
export async function publishPolicy(
  tx: Queryable,
  s: Scope,
  adminId: string,
  id: string,
  requestId: string,
) {
  await one(
    tx,
    "SELECT id FROM telegram_bots WHERE brand_id=$1 AND id=$2 FOR UPDATE",
    scopeParams(s),
  );
  const row = await one(
    tx,
    "SELECT * FROM point_expiry_policy_versions WHERE brand_id=$1 AND bot_id=$2 AND id=$3",
    [...scopeParams(s), id],
  );
  if (row.status === "published") return row;
  if (row.deadline && new Date(row.deadline).getTime() <= Date.now())
    throw new DomainError("point_policy_deadline_passed");
  const result = await one(
    tx,
    "UPDATE point_expiry_policy_versions SET status='published',published_at=now(),published_by=$4 WHERE brand_id=$1 AND bot_id=$2 AND id=$3 RETURNING *",
    [...scopeParams(s), id, adminId],
  );
  await pointAudit(
    tx,
    s,
    "expiry_policy.publish",
    id,
    { version: row.version },
    adminId,
    requestId,
  );
  return result;
}
export async function resolvePolicy(
  tx: Queryable,
  s: Scope,
  source: string,
  at: Date,
  versionId?: string,
) {
  const rows = (
    await tx.query(
      `SELECT v.*,p.source FROM point_expiry_policy_versions v JOIN point_expiry_policies p ON p.id=v.policy_id
 WHERE v.brand_id=$1 AND v.bot_id=$2 AND v.status='published' AND v.effective_at<=$3
 AND (($4::uuid IS NOT NULL AND v.id=$4) OR ($4::uuid IS NULL AND p.source IN ($5,'*')))
 ORDER BY (p.source=$5) DESC,v.effective_at DESC,v.version DESC LIMIT 1`,
      [...scopeParams(s), at.toISOString(), versionId ?? null, source],
    )
  ).rows;
  if (!rows[0]) throw new DomainError("point_expiry_policy_required");
  return rows[0];
}
export function policyExpiry(p: Record<string, any>, at: Date) {
  const expiry =
    p.mode === "permanent"
      ? null
      : p.mode === "rolling_days"
        ? new Date(at.getTime() + Number(p.rolling_days) * 86400000)
        : new Date(p.deadline);
  if (expiry && expiry <= at)
    throw new DomainError("point_policy_deadline_passed");
  return expiry?.toISOString() ?? null;
}
export async function pointSummary(tx: Queryable, s: PointScope) {
  if (!lotsEnabled() && !(await hasLotCutover(tx, s))) {
    const r = (
      await tx.query(
        "SELECT balance::text FROM point_accounts WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3",
        [...scopeParams(s), s.userId],
      )
    ).rows[0];
    return {
      accountExists: !!r,
      balance: r?.balance ?? null,
      availableBalance: r?.balance ?? null,
      pendingExpiry: "0",
      expiringSoon: "0",
      permanentBalance: r?.balance ?? null,
    };
  }
  if (
    !(
      await tx.query(
        "SELECT bot_id FROM point_lot_cutovers WHERE brand_id=$1 AND bot_id=$2",
        scopeParams(s),
      )
    ).rows.length
  )
    throw new DomainError("point_lot_cutover_required");
  const r = (
    await tx.query(
      `SELECT a.balance::text,
 COALESCE(sum(l.remaining_amount) FILTER(WHERE l.expires_at IS NULL OR l.expires_at>statement_timestamp()),0)::text AS available,
 COALESCE(sum(l.remaining_amount) FILTER(WHERE l.expires_at<=statement_timestamp()),0)::text AS pending,
 COALESCE(sum(l.remaining_amount) FILTER(WHERE l.expires_at IS NULL),0)::text AS permanent,
 COALESCE(sum(l.remaining_amount) FILTER(WHERE l.expires_at>statement_timestamp() AND l.expires_at<=statement_timestamp()+interval '168 hours'),0)::text AS soon
 FROM point_accounts a LEFT JOIN point_lots l ON l.account_id=a.id AND l.remaining_amount>0
 WHERE a.brand_id=$1 AND a.bot_id=$2 AND a.user_id=$3 GROUP BY a.id`,
      [...scopeParams(s), s.userId],
    )
  ).rows[0];
  return {
    accountExists: !!r,
    balance: r?.balance ?? null,
    availableBalance: r?.available ?? null,
    pendingExpiry: r?.pending ?? "0",
    expiringSoon: r?.soon ?? "0",
    permanentBalance: r?.permanent ?? null,
  };
}
export async function reconcileAccount(tx: Queryable, accountId: string) {
  const r = await one(
    tx,
    `SELECT a.balance::text,
 (SELECT COALESCE(sum(delta),0)::text FROM point_ledger WHERE account_id=a.id) AS ledger,
 (SELECT COALESCE(sum(remaining_amount),0)::text FROM point_lots WHERE account_id=a.id) AS lots
 FROM point_accounts a WHERE a.id=$1`,
    [accountId],
  );
  return { ...r, consistent: r.balance === r.ledger && r.balance === r.lots };
}
export async function assertReconciled(tx: Queryable, accountId: string) {
  if (!(await reconcileAccount(tx, accountId)).consistent)
    throw new DomainError("point_reconciliation_mismatch");
}
export async function lockManagedAccount(
  tx: Queryable,
  s: PointScope,
  accountId: string,
) {
  if (
    !(
      await tx.query(
        "SELECT bot_id FROM point_lot_cutovers WHERE brand_id=$1 AND bot_id=$2",
        scopeParams(s),
      )
    ).rows.length
  )
    throw new DomainError("point_lot_cutover_required");
  await assertReconciled(tx, accountId);
  return (
    await tx.query(
      `SELECT * FROM point_lots WHERE account_id=$1 AND remaining_amount>0 ORDER BY expires_at ASC NULLS LAST,granted_at,id`,
      [accountId],
    )
  ).rows;
}
