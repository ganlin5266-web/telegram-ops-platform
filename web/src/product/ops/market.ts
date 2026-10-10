// Multi-Market operations model (frontend product target, not backend capability).
// Pure, data-driven helpers: no Market/Platform/Bot names are hard-coded here.
// Real uniqueness / Primary / inventory / atomic redemption stay backend concerns.

export type LifeStatus = "draft" | "active" | "disabled" | "archived";
export const lifeText: Record<LifeStatus, string> = {
  draft: "草稿",
  active: "启用",
  disabled: "已停用",
  archived: "已归档",
};

export type Market = {
  code: string; // system code, e.g. "BR"
  name: string; // admin display, e.g. "Brazil"
  localName?: string; // user-facing local name
  currency: string; // ISO 4217
  timezone: string; // IANA
  status: LifeStatus;
  defaultLanguage?: string;
  languages?: string[];
};

export type DataStatus = "none" | "configuring" | "ready" | "error";
export const dataStatusText: Record<DataStatus, string> = {
  none: "未配置",
  configuring: "配置中",
  ready: "Ready",
  error: "异常",
};
/** Platform Data Capability: what this Platform's standard data can reliably express. */
export const capKeys = [
  "registration",
  "active",
  "firstDeposit",
  "deposit",
  "withdrawal",
  "repeatDeposit",
] as const;
export type CapKey = (typeof capKeys)[number];
export const capText: Record<CapKey, string> = {
  registration: "注册",
  active: "活跃",
  firstDeposit: "首充",
  deposit: "充值",
  withdrawal: "提款",
  repeatDeposit: "复充",
};
export type CapState = "available" | "unavailable" | "pending";
export const capStateText: Record<CapState, string> = {
  available: "已接入",
  unavailable: "不提供",
  pending: "待接入",
};
export type Platform = {
  code: string;
  name: string;
  market: string; // Market.code
  currency: string;
  timezone: string;
  status: LifeStatus;
  dataStatus: DataStatus;
  /** Backend Platform Data Capability; missing = 待接入. */
  capabilities?: Partial<Record<CapKey, CapState>>;
  /** Backend requiredDatasets, e.g. ["user","deposit","withdrawal"] or ["daily_summary"]. */
  requiredDatasets?: string[];
  /** Mapping status for 高级详情 only. */
  mapping?: { version: string; status: string; verifiedAt: string } | null;
};
export const datasetText: Record<string, string> = {
  user: "用户",
  deposit: "充值",
  withdrawal: "提款",
  daily_summary: "综合日报",
  activity: "活跃",
};

/** Which capability each 私域成效 metric depends on (display gate only). */
export const perfNeeds: Record<string, CapKey[]> = {
  returnActive: ["active"],
  depositors: ["deposit"],
  depositAmount: ["deposit"],
  repeatDepositors: ["repeatDeposit"],
  repeatRate: ["repeatDeposit"],
  netDeposit: ["deposit", "withdrawal"],
};
type GCell =
  | { s: "value"; v: string }
  | { s: "na" }
  | { s: "pending" }
  | { s: "incomplete" }
  | { s: "error" }
  | { s: "forbidden" };
/**
 * Display gate for a backend metric cell. Never invents a number:
 * capability unavailable → 不适用; pending → 待接入; missing dataset → 数据不完整.
 */
export function gateMetric<C extends GCell>(
  cell: C,
  need: CapKey[],
  caps?: Partial<Record<CapKey, CapState>>,
  missing: string[] = [],
): GCell {
  if (caps) {
    if (need.some((k) => caps[k] === "unavailable")) return { s: "na" };
    if (need.some((k) => caps[k] !== "available")) return { s: "pending" };
  }
  if (need.some((k) => missing.includes(k))) return { s: "incomplete" };
  return cell;
}

export type TgKind = "bot" | "channel" | "group";
export const tgKindText: Record<TgKind, string> = {
  bot: "Bot",
  channel: "Channel",
  group: "Group",
};
export type TgStatus =
  "active" | "configured" | "disabled" | "error" | "archived";
export const tgStatusText: Record<TgStatus, string> = {
  active: "Active",
  configured: "Configured",
  disabled: "已停用",
  error: "Error",
  archived: "已归档",
};
export type TgResource = {
  id: string;
  kind: TgKind;
  market: string;
  name: string;
  handle: string; // @username or t.me link text
  status: TgStatus;
  primary: boolean;
  purpose?: string;
  /** Secret state only; the token itself never reaches the frontend. null = 待接入 */
  secret?: "configured" | "missing" | null;
};

export type StockState = "ok" | "low" | "out";
export const stockText: Record<StockState, string> = {
  ok: "正常",
  low: "库存低",
  out: "缺货",
};
export type Reward = {
  id: string;
  market: string;
  platform: string;
  label: string; // denomination / reward display, from config
  /** Face value (not company cost) + explicit currency; never guessed. */
  faceValue?: string;
  currency?: string;
  /** Reward Catalog status: disabled rewards produce no new redemptions. */
  status?: "active" | "disabled";
  cost: string | null; // Points cost from redemption config; null = 待接入
  available: string;
  assigned: string;
  used: string;
  /** Backend-decided stock state; the UI never applies its own threshold. */
  stock: StockState | null;
  uploadedAt: string | null;
};

/** Business scope. platform "" = 全部 Platform (a scope state, never a Platform id). */
export type MarketScope = { market: string; platform: string };

const usable = (s: LifeStatus) => s === "active";
/** Markets offered in ordinary scope selectors (no Draft/Disabled/Archived). */
export const scopeMarkets = (ms: Market[]) =>
  ms.filter((m) => usable(m.status));
/** Active Platforms of one Market — the only valid ordinary Platform options. */
export const marketPlatforms = (ps: Platform[], market: string) =>
  ps.filter((p) => p.market === market && usable(p.status));

/** Switching Market always resets Platform (and any Bot/Channel/Group choice). */
export function switchMarket<S extends MarketScope>(s: S, market: string): S {
  return { ...s, market, platform: "" };
}
/** Drops a Platform that does not belong to the current Market (e.g. Mexico + FUN66). */
export function sanitizeScope<S extends MarketScope>(s: S, ps: Platform[]): S {
  if (!s.platform) return s;
  return marketPlatforms(ps, s.market).some((p) => p.code === s.platform)
    ? s
    : { ...s, platform: "" };
}
export function scopeText(ms: Market[], ps: Platform[], s: MarketScope) {
  const m = ms.find((x) => x.code === s.market);
  const p = ps.find((x) => x.code === s.platform && x.market === s.market);
  return `${m?.name ?? (s.market || "未选择国家")} / ${p ? p.name : "全部 Platform"}`;
}
export const marketLabel = (m: Market) => `${m.name} (${m.code})`;

/** Resources of a Market usable for new work (content targets, entry points). */
export const tgOptions = (rs: TgResource[], market: string, kind: TgKind) =>
  rs.filter(
    (r) =>
      r.market === market &&
      r.kind === kind &&
      (r.status === "active" || r.status === "configured"),
  );
export const primaryOf = (rs: TgResource[], market: string, kind: TgKind) =>
  tgOptions(rs, market, kind).find((r) => r.primary) ?? null;

/** Disabling/archiving a Primary resource must be preceded by choosing a new Primary. */
export function disableBlock(r: { primary?: boolean }) {
  return r.primary ? "当前仍为 Primary，请先指定新的 Primary" : null;
}
/** Preview-only Primary switch; the real single-Primary constraint lives in the backend. */
export function setPrimary(rs: TgResource[], id: string): TgResource[] {
  const t = rs.find((r) => r.id === id);
  if (!t) return rs;
  return rs.map((r) =>
    r.market === t.market && r.kind === t.kind
      ? { ...r, primary: r.id === id }
      : r,
  );
}

/** Bot Home /start buttons: 用户中心 always; Channel/Group only when a Primary exists. */
export function botHomeButtons(
  rs: TgResource[],
  market: string,
  miniAvailable = true,
) {
  const out: {
    key: "mini" | "channel" | "group";
    label: string;
    target: string;
  }[] = [];
  if (miniAvailable)
    out.push({ key: "mini", label: "用户中心", target: "Mini App" });
  const c = primaryOf(rs, market, "channel");
  if (c) out.push({ key: "channel", label: "官方频道", target: c.name });
  const g = primaryOf(rs, market, "group");
  if (g) out.push({ key: "group", label: "官方群组", target: g.name });
  return out;
}

/** Inventory strictly isolated by Market + Platform. */
export const inventoryFor = (rs: Reward[], market: string, platform: string) =>
  rs.filter((r) => r.market === market && r.platform === platform);

/** Rewards a user may redeem on one Platform (active catalog only; stock shown, not hidden). */
export const redeemableRewards = (
  rs: Reward[],
  market: string,
  platform: string,
) =>
  inventoryFor(rs, market, platform).filter(
    (r) => r.status !== "disabled" && r.cost != null,
  );
/** Display-only shortfall ("还差 N Points"); the final balance check is the backend's. */
export function shortfall(
  balance: string | null,
  cost: string | null,
): string | null {
  if (
    balance == null ||
    cost == null ||
    !/^\d+$/.test(balance) ||
    !/^\d+$/.test(cost)
  )
    return null;
  const d = BigInt(cost) - BigInt(balance);
  return d > 0n ? d.toString() : null;
}

/** Upload templates (UI Template Contract only, not the backend schema). Market comes from the entry scope. */
export const standardTemplate = [
  "platform_code",
  "reward_amount",
  "currency",
  "points_cost",
  "code",
] as const;
/** Cross-Market advanced batch import only. */
export const crossMarketTemplate = [
  "market_code",
  ...standardTemplate,
] as const;
export function restockTemplate(ctx: {
  market?: string;
  platform?: string;
  reward?: string;
}): readonly string[] {
  if (ctx.reward) return ["code"]; // Market + Platform + Reward known: codes only
  if (ctx.market) return standardTemplate;
  return crossMarketTemplate;
}

/**
 * Inventory Import Preview categories (backend-produced counts; the UI never matches rows itself).
 * Blocking categories keep 确认导入 disabled; which non-blocking issues may be skipped is a backend contract.
 */
export const importCheckKeys = [
  "total",
  "importable",
  "dupInFile",
  "dupInStock",
  "dupAssigned",
  "invalidCode",
  "rewardMissing",
  "costMismatch",
  "currencyMismatch",
  "platformInvalid",
] as const;
export type ImportCheckKey = (typeof importCheckKeys)[number];
export const importCheckText: Record<ImportCheckKey, string> = {
  total: "文件总行数",
  importable: "可导入",
  dupInFile: "文件内重复",
  dupInStock: "库存已存在",
  dupAssigned: "历史已分配",
  invalidCode: "非法兑换码",
  rewardMissing: "未找到对应奖励",
  costMismatch: "积分成本与现有奖励不一致",
  currencyMismatch: "币种与现有奖励不一致",
  platformInvalid: "平台异常（不存在 / 已停用 / 已归档）",
};
export const blockingChecks: ImportCheckKey[] = [
  "rewardMissing",
  "costMismatch",
  "currencyMismatch",
  "platformInvalid",
];
export type ImportPreview = Partial<Record<ImportCheckKey, number>>;
export const importBlocked = (p: ImportPreview) =>
  blockingChecks.filter((k) => (p[k] ?? 0) > 0);

/** Per-Platform stock summary; backend-supplied (never summed from Code rows in the browser). */
export type PlatformStock = {
  platform: string;
  rewards: string;
  available: string;
  low: number;
  out: number;
};
export type CodeBatch = {
  id: string;
  at: string;
  platform: string;
  reward: string;
  file: string;
  total: string;
  ok: string;
  rejected: string;
  operator: string;
  status: "done" | "rejected" | "processing";
};

export type Identity = {
  platform: string;
  status: "verified" | "pending" | "rejected" | "conflict" | "revoked";
};
export const identityText: Record<Identity["status"] | "unbound", string> = {
  verified: "已绑定",
  pending: "审核中",
  rejected: "需要重新处理",
  conflict: "需要重新处理",
  revoked: "需要重新处理",
  unbound: "未绑定",
};
/**
 * Redemption target UX (fixed principle):
 * 0 verified → 先绑定; 1 → 自动选择; 多个 → 用户选择（缺货的也显示，不自动切换）.
 * `eligible` must come from the backend (eligibleRedemptionPlatforms); the
 * frontend never decides eligibility from identities alone.
 */
export type RedeemMode =
  | { kind: "bind" }
  | { kind: "auto"; platform: string; available: boolean }
  | { kind: "choose"; options: { platform: string; available: boolean }[] };
export function redemptionMode(
  ids: Identity[],
  eligible: { platform: string; available: boolean }[],
): RedeemMode {
  const verified = new Set(
    ids.filter((i) => i.status === "verified").map((i) => i.platform),
  );
  const opts = eligible.filter((e) => verified.has(e.platform));
  if (!opts.length) return { kind: "bind" };
  if (opts.length === 1)
    return {
      kind: "auto",
      platform: opts[0]!.platform,
      available: opts[0]!.available,
    };
  return { kind: "choose", options: opts };
}

/** Mask a redemption code for lists; full code is a permissioned detail view. */
export const maskCode = (c: string) =>
  c.length <= 4
    ? "••••"
    : `${"•".repeat(Math.min(8, c.length - 4))}${c.slice(-4)}`;

export const currencies = [
  "BRL",
  "MXN",
  "PHP",
  "USD",
  "EUR",
  "INR",
  "IDR",
  "THB",
  "VND",
  "COP",
  "CLP",
  "PEN",
  "ARS",
];
export const timezones = [
  "America/Sao_Paulo",
  "America/Mexico_City",
  "Asia/Manila",
  "America/Bogota",
  "America/Lima",
  "America/Santiago",
  "America/Argentina/Buenos_Aires",
  "Asia/Jakarta",
  "Asia/Bangkok",
  "Asia/Ho_Chi_Minh",
  "Asia/Kolkata",
  "Europe/London",
  "UTC",
];
// Only languages already supported by the existing i18n.
export const languages = ["zh-CN", "en", "pt-BR", "es-MX"];
