import type { Principal } from "./auth.js";
import { dateInZone, dateInput } from "./entitlement-domain.js";
import { DomainError, one, type Queryable, type Scope } from "./db.js";

export type MetricStatus =
  | "ok"
  | "not_applicable"
  | "backend_pending"
  | "data_incomplete"
  | "forbidden";
export type OpsMetric = {
  status: MetricStatus;
  value: string | number | null;
  currency?: string | null;
  reason?: string;
};
export type Period = "day" | "week" | "month";
export type PrivatePerformanceQuery = {
  period: Period;
  date: string;
  platformId?: string;
};

const nullMetric = (status: Exclude<MetricStatus, "ok">, reason: string): OpsMetric => ({
  status,
  value: null,
  reason,
});
const countMetric = (value: number): OpsMetric => ({ status: "ok", value });
const amountMetric = (value: bigint, currency: string): OpsMetric => ({
  status: "ok",
  value: amountText(value),
  currency,
});
export const pendingMetric = (reason: string): OpsMetric =>
  nullMetric("backend_pending", reason);
export const forbiddenMetric = (): OpsMetric =>
  nullMetric("forbidden", "permission_required");

function amountUnits(value: string): bigint {
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(value))
    throw new DomainError("platform_metric_invalid", 500);
  const negative = value.startsWith("-"),
    [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const units = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return negative ? -units : units;
}
function amountText(value: bigint): string {
  const negative = value < 0n,
    absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 1_000_000n}.${String(absolute % 1_000_000n).padStart(6, "0")}`;
}
function addDays(day: string, offset: number): string {
  dateInput.parse(day);
  const date = new Date(day + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + offset);
  return dateInput.parse(date.toISOString().slice(0, 10));
}
export function performanceRange(date: string, period: Period) {
  dateInput.parse(date);
  const selected = new Date(date + "T00:00:00Z");
  if (period === "day") return { from: date, to: date };
  if (period === "week") {
    const from = addDays(date, -((selected.getUTCDay() + 6) % 7));
    return { from, to: addDays(from, 6) };
  }
  const from = date.slice(0, 8) + "01",
    end = new Date(from + "T00:00:00Z");
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return { from, to: end.toISOString().slice(0, 10) };
}
function dates(from: string, to: string) {
  const result: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) result.push(date);
  return result;
}
function mappingHas(mapping: Record<string, any>, field: "deposit" | "withdrawal") {
  if (mapping.fieldAvailability && typeof mapping.fieldAvailability === "object")
    return mapping.fieldAvailability[field] === true;
  return typeof mapping[field] === "string" && mapping[field].length > 0;
}
function worstCompleteness(values: string[]) {
  if (values.includes("conflicting")) return "conflicting";
  if (values.includes("missing")) return "missing";
  if (values.includes("unknown")) return "unknown";
  if (values.includes("incomplete")) return "incomplete";
  return "complete";
}
function unavailableForField(values: boolean[], field: string): OpsMetric | null {
  if (values.every((value) => !value))
    return nullMetric("not_applicable", `${field}_not_available`);
  if (values.some((value) => !value))
    return nullMetric("data_incomplete", `${field}_availability_changed`);
  return null;
}
function incompleteReason(completeness: string) {
  if (completeness === "conflicting") return "conflicting_data";
  if (completeness === "unknown") return "completeness_unknown";
  if (completeness === "missing") return "missing_business_date";
  return "incomplete_data";
}
function aggregateMetric(
  metrics: OpsMetric[],
  value: () => OpsMetric,
): OpsMetric {
  if (metrics.every((metric) => metric.status === "ok")) return value();
  if (metrics.every((metric) => metric.status === "not_applicable"))
    return nullMetric("not_applicable", "metric_not_available");
  return nullMetric("data_incomplete", "one_or_more_platforms_incomplete");
}

export async function platformDataStatus(tx: Queryable, s: Scope) {
  const rows = (
    await tx.query(
      `SELECT p.id AS platform_id,p.code,p.display_name,p.timezone,p.currency,
       b.business_date::text AS latest_business_date,b.completeness,
       EXISTS(SELECT 1 FROM platform_import_batches pending WHERE pending.brand_id=p.brand_id AND pending.platform_id=p.id AND pending.status='review_required') AS review_required
       FROM platforms p
       LEFT JOIN LATERAL (
        SELECT business_date,completeness FROM platform_import_batches
        WHERE brand_id=p.brand_id AND platform_id=p.id AND status='active'
        ORDER BY business_date DESC,activated_at DESC,id DESC LIMIT 1
       ) b ON true
       WHERE p.brand_id=$1 AND p.status='active' ORDER BY p.display_name,p.id`,
      [s.brandId],
    )
  ).rows;
  return {
    items: rows.map((row) => ({
      platformId: row.platform_id,
      code: row.code,
      displayName: row.display_name,
      timezone: row.timezone,
      currency: row.currency,
      latestBusinessDate: row.latest_business_date ?? null,
      completeness: row.latest_business_date ? row.completeness : "missing",
      reviewRequired: row.review_required === true,
    })),
    expectedBusinessDate: pendingMetric("expected_business_date_not_configured"),
  };
}

type Platform = {
  id: string;
  code: string;
  display_name: string;
  currency: string;
  timezone: string;
};
type PlatformAggregate = {
  response: Record<string, any>;
  members: Set<string>;
  deposit: bigint;
  net: bigint;
  depositorStatus: OpsMetric;
  depositStatus: OpsMetric;
  netStatus: OpsMetric;
};

export async function privatePerformance(
  tx: Queryable,
  s: Scope,
  query: PrivatePerformanceQuery,
  now = new Date(),
) {
  const range = performanceRange(query.date, query.period),
    platformParameters: unknown[] = [s.brandId],
    platformFilter = query.platformId
      ? ` AND id=$${platformParameters.push(query.platformId)}::uuid`
      : "";
  const platforms = (
    await tx.query<Platform>(
      `SELECT id,code,display_name,currency,timezone FROM platforms WHERE brand_id=$1 AND status='active'${platformFilter} ORDER BY display_name,id`,
      platformParameters,
    )
  ).rows;
  if (query.platformId && platforms.length !== 1)
    throw new DomainError("not_found", 404);
  const platformIds = platforms.map((p) => p.id);
  if (!platformIds.length)
    return {
      scope: { platformId: query.platformId ?? null, period: query.period, ...range },
      platforms: [],
      total: null,
    };

  const batches = (
    await tx.query(
      `SELECT id,platform_id,business_date::text,completeness,coverage,mapping,rejected_rows,status
       FROM platform_import_batches
       WHERE brand_id=$1 AND platform_id=ANY($2::uuid[]) AND business_date BETWEEN $3::date AND $4::date
       AND status IN ('active','review_required') ORDER BY platform_id,business_date,created_at`,
      [s.brandId, platformIds, range.from, range.to],
    )
  ).rows;
  const facts = (
    await tx.query(
      `SELECT f.platform_id,f.business_date::text,r.deposit::text,r.deposit_count::text,r.withdrawal::text,
       attribution.identity_id,l.member_id
       FROM platform_user_daily_facts f
       JOIN platform_user_daily_fact_revisions r ON r.id=f.current_revision_id
       JOIN platform_import_batches b ON b.id=r.batch_id AND b.status='active'
       JOIN LATERAL (
        SELECT history.identity_id FROM platform_user_daily_fact_revisions history
        WHERE history.fact_id=f.id AND history.identity_id IS NOT NULL
        ORDER BY history.data_version,history.id LIMIT 1
       ) attribution ON true
       JOIN platform_identities i ON i.id=attribution.identity_id AND i.brand_id=$1 AND i.bot_id=$2
       LEFT JOIN member_user_links l ON (l.brand_id,l.bot_id,l.user_id)=(i.brand_id,i.bot_id,i.user_id)
       WHERE f.brand_id=$1 AND f.platform_id=ANY($3::uuid[]) AND f.business_date BETWEEN $4::date AND $5::date`,
      [s.brandId, s.botId, platformIds, range.from, range.to],
    )
  ).rows;
  const requiredDates = dates(range.from, range.to),
    aggregates: PlatformAggregate[] = [];

  for (const platform of platforms) {
    const platformBatches = batches.filter((b) => b.platform_id === platform.id),
      active = platformBatches.filter((b) => b.status === "active"),
      activeByDate = new Map(active.map((b) => [b.business_date, b])),
      open = range.to >= dateInZone(now, platform.timezone),
      completenessValues = requiredDates.map((date) => {
        const batch = activeByDate.get(date);
        if (!batch) return "missing";
        if (batch.coverage?.kind !== "full" || Number(batch.rejected_rows) > 0)
          return "incomplete";
        return batch.completeness;
      });
    if (platformBatches.some((b) => b.status === "review_required"))
      completenessValues.push("conflicting");
    if (open) completenessValues.push("incomplete");
    const completeness = worstCompleteness(completenessValues),
      depositAvailability = active.map((b) => mappingHas(b.mapping, "deposit")),
      withdrawalAvailability = active.map((b) => mappingHas(b.mapping, "withdrawal")),
      rows = facts.filter((f) => f.platform_id === platform.id),
      members = new Set<string>();
    let deposit = 0n,
      net = 0n,
      depositInvalid = false,
      withdrawalInvalid = false,
      memberInvalid = false;
    for (const row of rows) {
      if (!row.member_id) memberInvalid = true;
      else if (row.deposit !== null && amountUnits(row.deposit) > 0n)
        members.add(row.member_id);
      if (row.deposit === null || amountUnits(row.deposit) < 0n) {
        depositInvalid = true;
        continue;
      }
      const depositValue = amountUnits(row.deposit);
      if (row.deposit_count !== null && BigInt(row.deposit_count) > 0n && depositValue <= 0n)
        depositInvalid = true;
      deposit += depositValue;
      if (row.withdrawal === null || amountUnits(row.withdrawal) < 0n) {
        withdrawalInvalid = true;
        continue;
      }
      net += depositValue - amountUnits(row.withdrawal);
    }
    const globalIncomplete = completeness !== "complete" || memberInvalid,
      globalReason = memberInvalid ? "member_link_missing" : open ? "period_open" : incompleteReason(completeness),
      depositField = unavailableForField(depositAvailability, "deposit"),
      withdrawalField = unavailableForField(withdrawalAvailability, "withdrawal");
    const depositorStatus = globalIncomplete
        ? nullMetric("data_incomplete", globalReason)
        : depositField ??
          (depositInvalid
            ? nullMetric("data_incomplete", "deposit_data_invalid")
            : countMetric(members.size)),
      depositStatus = globalIncomplete
        ? nullMetric("data_incomplete", globalReason)
        : depositField ??
          (depositInvalid
            ? nullMetric("data_incomplete", "deposit_data_invalid")
            : amountMetric(deposit, platform.currency)),
      netStatus = globalIncomplete
        ? nullMetric("data_incomplete", globalReason)
        : depositField ??
          withdrawalField ??
          (depositInvalid || withdrawalInvalid
            ? nullMetric("data_incomplete", "deposit_or_withdrawal_invalid")
            : amountMetric(net, platform.currency));
    aggregates.push({
      members,
      deposit,
      net,
      depositorStatus,
      depositStatus,
      netStatus,
      response: {
        platformId: platform.id,
        code: platform.code,
        displayName: platform.display_name,
        currency: platform.currency,
        timezone: platform.timezone,
        completeness,
        depositors: depositorStatus,
        depositAmount: depositStatus,
        netDeposit: netStatus,
      },
    });
  }

  let total: {
    depositors: OpsMetric;
    depositAmount: OpsMetric;
    netDeposit: OpsMetric;
  } | null = null;
  if (!query.platformId) {
    const currencies = new Set(platforms.map((p) => p.currency)),
      members = new Set(aggregates.flatMap((a) => [...a.members])),
      currency = currencies.size === 1 ? platforms[0]!.currency : null;
    total = {
      depositors: aggregateMetric(
        aggregates.map((aggregate) => aggregate.depositorStatus),
        () => countMetric(members.size),
      ),
      depositAmount: !currency
        ? nullMetric("not_applicable", "multiple_currencies")
        : aggregateMetric(
            aggregates.map((aggregate) => aggregate.depositStatus),
            () =>
              amountMetric(
                aggregates.reduce((sum, aggregate) => sum + aggregate.deposit, 0n),
                currency,
              ),
          ),
      netDeposit: !currency
        ? nullMetric("not_applicable", "multiple_currencies")
        : aggregateMetric(
            aggregates.map((aggregate) => aggregate.netStatus),
            () =>
              amountMetric(
                aggregates.reduce((sum, aggregate) => sum + aggregate.net, 0n),
                currency,
              ),
          ),
    };
  }
  return {
    scope: { platformId: query.platformId ?? null, period: query.period, ...range },
    platforms: aggregates.map((a) => a.response),
    total,
  };
}

async function hasPermission(
  tx: Queryable,
  p: Principal,
  s: Scope,
  permission: string,
  brandWide: boolean,
) {
  return (
    await one(
      tx,
      `SELECT EXISTS(SELECT 1 FROM admins a JOIN admin_roles ar ON ar.admin_id=a.id JOIN roles r ON r.id=ar.role_id JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions pm ON pm.id=rp.permission_id
       WHERE a.id=$1 AND a.status='active' AND pm.name=$2
       AND ((ar.brand_id=$3 AND ${brandWide ? "ar.bot_id IS NULL" : "(ar.bot_id IS NULL OR ar.bot_id=$4)"}) OR (ar.brand_id IS NULL AND r.name='Super Admin'))) AS allowed`,
      brandWide
        ? [p.adminId, permission, s.brandId]
        : [p.adminId, permission, s.brandId, s.botId],
    )
  ).allowed === true;
}
async function authorizedCount(
  allowed: boolean,
  tx: Queryable,
  sql: string,
  parameters: unknown[],
): Promise<OpsMetric> {
  if (!allowed) return forbiddenMetric();
  const result = await one(tx, sql, parameters);
  return countMetric(Number(result.n));
}

export async function pendingSummary(tx: Queryable, p: Principal, s: Scope) {
  const identityAllowed = await hasPermission(tx, p, s, "platform_identities.read", false),
    platformAllowed = await hasPermission(tx, p, s, "platform_data.read", true),
    entitlementAllowed = await hasPermission(tx, p, s, "entitlements.read", false),
    growthAllowed = await hasPermission(tx, p, s, "growth.read", true);
  return {
    identityReview: await authorizedCount(
      identityAllowed,
      tx,
      "SELECT count(*)::int AS n FROM platform_identities WHERE brand_id=$1 AND bot_id=$2 AND status='pending'",
      [s.brandId, s.botId],
    ),
    identityConflict: await authorizedCount(
      identityAllowed,
      tx,
      "SELECT count(*)::int AS n FROM platform_identities WHERE brand_id=$1 AND bot_id=$2 AND status='conflict'",
      [s.brandId, s.botId],
    ),
    platformDataReview: await authorizedCount(
      platformAllowed,
      tx,
      `SELECT count(*)::int AS n FROM (SELECT DISTINCT platform_id,business_date FROM platform_import_batches WHERE brand_id=$1 AND (status='review_required' OR (status='active' AND completeness='conflicting'))) pending`,
      [s.brandId],
    ),
    qualificationReview: await authorizedCount(
      entitlementAllowed,
      tx,
      `SELECT count(*)::int AS n FROM daily_entitlements d JOIN daily_entitlement_revisions r ON r.id=d.current_revision_id WHERE d.brand_id=$1 AND d.bot_id=$2 AND r.status='review_required'`,
      [s.brandId, s.botId],
    ),
    growthReview: await authorizedCount(
      growthAllowed,
      tx,
      `SELECT count(*)::int AS n FROM growth_sources s JOIN growth_evaluation_revisions r ON r.id=s.current_evaluation_id WHERE s.brand_id=$1 AND r.status='review_required'`,
      [s.brandId],
    ),
    lowInventory: pendingMetric("inventory_contract_not_available"),
  };
}
