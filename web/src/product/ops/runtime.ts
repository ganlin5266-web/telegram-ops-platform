// Runtime adapter: maps ONLY existing backend contracts into the ops view
// model. Everything without a reliable source stays 待接入 (never a fake 0).
import { useRemote } from "../../operations/query";
import { periodRange } from "../metrics";
import {
  ERROR,
  NO_ACCESS,
  PENDING,
  val,
  periodDays,
  trendDays,
  type Cell,
  type OpsData,
  type PerfKey,
  type Scope,
  type TrendRow,
} from "./model";
import {
  mapPending,
  mapPrivatePerf,
  type OpsDataStatus,
  type OpsPending,
  type OpsPerf,
} from "./opsRead";

type Summary = {
  timezone: string;
  snapshotAt: string;
  realtime: any;
  period: any;
};
type Trends = {
  items: {
    date: string;
    newUsers: number;
    pointsEarned: string;
    pointsSpent: string;
  }[];
};
type MemberAnalytics = {
  available: boolean;
  timezone?: string;
  members?: string;
  issued?: string;
  net?: string;
  earners?: string;
  upgrades?: string;
  distribution?: { level: number; n: string | number }[];
};
const failOf = (e: { status?: number }): "error" | "forbidden" =>
  e.status === 403 ? "forbidden" : "error";
const failMetrics = (e: { status?: number }): Record<PerfKey, Cell> => {
  const c: Cell = e.status === 403 ? NO_ACCESS : ERROR;
  return {
    returnActive: PENDING,
    depositors: c,
    depositAmount: c,
    repeatDepositors: PENDING,
    repeatRate: PENDING,
    netDeposit: c,
  };
};
export type PlatformOption = {
  id: string;
  display_name: string;
  market: string;
};

export function useRuntimeOps(opts: {
  base: string;
  brandId: string;
  permissions: string[];
  scope: Scope;
  zone: string;
  revision: number;
  onExpire: () => void;
}) {
  const { base, brandId, permissions, scope, zone, revision, onExpire } = opts;
  const canDash = permissions.includes("dashboard.read");
  const canGrowth = permissions.includes("growth.read");
  const filtered = !!scope.platform || !!scope.market;
  let range: { from: string; to: string } | null = null,
    trendRange: { from: string; to: string } | null = null,
    days: { start: string; end: string } | null = null;
  try {
    range = periodRange(scope.day, scope.period, zone);
    const t = trendDays(scope.day, scope.period);
    trendRange = {
      from: periodRange(t.start, "day", zone).from,
      to: periodRange(t.end, "day", zone).to,
    };
    days = periodDays(scope.day, scope.period);
  } catch {
    /* invalid date: issue no request */
  }
  const summary = useRemote<Summary>(
    canDash && range
      ? `${base}/dashboard/summary?${new URLSearchParams(range)}`
      : null,
    revision,
    onExpire,
  );
  const trends = useRemote<Trends>(
    canDash && trendRange && !filtered
      ? `${base}/dashboard/trends?${new URLSearchParams(trendRange)}`
      : null,
    revision,
    onExpire,
  );
  const member = useRemote<MemberAnalytics>(
    canGrowth && days && !filtered
      ? `/v1/brands/${brandId}/members/analytics?from=${days.start}&to=${days.end}`
      : null,
    revision,
    onExpire,
  );
  const platforms = useRemote<{ items: PlatformOption[] }>(
    permissions.includes("platforms.read") ? `${base}/platforms` : null,
    0,
    onExpire,
  );
  // Batch 1 read-only ops contract. Brand-wide Platform data needs platform_data.read.
  const canData = permissions.includes("platform_data.read");
  const perfQuery =
    days && scope.day
      ? new URLSearchParams({
          period: scope.period,
          date: scope.day,
          ...(scope.platform ? { platformId: scope.platform } : {}),
        })
      : null;
  // No Market parameter in the contract: a Market without a Platform cannot be
  // queried exactly, so no request is made (never a Brand-wide total labelled as a Market).
  const marketOnly = !!scope.market && !scope.platform;
  const perf = useRemote<OpsPerf>(
    canData && perfQuery && !marketOnly
      ? `${base}/ops/private-performance?${perfQuery}`
      : null,
    revision,
    onExpire,
  );
  const dataStatus = useRemote<OpsDataStatus>(
    canData ? `${base}/ops/platform-data-status` : null,
    revision,
    onExpire,
  );
  const pending = useRemote<OpsPending>(
    canDash ? `${base}/ops/pending` : null,
    revision,
    onExpire,
  );

  // 404 = endpoint not deployed yet → 待接入 (not an error, never 0).
  const live = (e?: { status?: number }) =>
    e && e.status !== 404 ? e : undefined;
  const perfErr = live(perf.error),
    pendingErr = live(pending.error);
  const ds = dataStatus.error;
  const freshnessState: NonNullable<
    OpsData["privateDomain"]
  >["freshnessState"] = !canData
    ? "forbidden"
    : !ds
      ? dataStatus.data && !dataStatus.data.items.length
        ? "empty"
        : undefined
      : ds.status === 404
        ? "pending"
        : ds.status === 403
          ? "forbidden"
          : "error";
  const blank = (
    failure: "error" | "forbidden" | "unsupported",
    metrics: Record<PerfKey, Cell>,
  ) => ({
    metrics,
    freshness: null,
    trends: {},
    breakdown: null,
    failure,
  });
  const perfView = !canData
    ? blank("forbidden", failMetrics({ status: 403 }))
    : marketOnly
      ? blank("unsupported", {
          returnActive: PENDING,
          depositors: PENDING,
          depositAmount: PENDING,
          repeatDepositors: PENDING,
          repeatRate: PENDING,
          netDeposit: PENDING,
        })
      : perfErr
        ? blank(failOf(perfErr), failMetrics(perfErr))
        : mapPrivatePerf(perf.data, ds ? undefined : dataStatus.data);
  const pendingView = mapPending(pending.data);
  const s = summary.data,
    m = member.data?.available ? member.data : undefined;
  // Platform/Market filters: Bot totals are not attributable → 待接入.
  const fromSummary = (v: unknown): Cell =>
    filtered ? PENDING : summary.error ? ERROR : s ? val(v) : PENDING;
  const fromMember = (v: unknown): Cell =>
    filtered || !canGrowth
      ? PENDING
      : member.error
        ? ERROR
        : m
          ? val(v)
          : PENDING;

  let trendRows: TrendRow[] | undefined, pointRows: TrendRow[] | undefined;
  if (trends.data && !filtered) {
    trendRows = trends.data.items.map((r) => ({
      date: r.date,
      values: [val(r.newUsers)],
    }));
    pointRows = trends.data.items.map((r) => ({
      date: r.date,
      values: [val(r.pointsEarned), val(r.pointsSpent)],
    }));
  }
  const data: OpsData = {
    timezone: s?.timezone ?? null,
    updatedAt: s?.snapshotAt ?? null,
    realtime: false,
    metrics: {
      totalUsers: fromSummary(s?.realtime?.totalUsers),
      newUsers: fromSummary(s?.period?.newUsers),
      activeUsers: PENDING,
      boundUsers: PENDING,
      members: fromMember(m?.members),
      upgrades: fromMember(m?.upgrades),
      growthIssued: fromMember(m?.issued),
      growthEarners: fromMember(m?.earners),
      pointsCredit: fromSummary(s?.period?.pointsEarned),
      pointsDebit: fromSummary(s?.period?.pointsSpent),
      qualifiedInvites: PENDING,
      pendingTotal: PENDING,
    },
    trends: {
      ...(trendRows ? { newUsers: trendRows } : {}),
      ...(pointRows ? { points: pointRows } : {}),
    },
    // Pending is a Brand/Bot snapshot of unresolved items; filters do not hide it.
    pending: pending.error ? null : (pendingView?.items ?? null),
    ...(pendingView ? { pendingGaps: pendingView.gaps } : {}),
    ...(pendingErr ? { pendingFailure: failOf(pendingErr) } : {}),
    ...(filtered
      ? {
          pendingScopeNote:
            "待处理按当前 Brand / Bot 全部未解决事项统计，不随国家或 Platform 筛选变化",
        }
      : {}),
    growth: {
      issued: fromMember(m?.issued),
      earners: fromMember(m?.earners),
      net: fromMember(m?.net),
      upgrades: fromMember(m?.upgrades),
      theoretical: PENDING,
      actual: PENDING,
      correction: PENDING,
      dailyCap: PENDING,
      sources: {
        platform: PENDING,
        referral: PENDING,
        task: PENDING,
        checkin: PENDING,
      },
    },
    levels:
      !filtered && m?.distribution
        ? m.distribution.map((d) => ({ level: d.level, n: String(d.n) }))
        : null,
    points: {
      credit: fromSummary(s?.period?.pointsEarned),
      debit: fromSummary(s?.period?.pointsSpent),
      issued: PENDING,
      spent: PENDING,
      expired: PENDING,
      redeemed: fromSummary(s?.period?.redemptions?.created),
      outstanding: filtered ? PENDING : fromSummary(s?.realtime?.pointsBalance),
    },
    funnel: {
      initiated: PENDING,
      registered: fromSummary(s?.period?.referrals?.newRelations),
      bound: PENDING,
      qualified: PENDING,
      rewarded: PENDING,
    },
    referral: {
      inviters: fromSummary(s?.period?.referrals?.uniqueInviters),
      invitedUsers: fromSummary(s?.period?.referrals?.newRelations),
      qualified: PENDING,
      qualifiedRate: PENDING,
      growthReward: PENDING,
    },
    retention: null,
    retentionDefinition: null,
    privateDomain:
      perfView && freshnessState ? { ...perfView, freshnessState } : perfView,
  };

  return {
    data,
    loading:
      summary.loading ||
      member.loading ||
      perf.loading ||
      dataStatus.loading ||
      pending.loading,
    error: summary.error?.message || null,
    memberTimezone: member.data?.timezone ?? null,
    platforms: platforms.data?.items ?? [],
    allowed: canDash,
  };
}
