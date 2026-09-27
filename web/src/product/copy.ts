// Shared product vocabulary. Existing operational forms retain their own translations.
export const productCopy = {
  nav: {
    overview: "总览",
    users: "用户",
    membership: "会员",
    activities: "活动",
    points: "积分",
    games: "游戏",
    data: "数据",
    settings: "设置",
  },
  pending: "待接入",
  soon: "尚未开放",
  advanced: "高级诊断 · 仅管理员",
  subtitle: "把用户、成长与运营连接起来。",
  unavailable: "正式规则尚未批准，当前仅展示产品位置。",
  membership: ["会员等级", "升级要求", "Growth 来源", "等级权益"],
  activities: ["签到", "任务", "邀请", "限时活动", "会员专属", "新人活动"],
  games: ["幸运转盘", "幸运宝箱", "刮刮卡", "幸运翻牌"],
  stages: ["选择内容", "设置条件", "预览", "发布"],
  settings: ["品牌与 Bot", "语言与主题", "帮助", "基础规则"],
} as const;
