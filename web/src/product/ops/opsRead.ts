// Batch 1 read-only contract adapter (/v1/brands/:b/bots/:bot/ops/*).
// Pure mapping: backend status → Cell. Never sums platforms, never converts
// currency, never turns missing data into 0.
import {
  INCOMPLETE,
  NA,
  NO_ACCESS,
  PENDING,
  type Cell,
  type Completeness,
  type PendingItem,
  type PerfKey,
  type PerfRow,
  type PrivatePerf,
} from "./model";

export type OpsMetric = {
  status:
    | "ok"
    | "not_applicable"
    | "backend_pending"
    | "data_incomplete"
    | "forbidden";
  value: string | number | null;
  currency?: string | null;
  reason?: string;
};
export type OpsCompleteness =
  "complete" | "incomplete" | "unknown" | "conflicting" | "missing";
export type OpsPerfRow = {
  platformId: string;
  code: string;
  displayName: string;
  currency: string;
  timezone?: string;
  completeness: OpsCompleteness;
  depositors: OpsMetric;
  depositAmount: OpsMetric;
  netDeposit: OpsMetric;
};
export type OpsPerf = {
  scope: {
    platformId: string | null;
    period: string;
    from: string;
    to: string;
  };
  platforms: OpsPerfRow[];
  total: {
    depositors: OpsMetric;
    depositAmount: OpsMetric;
    netDeposit: OpsMetric;
  } | null;
};
export type OpsDataStatus = {
  items: {
    platformId: string;
    code?: string;
    displayName?: string;
    timezone?: string;
    currency?: string;
    latestBusinessDate: string | null;
    completeness: OpsCompleteness;
    reviewRequired?: boolean;
  }[];
  expectedBusinessDate?: OpsMetric;
};
export type OpsPending = Record<
  | "identityReview"
  | "identityConflict"
  | "platformDataReview"
  | "qualificationReview"
  | "growthReview"
  | "lowInventory",
  OpsMetric
>;
export type OpsScale = { members: OpsMetric; growthGranted: OpsMetric };

/** Exact decimal text: drop only trailing zeros, never round. */
export function decimalText(v: string) {
  return v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v;
}
export function metricCell(m: OpsMetric | undefined): Cell {
  if (!m) return PENDING;
  if (m.status === "not_applicable") return NA;
  if (m.status === "data_incomplete") return INCOMPLETE;
  if (m.status === "forbidden") return NO_ACCESS;
  if (m.status !== "ok" || m.value === null) return PENDING;
  const text =
    typeof m.value === "number" ? String(m.value) : decimalText(m.value);
  return { s: "value", v: m.currency ? `${text} ${m.currency}` : text };
}
export const completenessOf = (c: OpsCompleteness): Completeness =>
  c === "complete"
    ? "complete"
    : c === "incomplete"
      ? "partial"
      : c === "conflicting"
        ? "conflict"
        : c === "unknown"
          ? "unknown"
          : "missing";

// unknown ranks above incomplete so 「完整性未知」 is never hidden by 「部分缺失」.
const rank: OpsCompleteness[] = [
  "conflicting",
  "missing",
  "unknown",
  "incomplete",
  "complete",
];
const worst = (cs: OpsCompleteness[]): OpsCompleteness =>
  rank.find((r) => cs.includes(r)) ?? "unknown";

const rowCells = (m: {
  depositors: OpsMetric;
  depositAmount: OpsMetric;
  netDeposit: OpsMetric;
}): Record<PerfKey, Cell> => ({
  returnActive: PENDING,
  depositors: metricCell(m.depositors),
  depositAmount: metricCell(m.depositAmount),
  repeatDepositors: PENDING,
  repeatRate: PENDING,
  netDeposit: metricCell(m.netDeposit),
});

export function mapPrivatePerf(
  perf: OpsPerf | undefined,
  status?: OpsDataStatus,
): PrivatePerf | null {
  if (!perf || !perf.platforms.length) return null;
  const single = perf.scope.platformId ? perf.platforms[0] : null;
  const source = single ?? perf.total;
  if (!source) return null;
  // Freshness describes the latest activated business day (status endpoint),
  // not the selected period, so an unfinished "today" is not shown as 未上传.
  const inScope = (status?.items ?? []).filter((i) =>
    perf.platforms.some((p) => p.platformId === i.platformId),
  );
  const dates = inScope
    .map((i) => i.latestBusinessDate)
    .filter((d): d is string => !!d)
    .sort();
  const notes: string[] = [];
  if (inScope.some((i) => i.reviewRequired)) notes.push("有数据批次待复核");
  if (inScope.some((i) => !i.latestBusinessDate))
    notes.push("部分 Platform 尚无已生效数据");
  const cs = inScope.map((i) => i.completeness);
  if (cs.includes("unknown") && cs.includes("incomplete"))
    notes.push("另有 Platform 部分缺失");
  // Total reason may be one_or_more_platforms_incomplete: also inspect each platform row.
  const reasons = [source, ...perf.platforms]
    .flatMap((m) => [m.depositors, m.depositAmount, m.netDeposit])
    .map((m) => m?.reason);
  const notice =
    [
      reasons.includes("period_open") ? "统计周期尚未结束，数据未完整" : "",
      reasons.includes("multiple_currencies")
        ? "各 Platform 币种不同，金额不合计，请查看 Platform 对比"
        : "",
    ]
      .filter(Boolean)
      .join("；") || undefined;
  const breakdown: PerfRow[] | null = single
    ? null
    : perf.platforms.map((p) => ({
        platform: p.code,
        name: p.displayName,
        timezone: p.timezone,
        values: rowCells(p),
      }));
  return {
    metrics: rowCells(source),
    freshness: inScope.length
      ? {
          latestBusinessDate: dates[0] ?? "—",
          completeness: completenessOf(
            worst(inScope.map((i) => i.completeness)),
          ),
          ...(notes.length ? { note: notes.join("；") } : {}),
        }
      : null,
    trends: {},
    breakdown,
    ...(notice ? { notice } : {}),
  };
}

const pendingMeta: Record<
  Exclude<keyof OpsPending, "lowInventory">,
  Omit<PendingItem, "key" | "count">
> = {
  identityReview: {
    label: "UID 审核",
    reason: "用户提交的平台 UID 等待人工核对",
    severity: "normal",
    target: "identities",
  },
  identityConflict: {
    label: "身份冲突",
    reason: "平台账号身份存在冲突，需要人工处理",
    severity: "critical",
    target: "identities",
  },
  platformDataReview: {
    label: "平台数据复核",
    reason: "导入批次需要复核或存在数据冲突",
    severity: "critical",
    target: "daily-data",
  },
  qualificationReview: {
    label: "Qualification 复核",
    reason: "资格结果需要人工复核",
    severity: "normal",
    target: "entitlements",
  },
  growthReview: {
    label: "Growth 人工复核",
    reason: "Growth 评估需要人工复核",
    severity: "normal",
    target: "membership",
  },
};
export type PendingGap = {
  key: string;
  label: string;
  state: "forbidden" | "pending" | "incomplete";
};
export type PendingView = { items: PendingItem[]; gaps: PendingGap[] };
const gapState = (m: OpsMetric | undefined): PendingGap["state"] =>
  m?.status === "forbidden"
    ? "forbidden"
    : m?.status === "data_incomplete"
      ? "incomplete"
      : "pending";
/** null = whole endpoint unavailable. Real zeros are omitted from items;
 *  every non-ok category is reported in gaps (never shown as 0). */
export function mapPending(p: OpsPending | undefined): PendingView | null {
  if (!p) return null;
  const all = [
    ...(Object.keys(pendingMeta) as (keyof typeof pendingMeta)[]),
    "lowInventory" as const,
  ];
  const items: PendingItem[] = [];
  const gaps: PendingGap[] = [];
  for (const k of all) {
    const m = p[k];
    const label =
      k === "lowInventory" ? "兑换码库存不足" : pendingMeta[k].label;
    if (m?.status === "ok" && m.value !== null) {
      if (Number(m.value) > 0 && k !== "lowInventory")
        items.push({ key: k, count: String(m.value), ...pendingMeta[k] });
    } else gaps.push({ key: k, label, state: gapState(m) });
  }
  return { items, gaps };
}
