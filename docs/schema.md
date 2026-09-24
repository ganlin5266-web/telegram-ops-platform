# 数据表清单（23 张业务表 + Migration 元数据）

完整字段、CHECK、唯一索引、外键与触发器见 `db/migrations/001_core.sql`、`002_harden_ledger.sql`、`003_ledger_conflict_safety.sql`。不使用 JSON 替代核心用户/积分/订单关系。

| 表 | 用途及关键约束 |
|---|---|
| brands | 品牌、slug、默认语言、目标国家；名称不写死 |
| telegram_bots | 所属品牌、username、状态、默认及支持语言、Secret 引用；品牌/Bot 复合唯一 |
| telegram_chats | Bot 绑定频道/群、Telegram chat ID、目标语言 |
| telegram_users | 每 Bot 的 Telegram 用户档案；Telegram ID bigint；username 可变 |
| telegram_updates | Bot + update_id 唯一收据；事件类型、处理状态、时间 |
| message_templates | Bot + 模板 Key + 语言唯一；正文、启用、版本 |
| bot_menu_items | 语言、标签、按钮动作、排序；callback 1–64 字节；URL 仅 HTTPS |
| point_accounts | Bot + 用户唯一账户；非负 bigint 余额，余额从零开始 |
| point_ledger | 每次变化、前后余额、来源、业务 ID、幂等 Key；不可修改/删除 |
| referrals | 邀请人/被邀请人、参数、首次绑定时间、奖励状态；禁自邀、重复绑定 |
| activities | 活动类型、时间、状态、目标语言；规则及分群配置使用 JSON |
| activity_rewards | 活动、用户、事件、积分奖励、发放状态；事件唯一 |
| redemption_rules | 档位/全部积分、比例、限额、充值要求、审核方式；默认禁用 |
| redemptions | 用户/规则/积分成本/规则快照、状态、请求 Key；同 Bot Key 唯一 |
| redemption_codes | 兑换码 Secret 引用、指纹、过期时间、分配订单；一单一码 |
| admins | 外部 auth_subject、后台 UI 语言、状态 |
| roles | Super Admin / Admin / Operator / Viewer |
| permissions | 用户查看、积分调整、兑换审核、活动、发布、Bot、系统管理 |
| role_permissions | 角色与权限多对多 |
| admin_roles | 管理员角色绑定及品牌/Bot 作用域 |
| audit_logs | 管理员、时间、范围、对象、前后值、请求 ID/IP、备注；不可改删 |
| scheduled_messages | 接收用户或群/频道、目标语言、指令与最终正文分离、确认、计划时间 |
| message_delivery_logs | 每次发送结果、Telegram message ID、错误、重试次数、uncertain 状态 |
| schema_migrations | Migration 文件名、SHA256、应用时间；已应用文件不能静默修改 |

合计 **23 张业务表 + 1 张 Migration 元数据表**（此处按实际 CREATE TABLE 统计；同类模型拆成必要关系表）。

主关系：brands → telegram_bots → telegram_users / telegram_chats；users → point_accounts → point_ledger；users ↔ referrals；redemption_rules → redemptions → redemption_codes；admins → admin_roles → roles → role_permissions → permissions；所有核心租户外键含 brand_id/bot_id。
