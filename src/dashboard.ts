import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authorize, type Principal } from "./auth.js";
import {
  DomainError,
  one,
  scopeParams,
  type Database,
  type Queryable,
  type Scope,
} from "./db.js";
export const MAX_DASHBOARD_DAYS = 90;
const timestamp = z.iso
  .datetime({ offset: true })
  .refine((v) => Number.isFinite(Date.parse(v)));
const rangeSchema = z.object({ from: timestamp, to: timestamp }).strict();
const scopeSchema = z.object({ brandId: z.uuid(), botId: z.uuid() });
const unavailable = {
  activeUsers: {
    supported: false,
    value: null,
    reason: "historical_activity_facts_missing",
  },
  effectiveInvitations: {
    supported: false,
    value: null,
    reason: "qualification_policy_undefined",
  },
  deliveredRedemptions: {
    supported: false,
    value: null,
    reason: "delivery_completion_not_implemented",
  },
};
const count = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new DomainError("count_out_of_range", 500);
  return n;
};
async function context(
  tx: Queryable,
  s: Scope,
  range: { from: string; to: string },
) {
  if (Date.parse(range.from) >= Date.parse(range.to))
    throw new DomainError("invalid_date_range", 400);
  // Cheap bound before timezone/calendar work; permit a DST hour for 90 local days.
  if (
    Date.parse(range.to) - Date.parse(range.from) >
    MAX_DASHBOARD_DAYS * 86400000 + 3600000
  )
    throw new DomainError("dashboard_range_too_large", 400);
  const config = await one(
    tx,
    `SELECT COALESCE(b.timezone,br.timezone) timezone, CASE WHEN b.timezone IS NULL THEN 'brand' ELSE 'bot' END timezone_source FROM telegram_bots b JOIN brands br ON br.id=b.brand_id WHERE b.brand_id=$1 AND b.id=$2`,
    scopeParams(s),
  );
  if (!config.timezone)
    throw new DomainError("dashboard_timezone_not_configured", 409);
  const calendar = await one(
    tx,
    `SELECT (($2::timestamptz-interval '1 microsecond') AT TIME ZONE $3)::date-($1::timestamptz AT TIME ZONE $3)::date+1 days, transaction_timestamp()::text snapshot_at`,
    [range.from, range.to, config.timezone],
  );
  if (calendar.days < 1 || calendar.days > MAX_DASHBOARD_DAYS)
    throw new DomainError("dashboard_range_too_large", 400);
  return {
    scope: s,
    timezone: config.timezone,
    timezoneSource: config.timezone_source,
    from: range.from,
    to: range.to,
    interval: "[from,to)",
    snapshotAt: calendar.snapshot_at,
    maxDays: MAX_DASHBOARD_DAYS,
  };
}
const scoped = "brand_id=$1 AND bot_id=$2";
const period = (field: string) =>
  `${scoped} AND ${field}>=$3::timestamptz AND ${field}<$4::timestamptz`;
export async function dashboardSummary(
  tx: Queryable,
  s: Scope,
  range: { from: string; to: string },
) {
  const meta = await context(tx, s, range),
    params = [...scopeParams(s), range.from, range.to];
  const users = await one(
    tx,
    `SELECT count(*)::text total, count(*) FILTER(WHERE first_started_at>=$3::timestamptz AND first_started_at<$4::timestamptz)::text new_users FROM telegram_users WHERE ${scoped}`,
    params,
  );
  const balances = await one(
    tx,
    `SELECT COALESCE(sum(balance),0)::text balance FROM point_accounts WHERE ${scoped}`,
    scopeParams(s),
  );
  const points = await one(
    tx,
    `SELECT
 COALESCE(sum(delta::numeric) FILTER(WHERE delta>0),0)::text earned,
 COALESCE(sum(-delta::numeric) FILTER(WHERE delta<0),0)::text spent,
 count(*) FILTER(WHERE source='admin' AND business_type='manual_adjustment' AND delta>0)::text manual_credit_count,
 COALESCE(sum(delta::numeric) FILTER(WHERE source='admin' AND business_type='manual_adjustment' AND delta>0),0)::text manual_credit,
 count(*) FILTER(WHERE source='admin' AND business_type='manual_adjustment' AND delta<0)::text manual_debit_count,
 COALESCE(sum(-delta::numeric) FILTER(WHERE source='admin' AND business_type='manual_adjustment' AND delta<0),0)::text manual_debit
 FROM point_ledger WHERE ${period("created_at")}`,
    params,
  );
  const referrals = await one(
    tx,
    `SELECT count(*)::text total,count(DISTINCT inviter_id)::text inviters,
 count(*) FILTER(WHERE reward_status='pending')::text pending,count(*) FILTER(WHERE reward_status='rewarded')::text rewarded,count(*) FILTER(WHERE reward_status='ineligible')::text ineligible
 FROM referrals WHERE ${period("bound_at")}`,
    params,
  );
  const orders = await one(
    tx,
    `SELECT count(*)::text total,${["pending", "processing", "success", "failed", "cancelled"].map((state) => `count(*) FILTER(WHERE status='${state}')::text ${state}`).join(",")} FROM redemptions WHERE ${period("created_at")}`,
    params,
  );
  const refunds = await one(
    tx,
    `SELECT count(DISTINCT r.id)::text orders,COALESCE(sum(l.delta::numeric),0)::text points FROM point_ledger l JOIN redemptions r ON r.brand_id=l.brand_id AND r.bot_id=l.bot_id AND r.user_id=l.user_id AND r.id::text=l.business_id WHERE l.brand_id=$1 AND l.bot_id=$2 AND l.created_at>=$3::timestamptz AND l.created_at<$4::timestamptz AND l.source='redemption' AND l.business_type='redemption_refund' AND l.delta>0`,
    params,
  );
  return {
    ...meta,
    unsupported: unavailable,
    realtime: {
      totalUsers: count(users.total),
      pointsBalance: balances.balance,
    },
    period: {
      newUsers: count(users.new_users),
      pointsEarned: points.earned,
      pointsSpent: points.spent,
      manualAdjustments: {
        creditCount: count(points.manual_credit_count),
        creditPoints: points.manual_credit,
        debitCount: count(points.manual_debit_count),
        debitPoints: points.manual_debit,
      },
      referrals: {
        newRelations: count(referrals.total),
        uniqueInviters: count(referrals.inviters),
        rewardStatus: {
          pending: count(referrals.pending),
          rewarded: count(referrals.rewarded),
          ineligible: count(referrals.ineligible),
        },
      },
      redemptions: {
        created: count(orders.total),
        currentStatusOfCreatedOrders: Object.fromEntries(
          ["pending", "processing", "success", "failed", "cancelled"].map(
            (k) => [k, count(orders[k])],
          ),
        ),
      },
      refunds: { orders: count(refunds.orders), points: refunds.points },
    },
  };
}
export async function dashboardTrends(
  tx: Queryable,
  s: Scope,
  range: { from: string; to: string },
) {
  const meta = await context(tx, s, range);
  const rows = (
    await tx.query(
      `WITH days AS (
 SELECT d::date::text date FROM generate_series(($3::timestamptz AT TIME ZONE $5)::date::timestamp,(($4::timestamptz-interval '1 microsecond') AT TIME ZONE $5)::date::timestamp,interval '1 day') d
 ), users AS (SELECT (first_started_at AT TIME ZONE $5)::date::text date,count(*)::text n FROM telegram_users WHERE ${period("first_started_at")} GROUP BY 1),
 ledger AS (SELECT (created_at AT TIME ZONE $5)::date::text date,COALESCE(sum(delta::numeric) FILTER(WHERE delta>0),0)::text earned,COALESCE(sum(-delta::numeric) FILTER(WHERE delta<0),0)::text spent FROM point_ledger WHERE ${period("created_at")} GROUP BY 1),
 refs AS (SELECT (bound_at AT TIME ZONE $5)::date::text date,count(*)::text n FROM referrals WHERE ${period("bound_at")} GROUP BY 1),
 orders AS (SELECT (created_at AT TIME ZONE $5)::date::text date,count(*)::text n FROM redemptions WHERE ${period("created_at")} GROUP BY 1)
 SELECT days.date,COALESCE(users.n,'0') new_users,COALESCE(ledger.earned,'0') earned,COALESCE(ledger.spent,'0') spent,COALESCE(refs.n,'0') referrals,COALESCE(orders.n,'0') redemptions FROM days LEFT JOIN users USING(date) LEFT JOIN ledger USING(date) LEFT JOIN refs USING(date) LEFT JOIN orders USING(date) ORDER BY days.date`,
      [...scopeParams(s), range.from, range.to, meta.timezone],
    )
  ).rows;
  return {
    ...meta,
    granularity: "day",
    unsupported: unavailable,
    items: rows.map((r) => ({
      date: r.date,
      newUsers: count(r.new_users),
      pointsEarned: r.earned,
      pointsSpent: r.spent,
      newReferrals: count(r.referrals),
      redemptions: count(r.redemptions),
    })),
  };
}
export function attachDashboard(
  app: FastifyInstance,
  db: Database,
  authenticate: (r: FastifyRequest) => Promise<Principal>,
) {
  for (const kind of ["summary", "trends"] as const)
    app.get(
      `/v1/brands/:brandId/bots/:botId/dashboard/${kind}`,
      async (request) => {
        const s = scopeSchema.parse(request.params),
          q = (
            kind === "trends"
              ? rangeSchema.extend({
                  granularity: z.literal("day").default("day"),
                })
              : rangeSchema
          ).parse(request.query),
          p = await authenticate(request);
        return db.transaction(async (tx) => {
          await tx.query(
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
          );
          await tx.query("SET LOCAL statement_timeout='5s'");
          await authorize(tx, p, s, "dashboard.read");
          return kind === "summary"
            ? dashboardSummary(tx, s, q)
            : dashboardTrends(tx, s, q);
        });
      },
    );
}
