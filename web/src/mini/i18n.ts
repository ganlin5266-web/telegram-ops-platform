export const supportedUiLocales = [
  "zh-CN",
  "pt-BR",
  "es-MX",
  "en",
  "fil",
] as const;
export type Locale = (typeof supportedUiLocales)[number];
export const localeNames: Record<Locale, string> = {
  "zh-CN": "简体中文",
  "pt-BR": "Português (Brasil)",
  "es-MX": "Español (México)",
  en: "English",
  fil: "Filipino",
};
export const zh = {
  home: "首页",
  activities: "活动",
  rewards: "奖励",
  invite: "邀请",
  me: "我的",
  navigation: "主导航",
  staging: "STAGING",
  welcome: "你好，{name}",
  member: "会员",
  space: "你的会员中心",
  greeting: "欢迎来到 {brand}",
  connect: "连接 Telegram 身份",
  connecting: "正在连接…",
  intro: "发现活动、查看奖励，把每一份收获留在这里。",
  loggedOut: "已安全退出",
  reopen: "需要再次登录时，请关闭并从 Bot 重新打开。",
  focus: "今日重点",
  ready: "你的会员中心已经准备好了",
  readyBody: "活动正在准备中。先看看即将开放的内容，找到你感兴趣的方向。",
  returnTitle: "欢迎回来，看看今天的新内容",
  returnBody: "你的积分和记录都在这里。活动开放后，可在活动中心查看规则。",
  focusCta: "查看即将开放",
  summary: "我的会员摘要",
  points: "我的积分",
  pointsUnit: "Points",
  friends: "邀请好友",
  myRedeem: "我的兑换",
  quick: "快捷入口",
  recommend: "值得期待",
  activityCentre: "活动中心",
  rewardCentre: "奖励中心",
  games: "小游戏",
  soon: "即将开放",
  upcoming: "敬请期待",
  schedule: "开放时间待公布",
  activityIntro: "每天回来看看，新的福利与任务将在这里发布。",
  newcomer: "新人福利",
  newcomerBody: "为第一次来到这里的你准备，具体规则开放时公布。",
  daily: "每日签到",
  dailyBody: "让每天的回访更有意义，开放后查看参与方式。",
  free: "免费活动",
  freeBody: "轻松参与的新体验，开放后查看完整规则。",
  inviteBody: "好友同行的更多可能，具体条件与奖励待公布。",
  future: "后续计划",
  platformTask: "平台任务",
  milestone: "人数里程碑",
  pointsBody: "积分用途以正式发布的活动与兑换规则为准。",
  pointsEmptyBody: "开放的活动如提供积分，完成后将在这里显示。",
  ledger: "积分明细",
  redeemCentre: "兑换中心",
  redeemSoon: "兑换功能即将开放",
  ledgerEmpty: "还没有积分记录",
  ledgerHint: "完成开放的积分活动后，记录会显示在这里。",
  redeemEmpty: "还没有兑换记录",
  redeemHint: "完成兑换后，你可以在这里查看进度与结果。",
  inviteEmpty: "还没有邀请记录",
  inviteHint: "邀请功能开放后，你可以在这里查看好友进度。",
  inviteTitle: "好朋友，一起发现更多",
  inviteLead: "邀请活动开放后，好友满足公布条件才可获得对应奖励。",
  invited: "已邀请人数",
  pendingReward: "待确认奖励",
  rulesUnpublished: "规则尚未发布",
  inviteSoon: "邀请功能即将开放",
  inviteHistory: "邀请记录",
  rules: "邀请规则",
  journey1: "分享专属入口",
  journey2: "好友完成条件",
  journey3: "查看奖励结果",
  journeyNote: "以下为开放后的流程预览，当前不可发起邀请。",
  platformAccount: "平台账号",
  entitlements: "我的权益",
  language: "语言",
  help: "帮助",
  helpBody: "账户或记录问题请联系项目运营人员。不要发送密码或认证信息。",
  logout: "退出登录",
  gameTitle: "游戏中心即将开放",
  gameBody: "轻松有趣的新体验正在准备中。本页不提供抽奖、次数或奖励。",
  wheel: "幸运转盘",
  chest: "幸运宝箱",
  scratch: "刮刮卡",
  cards: "幸运翻牌",
  close: "关闭",
  back: "返回",
  loading: "正在读取…",
  retry: "重试",
  more: "查看更多",
  diagnostics: "诊断信息",
  supportId: "支持编号",
  localeDevice: "语言偏好保存在此设备，仅用于当前会员中心。",
  fallbackNotice: "此语言的完整翻译正在准备中，当前使用英文。",
  income: "积分收入",
  spend: "积分支出",
  relation: "邀请关系",
  requestRecord: "兑换申请",
  recorded: "已记录",
  posted: "已入账",
  bound: "已绑定",
  qualified: "已满足条件",
  invalid: "无效",
  pending: "待处理",
  processing: "处理中",
  success: "已完成",
  failed: "未完成",
  cancelled: "已取消",
  network: "连接暂时中断，请稍后重试。",
  timeout: "响应较慢，请稍后重试。",
  invalid_json: "暂时无法读取，请稍后重试。",
  unauthorized: "身份已失效，请关闭并重新打开小程序。",
  forbidden: "当前操作不可用。",
  not_found: "内容暂不可用。",
  conflict: "状态已变化，请重新读取。",
  rate_limit: "操作较频繁，请稍后再试。",
  server: "服务暂时繁忙，请稍后重试。",
  request: "暂时无法完成，请稍后重试。",
  telegram_required: "请从所属 Bot 的小程序入口打开。",
  unavailable: "内容正在准备中",
  uidPending: "待验证",
  uidVerified: "已验证",
  uidRejected: "验证失败",
  uidConflict: "暂无法绑定",
  uidRevoked: "已解除绑定",
  uidUnbound: "未绑定",
  uidRefresh: "刷新状态",
  uidIntro: "填写 UID 只是提交验证申请，不代表验证成功。",
  uidNoPlatforms: "当前尚无可用平台。",
  uidPendingHelp: "正在验证，请等待管理员核对。",
  uidVerifiedHelp: "账号身份已验证。需要换绑请联系客服。",
  uidConflictHelp: "该账号暂无法绑定，请联系客服。",
  uidRejectedHelp: "验证未通过，请核对 UID 后重新提交。",
  uidUnavailable: "当前平台暂停接受申请。",
  uidLabel: "平台 UID",
  uidPrivacy: "仅填写平台 UID，不要填写密码或验证码。",
  uidSubmit: "提交验证",
  uidBind: "绑定账号",
  uidResubmit: "重新提交",
  uidHistory: "绑定历史",
  platformData: "平台数据",
  dataUpdatedThrough: "已更新至",
  dataWaiting: "等待更新",
} as const;
export type Key = keyof typeof zh;
const en: Record<Key, string> = {
  home: "Home",
  activities: "Activities",
  rewards: "Rewards",
  invite: "Invite",
  me: "Me",
  navigation: "Main navigation",
  staging: "STAGING",
  welcome: "Hello, {name}",
  member: "Member",
  space: "Your member centre",
  greeting: "Welcome to {brand}",
  connect: "Connect with Telegram",
  connecting: "Connecting…",
  intro: "Discover activities and keep your rewards and records together.",
  loggedOut: "Signed out safely",
  reopen: "To sign in again, close this app and reopen it from the Bot.",
  focus: "Today’s focus",
  ready: "Your member centre is ready",
  readyBody:
    "Activities are being prepared. Explore what is coming and find what interests you.",
  returnTitle: "Welcome back. Explore what’s next",
  returnBody:
    "Your points and records are here. Published activity rules will appear in Activities.",
  focusCta: "Explore what’s coming",
  summary: "My membership",
  points: "My points",
  pointsUnit: "Points",
  friends: "Invite friends",
  myRedeem: "My redemptions",
  quick: "Quick access",
  recommend: "Coming your way",
  activityCentre: "Activity centre",
  rewardCentre: "Reward centre",
  games: "Mini games",
  soon: "Coming soon",
  upcoming: "Stay tuned",
  schedule: "Dates to be announced",
  activityIntro:
    "Check back for new benefits and tasks when they are published.",
  newcomer: "Welcome benefits",
  newcomerBody:
    "For your first visit. Details will be published when available.",
  daily: "Daily check-in",
  dailyBody:
    "Make returning each day meaningful. Participation details are coming.",
  free: "Free activities",
  freeBody: "Discover new experiences when the full rules are available.",
  inviteBody:
    "Explore more with friends. Conditions and rewards are not yet published.",
  future: "Planned for later",
  platformTask: "Platform tasks",
  milestone: "Community milestones",
  pointsBody:
    "Uses for points depend on published activity and redemption rules.",
  pointsEmptyBody:
    "When published activities offer points, completed rewards will appear here.",
  ledger: "Points history",
  redeemCentre: "Redemption centre",
  redeemSoon: "Redemptions are coming soon",
  ledgerEmpty: "No points history yet",
  ledgerHint:
    "Records will appear after you complete available points activities.",
  redeemEmpty: "No redemptions yet",
  redeemHint: "After redeeming, you can track progress and results here.",
  inviteEmpty: "No invitations yet",
  inviteHint:
    "When invitations open, you can follow your friends’ progress here.",
  inviteTitle: "Discover more with friends",
  inviteLead:
    "When invitations open, rewards depend on friends meeting the published conditions.",
  invited: "Friends invited",
  pendingReward: "Rewards to confirm",
  rulesUnpublished: "Rules not yet published",
  inviteSoon: "Invitations are coming soon",
  inviteHistory: "Invitation history",
  rules: "Invitation rules",
  journey1: "Share your invitation",
  journey2: "Friend meets conditions",
  journey3: "Check reward outcome",
  journeyNote:
    "This previews the future flow. Invitations are not available yet.",
  platformAccount: "Platform account",
  entitlements: "My benefits",
  language: "Language",
  help: "Help",
  helpBody:
    "Contact the project operator for account or record questions. Never share passwords or authentication data.",
  logout: "Sign out",
  gameTitle: "Game centre coming soon",
  gameBody:
    "New experiences are being prepared. There are no draws, chances or rewards on this page.",
  wheel: "Lucky wheel",
  chest: "Lucky chest",
  scratch: "Scratch card",
  cards: "Lucky cards",
  close: "Close",
  back: "Back",
  loading: "Loading…",
  retry: "Try again",
  more: "Load more",
  diagnostics: "Diagnostics",
  supportId: "Support reference",
  localeDevice:
    "Your language choice is saved on this device for this member centre.",
  fallbackNotice:
    "Full translation is being prepared. English is shown for now.",
  income: "Points earned",
  spend: "Points spent",
  relation: "Invitation",
  requestRecord: "Redemption request",
  recorded: "Recorded",
  posted: "Posted",
  bound: "Bound",
  qualified: "Qualified",
  invalid: "Invalid",
  pending: "Pending",
  processing: "Processing",
  success: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  network: "Connection interrupted. Please try again.",
  timeout: "The service is slow. Please try again.",
  invalid_json: "Unable to load this right now. Please try again.",
  unauthorized: "Your session has ended. Close and reopen the Mini App.",
  forbidden: "This action is unavailable.",
  not_found: "Content is unavailable.",
  conflict: "The state has changed. Please reload.",
  rate_limit: "Too many attempts. Please wait and try again.",
  server: "The service is busy. Please try again.",
  request: "Unable to complete this right now. Please try again.",
  telegram_required: "Please open this Mini App from its Bot.",
  unavailable: "Content is being prepared",
  uidPending: "Pending verification",
  uidVerified: "Verified",
  uidRejected: "Rejected",
  uidConflict: "Unable to bind",
  uidRevoked: "Revoked",
  uidUnbound: "Not bound",
  uidRefresh: "Refresh status",
  uidIntro:
    "Submitting a UID requests verification; it does not verify ownership.",
  uidNoPlatforms: "No platforms are available yet.",
  uidPendingHelp: "Verification is pending an administrator review.",
  uidVerifiedHelp: "Account identity verified. Contact support to change it.",
  uidConflictHelp: "This account cannot be bound at present. Contact support.",
  uidRejectedHelp:
    "Verification was rejected. Check your UID before submitting again.",
  uidUnavailable: "This platform is not accepting requests.",
  uidLabel: "Platform UID",
  uidPrivacy:
    "Enter only your platform UID, never a password or verification code.",
  uidSubmit: "Submit for verification",
  uidBind: "Bind account",
  uidResubmit: "Resubmit",
  uidHistory: "Binding history",
  platformData: "Platform data",
  dataUpdatedThrough: "Updated through",
  dataWaiting: "Waiting for update",
};
export const dictionaries: Record<Locale, Partial<Record<Key, string>>> = {
  "zh-CN": zh,
  en,
  "pt-BR": {},
  "es-MX": {},
  fil: {},
};
export function normalizeLocale(value?: string | null): Locale | undefined {
  const v = value?.trim().toLowerCase();
  return (
    {
      "zh-cn": "zh-CN",
      zh: "zh-CN",
      "pt-br": "pt-BR",
      pt: "pt-BR",
      "es-mx": "es-MX",
      es: "es-MX",
      en: "en",
      "en-us": "en",
      "en-gb": "en",
      fil: "fil",
      tl: "fil",
      "fil-ph": "fil",
    } as Record<string, Locale>
  )[v ?? ""];
}
export function resolveLocale(p: {
  device?: string | null;
  preferred?: string | null;
  bot?: string | null;
  project?: string | null;
  telegram?: string | null;
  fallback?: string;
}): Locale {
  return [p.device, p.preferred, p.bot, p.project, p.telegram, p.fallback, "en"]
    .map(normalizeLocale)
    .find(Boolean)!;
}
export const contentLocale = (l: Locale): Locale => (l === "zh-CN" ? l : "en");
export function translate(
  locale: Locale,
  key: string,
  values: Record<string, string> = {},
): string {
  const k = key as Key;
  const text = dictionaries[locale][k] ?? en[k] ?? en.unavailable;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");
}
export function formatPoints(
  value: string | null | undefined,
  locale: Locale,
): string {
  if (value == null || !/^[-+]?\d+$/.test(value)) return "—";
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
    BigInt(value),
  );
}
export function formatDate(value: string, locale: Locale): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}
export function formatMoney(
  value: number,
  locale: Locale,
  currency: string,
): string {
  if (!/^[A-Z]{3}$/.test(currency) || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(
    value,
  );
}
const storageKey = (appKey: string) => `mini-ui-language:${appKey}`;
export function readPreference(appKey: string): Locale | undefined {
  try {
    return normalizeLocale(localStorage.getItem(storageKey(appKey)));
  } catch {
    return undefined;
  }
}
export function savePreference(appKey: string, locale: Locale) {
  try {
    localStorage.setItem(storageKey(appKey), locale);
  } catch {
    /* Language remains usable in memory when storage is blocked. */
  }
}
export function homeState(h: {
  points: { accountExists: boolean };
  invitedCount: string;
  redemptionCount: string;
}): "empty_state" | "returning_user" {
  // No claims about first visits without a reliable lifecycle signal.
  return !h.points.accountExists &&
    h.invitedCount === "0" &&
    h.redemptionCount === "0"
    ? "empty_state"
    : "returning_user";
}
