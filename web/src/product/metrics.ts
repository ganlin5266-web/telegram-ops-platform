export type Period = "day" | "week" | "month";
export type Aggregation = "SUM" | "DISTINCT" | "SNAPSHOT" | "RATE";
export type Metric = {
  key: string;
  name: string;
  module: string;
  source: string;
  aggregation: Aggregation;
  deduplicated: boolean;
  unit: string;
  platforms: "bot_scope_only" | "not_connected";
  day: string;
  week: string;
  month: string;
  path?: string;
  realtime?: boolean;
};
const metric = (
  key: string,
  name: string,
  module: string,
  source: string,
  aggregation: Aggregation,
  path?: string,
  realtime = false,
): Metric => ({
  key,
  name,
  module,
  source,
  aggregation,
  deduplicated: aggregation === "DISTINCT",
  unit: key.includes("points")
    ? "Points"
    : key === "growth"
      ? "Growth"
      : key === "deposit"
        ? "平台币种"
        : key === "inviteConversion"
          ? "%"
          : "人 / 条",
  platforms: path ? "bot_scope_only" : "not_connected",
  day: aggregation === "SNAPSHOT" ? "当前快照；历史期末未接入" : "日内事实",
  week:
    aggregation === "DISTINCT"
      ? "整周去重用户"
      : aggregation === "RATE"
        ? "整周分子 / 整周分母"
        : aggregation === "SNAPSHOT"
          ? "期末快照待接入"
          : "整周事实求和",
  month:
    aggregation === "DISTINCT"
      ? "整月去重用户"
      : aggregation === "RATE"
        ? "整月分子 / 整月分母"
        : aggregation === "SNAPSHOT"
          ? "期末快照待接入"
          : "整月事实求和",
  path,
  realtime,
});
export const metrics: Metric[] = [
  metric(
    "totalUsers",
    "TG 总用户",
    "用户",
    "telegram_users",
    "SNAPSHOT",
    "realtime.totalUsers",
    true,
  ),
  metric(
    "newUsers",
    "新增用户",
    "用户",
    "first_started_at",
    "SUM",
    "period.newUsers",
  ),
  metric("activeUsers", "活跃用户", "用户", "历史互动事实待接入", "DISTINCT"),
  metric(
    "boundUsers",
    "已绑定平台用户",
    "用户",
    "周期末绑定快照待接入",
    "SNAPSHOT",
  ),
  metric("members", "会员用户", "会员", "正式等级待接入", "SNAPSHOT"),
  metric("upgrades", "升级人数", "会员", "等级事件待接入", "DISTINCT"),
  metric("growth", "Growth 发放", "Growth", "Growth 账务待接入", "SUM"),
  metric(
    "pointsCredit",
    "Points 入账",
    "Points",
    "point_ledger 正值（含退款）",
    "SUM",
    "period.pointsEarned",
  ),
  metric(
    "pointsDebit",
    "Points 扣减",
    "Points",
    "point_ledger 负值（含过期与调整）",
    "SUM",
    "period.pointsSpent",
  ),
  metric(
    "pointsSpend",
    "Points 消耗",
    "Points",
    "消费业务分类聚合待接入",
    "SUM",
  ),
  metric(
    "pointsExpiry",
    "Points 过期",
    "Points",
    "过期业务分类聚合待接入",
    "SUM",
  ),
  metric(
    "pointsRefund",
    "Points 退款",
    "Points",
    "关联兑换退款流水",
    "SUM",
    "period.refunds.points",
  ),
  metric(
    "pointsBalance",
    "当前 Points 余额",
    "Points",
    "point_accounts 当前快照",
    "SNAPSHOT",
    "realtime.pointsBalance",
    true,
  ),
  metric("activityUsers", "活动参与人数", "活动", "参与事件待接入", "DISTINCT"),
  metric("activityDone", "活动完成人数", "活动", "完成事件待接入", "DISTINCT"),
  metric("gameUsers", "游戏参与人数", "游戏", "游戏事件待接入", "DISTINCT"),
  metric("gameChances", "游戏次数", "游戏", "次数账户待接入", "SUM"),
  metric(
    "invites",
    "邀请关系",
    "邀请",
    "referrals.bound_at",
    "SUM",
    "period.referrals.newRelations",
  ),
  metric(
    "inviters",
    "邀请人数",
    "邀请",
    "referrals.inviter_id 周期内去重",
    "DISTINCT",
    "period.referrals.uniqueInviters",
  ),
  metric(
    "inviteConversion",
    "邀请转化率",
    "邀请",
    "有效邀请定义待接入",
    "RATE",
  ),
  metric(
    "redemptions",
    "兑换申请",
    "Points",
    "redemptions.created_at",
    "SUM",
    "period.redemptions.created",
  ),
  metric("pending", "待处理事项", "会员", "跨模块待办聚合待接入", "SNAPSHOT"),
  metric(
    "deposit",
    "充值金额",
    "平台",
    "P4 Canonical Decimal 聚合待接入",
    "SUM",
  ),
];
export function metricValue(
  m: Metric,
  data: unknown,
  filtered = false,
): string | null {
  if (filtered || !m.path || !data) return null;
  let v: any = data;
  for (const key of m.path.split(".")) v = v?.[key];
  return typeof v === "number" || typeof v === "string" ? String(v) : null;
}
export function dayInZone(now: Date, zone: string): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const v = (k: string) => p.find((x) => x.type === k)!.value;
  return `${v("year")}-${v("month")}-${v("day")}`;
}
function midnight(day: string, zone: string): string {
  const target = Date.parse(day + "T00:00:00Z");
  let value = target;
  for (let i = 0; i < 4; i++) {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(value);
    const v = (k: string) => p.find((x) => x.type === k)!.value;
    const wall = Date.parse(
      `${v("year")}-${v("month")}-${v("day")}T${v("hour")}:${v("minute")}:${v("second")}Z`,
    );
    const delta = target - wall;
    value += delta;
    if (!delta) break;
  }
  return new Date(value).toISOString();
}
export function periodRange(day: string, period: Period, zone: string) {
  const d = new Date(day + "T00:00:00Z");
  if (!Number.isFinite(+d) || d.toISOString().slice(0, 10) !== day)
    throw Error("invalid_date");
  if (period === "week")
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  if (period === "month") d.setUTCDate(1);
  const start = d.toISOString().slice(0, 10);
  if (period === "month") d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCDate(d.getUTCDate() + (period === "week" ? 7 : 1));
  return {
    from: midnight(start, zone),
    to: midnight(d.toISOString().slice(0, 10), zone),
  };
}
