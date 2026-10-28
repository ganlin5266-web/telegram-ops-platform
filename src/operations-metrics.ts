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

const scopeSchema = z.object({ brandId: z.uuid(), botId: z.uuid() });
const querySchema = z.object({ days: z.literal("7").optional() }).strict();
type Metric = {
  key: string;
  label: string;
  status: "ok" | "forbidden" | "pending_collection";
  value: string | null;
  unit: "users" | "events" | "points";
  definition: string;
};
const specs: Array<
  Omit<Metric, "status" | "value"> & { permission: string; sql?: string }
> = [
  {
    key: "mini_participants",
    label: "Mini authentication participants",
    unit: "users",
    permission: "users.read",
    definition:
      "Distinct Bot users with a successful Mini authentication exchange in this rolling UTC window. Not page views or daily active users; session recovery without a new exchange is not counted.",
    sql: `SELECT count(DISTINCT s.user_id)::text AS value FROM mini_sessions s
      JOIN mini_auth_exchanges e ON e.brand_id=s.brand_id AND e.bot_id=s.bot_id AND e.id=s.exchange_id
      WHERE s.brand_id=$1 AND s.bot_id=$2 AND e.accepted_at >= $3::timestamptz AND e.accepted_at < $4::timestamptz`,
  },
  {
    key: "uid_verified",
    label: "UID verification events",
    unit: "events",
    permission: "platform_identities.read",
    definition:
      "Successful identity.verify audit events in this Bot and UTC window. Later revocation does not erase historical events; this is not a count of currently verified users.",
    sql: `SELECT count(*)::text AS value FROM audit_logs WHERE brand_id=$1 AND bot_id=$2
      AND action='identity.verify' AND object_type='platform_identity' AND created_at >= $3::timestamptz AND created_at < $4::timestamptz`,
  },
  {
    key: "checkins",
    label: "Daily check-ins",
    unit: "events",
    permission: "growth.read",
    definition:
      "Pending collection: Growth check-in sources are shared by Brand/Member/business_date and do not record the originating Bot. Counting linked members or correction ledger entries would misattribute or duplicate Bot check-ins.",
  },
  {
    key: "qualified_invites",
    label: "Recorded qualified invitations",
    unit: "events",
    permission: "referrals.read",
    definition:
      "Distinct Platform/Referral pairs recorded as verified or cap_exceeded at qualification time in this Bot and UTC window, including qualified invitations above the daily cap. Later reviews do not rewrite this historical measure. Invitations not evaluated while rewards are disabled are not included.",
    sql: `SELECT count(DISTINCT (platform_id,referral_id))::text AS value FROM referral_qualification_evidence
      WHERE brand_id=$1 AND bot_id=$2 AND status IN ('verified','cap_exceeded') AND qualified_at >= $3::timestamptz AND qualified_at < $4::timestamptz`,
  },
  {
    key: "reward_points",
    label: "Invitation Points issued",
    unit: "points",
    permission: "referrals.reward.review",
    definition:
      "Sum of granted invitation reward events in this Bot and UTC window, including inviter and enabled invitee awards. Points only, not Growth, and not net account balance.",
    sql: `SELECT COALESCE(sum(points),0)::text AS value FROM referral_reward_events WHERE brand_id=$1 AND bot_id=$2
      AND status='granted' AND created_at >= $3::timestamptz AND created_at < $4::timestamptz`,
  },
  {
    key: "redemptions_created",
    label: "Redemption orders created",
    unit: "events",
    permission: "redemptions.review",
    definition:
      "Orders created in this Bot and UTC window, including subsequently refunded/reviewed orders. Does not assert successful platform redemption.",
    sql: `SELECT count(*)::text AS value FROM redemptions WHERE brand_id=$1 AND bot_id=$2
      AND created_at >= $3::timestamptz AND created_at < $4::timestamptz`,
  },
  {
    key: "codes_claimed",
    label: "Codes claimed",
    unit: "events",
    permission: "redemptions.review",
    definition:
      "Orders whose first code_claimed_at falls in this Bot and UTC window. Re-viewing the same code is not another claim; a claim does not mean the game platform redeemed the code.",
    sql: `SELECT count(*)::text AS value FROM redemptions WHERE brand_id=$1 AND bot_id=$2
      AND code_claimed_at >= $3::timestamptz AND code_claimed_at < $4::timestamptz`,
  },
];

export async function operationsMetrics(
  tx: Queryable,
  principal: Principal,
  scope: Scope,
) {
  await authorize(tx, principal, scope, "dashboard.read");
  // Keep PostgreSQL microseconds intact. A JS Date truncates them, potentially
  // dropping an event committed in the same millisecond before this snapshot.
  // Calculate in UTC so session timezone/DST cannot change this 168-hour window.
  const clock = await one(
    tx,
    `SELECT
    to_char((transaction_timestamp() AT TIME ZONE 'UTC') - interval '7 days', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_start,
    to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_end`,
  );
  const start = clock.window_start as string;
  const end = clock.window_end as string;
  const metrics: Metric[] = [];
  for (const { permission, sql, ...spec } of specs) {
    try {
      await authorize(tx, principal, scope, permission);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "forbidden")
        throw error;
      metrics.push({ ...spec, status: "forbidden", value: null });
      continue;
    }
    if (!sql) {
      metrics.push({ ...spec, status: "pending_collection", value: null });
      continue;
    }
    const row = await one(tx, sql, [...scopeParams(scope), start, end]);
    // The database casts aggregates to text. Never round large integers via JS Number.
    if (typeof row.value !== "string" || !/^\d+$/.test(row.value))
      throw new DomainError("invalid_metric_value", 500);
    metrics.push({ ...spec, status: "ok", value: row.value });
  }
  return {
    window: { start, end, timezone: "UTC" as const, days: 7 as const },
    metrics,
    notAFunnel: true as const,
  };
}

export function attachOperationsMetrics(
  app: FastifyInstance,
  db: Database,
  authenticate: (request: FastifyRequest) => Promise<Principal>,
) {
  app.get(
    "/v1/brands/:brandId/bots/:botId/operations/metrics",
    async (request, reply) => {
      querySchema.parse(request.query);
      const scope = scopeSchema.parse(request.params),
        principal = await authenticate(request);
      reply.header("Cache-Control", "no-store");
      return db.transaction(async (tx) => {
        await tx.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        await tx.query("SET LOCAL statement_timeout='5s'");
        return operationsMetrics(tx, principal, scope);
      });
    },
  );
}
