// Admin Growth Operations view model. Every number is a server-provided
// string; the UI never sums daily counts, averages rates or derives Levels.
export type Period = "day" | "week" | "month";
export type Cell =
  | { s: "value"; v: string }
  | { s: "na" } // 不适用
  | { s: "pending" } // 待接入：没有可靠数据源
  | { s: "incomplete" } // 数据不完整：数据源缺失/未完整导入（绝不显示 0）
  | { s: "error" } // 加载失败
  | { s: "forbidden" }; // 无权限（不发送请求或后端拒绝），绝不显示 0 或待接入
export const val = (v: unknown): Cell =>
  typeof v === "string" || typeof v === "number"
    ? { s: "value", v: String(v) }
    : { s: "pending" };
export const PENDING: Cell = { s: "pending" };
export const ERROR: Cell = { s: "error" };
export const NA: Cell = { s: "na" };
export const INCOMPLETE: Cell = { s: "incomplete" };
export const NO_ACCESS: Cell = { s: "forbidden" };

export type Scope = {
  period: Period;
  day: string;
  platform: string;
  market: string;
};
export const coreKeys = [
  "totalUsers",
  "newUsers",
  "activeUsers",
  "boundUsers",
  "members",
  "upgrades",
  "growthIssued",
  "growthEarners",
  "pointsCredit",
  "pointsDebit",
  "qualifiedInvites",
  "pendingTotal",
] as const;
export type CoreKey = (typeof coreKeys)[number];
/** Dashboard block A · 私域规模 (existing private-domain data only). */
export const primaryKeys = [
  "totalUsers",
  "newUsers",
  "members",
  "activeUsers",
] as const satisfies readonly CoreKey[];
/** Lower-weight context metrics shown under 私域规模. */
export const secondaryKeys = [
  "boundUsers",
  "upgrades",
  "qualifiedInvites",
] as const satisfies readonly CoreKey[];

/**
 * 私域关联业绩 (TG-linked performance). Frozen to 6 metrics; every value is
 * backend-defined (TG-linked ≠ TG-attributed). Never summed/averaged here.
 */
export const perfKeys = [
  "returnActive",
  "depositors",
  "depositAmount",
  "repeatDepositors",
  "repeatRate",
  "netDeposit",
] as const;
export type PerfKey = (typeof perfKeys)[number];
export const perfMeta: Record<PerfKey, { name: string; tip: string }> = {
  returnActive: {
    name: "回流活跃",
    tip: "TG 关联用户中，周期内产生后端定义的平台有效活跃行为的人数",
  },
  depositors: {
    name: "充值人数",
    tip: "TG 关联用户中，周期内产生有效充值的去重人数",
  },
  depositAmount: {
    name: "充值金额",
    tip: "TG 关联用户周期内的有效充值金额（带币种，由后端口径返回）",
  },
  repeatDepositors: {
    name: "复充人数",
    tip: "按后端正式复充口径计算的 TG 关联用户人数",
  },
  repeatRate: { name: "复充率", tip: "按后端正式口径返回，前端不计算" },
  netDeposit: {
    name: "充提差",
    tip: "按后端正式财务口径返回；提款数据不完整时显示「数据不完整」",
  },
};
export const perfTrendKeys = [
  "depositAmount",
  "netDeposit",
  "returnActive",
  "repeatDepositors",
] as const satisfies readonly PerfKey[];
export type Completeness =
  "complete" | "partial" | "missing" | "conflict" | "unknown";
export const completenessText: Record<Completeness, string> = {
  complete: "完整",
  partial: "部分缺失",
  missing: "未上传",
  conflict: "数据冲突",
  unknown: "完整性未知",
};
export type PerfRow = {
  platform: string;
  name: string;
  timezone?: string;
  values: Partial<Record<PerfKey, Cell>>;
};
export type PrivatePerf = {
  metrics: Record<PerfKey, Cell>;
  /** Data freshness of the current scope; null = 数据状态待接入 (never a fake date). */
  freshness: {
    latestBusinessDate: string;
    completeness: Completeness;
    note?: string;
  } | null;
  trends: Partial<Record<PerfKey, TrendRow[]>>;
  /** Backend Platform breakdown for 全部 Platform; null = 待接入. */
  breakdown: PerfRow[] | null;
  /** Backend-reason notice, e.g. multiple currencies or open period. */
  notice?: string;
  /** Request failed / forbidden: never rendered as 待接入. */
  failure?: "error" | "forbidden" | "unsupported";
  /** Why freshness is null: status endpoint forbidden / failed / not deployed / empty. */
  freshnessState?: "forbidden" | "error" | "pending" | "empty";
};
export const trendKeys = [
  "newUsers",
  "activeUsers",
  "members",
  "growth",
  "points",
  "qualified",
] as const;
export type TrendKey = (typeof trendKeys)[number];
export type TrendRow = { date: string; values: Cell[] };
export type PendingItem = {
  key: string;
  label: string;
  count: string;
  reason: string;
  severity: "critical" | "normal";
  target: string;
};
export type OpsData = {
  preview?: boolean;
  timezone: string | null;
  updatedAt: string | null;
  realtime: boolean;
  metrics: Record<CoreKey, Cell>;
  /** Backend-provided period comparison, e.g. "+12.4%". Never computed in the frontend. */
  deltas?: Partial<Record<CoreKey, string>>;
  /** Missing trend key = 待接入. Values follow trendSeries[key].columns. */
  trends: Partial<Record<TrendKey, TrendRow[]>>;
  /** null = 待处理聚合待接入 */
  pending: PendingItem[] | null;
  /** Categories without a real count (no permission / not live / incomplete). */
  pendingGaps?: {
    key: string;
    label: string;
    state: "forbidden" | "pending" | "incomplete";
  }[];
  /** Pending endpoint failed or denied: never shown as 「当前无待处理事项」. */
  pendingFailure?: "error" | "forbidden";
  /** Pending is a Brand/Bot snapshot; shown with this note when a Platform/Market filter is active. */
  pendingScopeNote?: string;
  growth: {
    issued: Cell;
    earners: Cell;
    net: Cell;
    upgrades: Cell;
    theoretical: Cell;
    actual: Cell;
    correction: Cell;
    dailyCap: Cell;
    sources: Record<"platform" | "referral" | "task" | "checkin", Cell>;
    advanced?: [string, string][];
  };
  /** Real period-end snapshot from backend; null = 待接入 */
  levels: { level: number; n: string }[] | null;
  points: Record<
    | "credit"
    | "debit"
    | "issued"
    | "spent"
    | "expired"
    | "redeemed"
    | "outstanding",
    Cell
  >;
  funnel: Record<
    "initiated" | "registered" | "bound" | "qualified" | "rewarded",
    Cell
  >;
  referral: Record<
    | "inviters"
    | "invitedUsers"
    | "qualified"
    | "qualifiedRate"
    | "growthReward",
    Cell
  >;
  /** null = Cohort 口径待接入 */
  retention: { segment: string; d1: Cell; d3: Cell; d7: Cell }[] | null;
  retentionDefinition: string | null;
  /** 私域关联业绩; null/undefined = 整块待接入 */
  privateDomain?: PrivatePerf | null;
  /** 运营投入 (Growth 发放 / Points 发放 / 兑换奖励)；只显示后端真实能力 */
  investment?: { growth: Cell; points: Cell; rewards: Cell };
};

export const coreMeta: Record<
  CoreKey,
  { name: string; agg: string; tip?: string }
> = {
  totalUsers: {
    name: "TG 总用户",
    agg: "SNAPSHOT",
    tip: "当前 Bot 已启动过的 Telegram 用户总数（实时快照）",
  },
  newUsers: { name: "新增用户", agg: "SUM", tip: "周期内首次启动 Bot 的用户" },
  activeUsers: {
    name: "活跃用户",
    agg: "DISTINCT",
    tip: "周期内有互动的去重用户；正式口径由后端定义",
  },
  boundUsers: {
    name: "已绑定用户",
    agg: "SNAPSHOT",
    tip: "周期末已有有效平台账号绑定的用户",
  },
  members: {
    name: "会员人数",
    agg: "SNAPSHOT",
    tip: "周期末处于会员状态的人数",
  },
  upgrades: {
    name: "升级人数",
    agg: "DISTINCT",
    tip: "周期内至少升级一次的去重会员，按等级事件统计",
  },
  growthIssued: {
    name: "Growth 发放",
    agg: "SUM",
    tip: "周期内发放给会员的 Growth 总量",
  },
  growthEarners: {
    name: "Growth 获得人数",
    agg: "DISTINCT",
    tip: "周期内获得正向 Growth 的去重会员（不含后台调整）",
  },
  pointsCredit: {
    name: "Points 入账",
    agg: "SUM",
    tip: "Points 流水正值，含退款返还",
  },
  pointsDebit: {
    name: "Points 扣减",
    agg: "SUM",
    tip: "Points 流水负值，含消耗、过期与调整",
  },
  qualifiedInvites: {
    name: "有效邀请",
    agg: "SUM",
    tip: "被邀请人完成注册、绑定并达标的邀请；口径由后端定义",
  },
  pendingTotal: {
    name: "待处理",
    agg: "SNAPSHOT",
    tip: "当前需要运营处理的事项总数",
  },
};
export const trendSeries: Record<
  TrendKey,
  { name: string; columns: string[] }
> = {
  newUsers: { name: "新增用户", columns: ["新增用户"] },
  activeUsers: { name: "活跃", columns: ["活跃用户"] },
  members: { name: "会员增长", columns: ["新增会员"] },
  growth: { name: "Growth", columns: ["Growth 发放"] },
  points: { name: "Points 入账/扣减", columns: ["入账", "扣减"] },
  qualified: { name: "有效邀请", columns: ["有效邀请"] },
};

export function fmt(c: Cell): string {
  if (c.s === "pending") return "待接入";
  if (c.s === "na") return "—";
  if (c.s === "error") return "加载失败";
  if (c.s === "incomplete") return "数据不完整";
  if (c.s === "forbidden") return "无权限";
  return /^-?\d+$/.test(c.v)
    ? new Intl.NumberFormat("zh-CN").format(BigInt(c.v))
    : c.v;
}
/** Ratio of two counts from the same payload/period; never averaged. */
export function share(part: Cell, whole: Cell): string | null {
  if (part.s !== "value" || whole.s !== "value") return null;
  const p = Number(part.v),
    w = Number(whole.v);
  if (!Number.isFinite(p) || !Number.isFinite(w) || w <= 0) return null;
  return `${((p / w) * 100).toFixed(1)}%`;
}

/** Calendar date arithmetic on YYYY-MM-DD strings (business dates, no browser TZ). */
export function addDays(day: string, n: number) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function periodDays(
  day: string,
  period: Period,
): { start: string; end: string } {
  const d = new Date(day + "T00:00:00Z");
  if (!Number.isFinite(+d) || d.toISOString().slice(0, 10) !== day)
    throw Error("invalid_date");
  if (period === "day") return { start: day, end: day };
  if (period === "week") {
    const start = addDays(day, -((d.getUTCDay() + 6) % 7));
    return { start, end: addDays(start, 6) };
  }
  const start = day.slice(0, 8) + "01";
  const e = new Date(start + "T00:00:00Z");
  e.setUTCMonth(e.getUTCMonth() + 1, 0);
  return { start, end: e.toISOString().slice(0, 10) };
}
/** Trend window: 近 7 日 for day, otherwise the selected week/month. */
export function trendDays(day: string, period: Period) {
  return period === "day"
    ? { start: addDays(day, -6), end: day }
    : periodDays(day, period);
}
export const periodLabel: Record<Period, string> = {
  day: "日",
  week: "周",
  month: "月",
};
