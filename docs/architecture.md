# 第一阶段架构与边界

## 决策

TypeScript 严格模式、Node.js 22+、Fastify 5、PostgreSQL 17、参数化 SQL、Zod。SQL Migration 是数据库模型唯一事实来源；业务不依赖浏览器、Lovable 或 Supabase 直连。生产使用普通 PostgreSQL，未来可以使用独立后端连接 Supabase 托管的 PostgreSQL，但不得把 service-role 密钥交给前端。

目录：src 是 API 与共享事务服务；db/migrations 是 Schema 及数据库保护；tests 是数据库集成测试；docs 是架构、接口和交接；.github/workflows 是构建与 PostgreSQL CI。没有后台 UI，也没有 Telegram 出站网络代码。

## 数据隔离

每个 Bot 必须属于一个 brand。用户唯一身份是 (bot_id, telegram_user_id)，不是 username。不同 Bot 的同一 Telegram ID 有独立运营档案和积分账户；积分默认不跨 Bot 共享。跨 Bot 汇总身份或品牌通用钱包属于以后显式设计的功能。

所有业务关系使用 (brand_id, bot_id, resource_id) 复合外键。API 从路径取得 scope，经管理员角色授权后再执行带 scope 的查询。不能只靠前端筛选防串数据。浏览器没有数据库权限；服务器运行最小权限账号，Migration 使用独立账号。本阶段未实现 RLS，数据库拥有者具有完全权限，不能让 UI 使用该角色。

每个 Bot 的积分事务先锁 Bot，再锁账户/订单。粗粒度锁刻意优先正确性，可能限制单 Bot 吞吐；以后可改为业务 Key 锁加账户锁，但必须保持跨账户同 Key 的语义及固定锁顺序。

## Webhook

POST /webhooks/telegram/{botId}。启用中的品牌/Bot、Secret Header 验证、256KB 请求上限、Zod 校验。Secret 用恒定时间比较。全事务内写 (bot_id, update_id) 唯一收据、更新用户档案、首次绑定邀请；提交后才返回成功。处理异常整个事务回滚，返回 5xx，Telegram 可重试。同 Update 返回 duplicate=true。

/start、普通消息、编辑消息、Callback 可以更新用户；群成员、频道事件目前仅识别类型并记收据，不执行运营规则。不保存完整 Update 原文以减少敏感数据留存。日志仅有请求 ID 与错误码；失败处理不会伪装为成功。请求超时后重投通过收据去重。Webhook 不同步发送 Telegram 消息。

## 积分与兑换

账户余额为 bigint，API 中以十进制字符串传递，避免 JavaScript 精度损失。每个非零变化插入 ledger；数据库 Trigger 持有账户锁、计算前后余额、拒绝负余额。应用不能直接改余额；Ledger/Audit 不允许 UPDATE/DELETE。数据库拥有者仍可绕过保护，所以账号分离必须执行。

Ledger 同时约束 (bot_id,idempotency_key) 和 (bot_id,business_type,business_id)。相同事件返回原结果，不同用户/金额/类型/来源的重复 Key 返回冲突。人工调整与 Audit 同事务。重复请求返回原事件执行后的余额，查询当前余额使用 points 读接口。

兑换订单与扣积分在同一事务；订单 Key 唯一。库存 SELECT FOR UPDATE SKIP LOCKED，单条码仅有一个 redemption_id，单个订单仅能绑定一条码。失败返还创建 redemption_refund Ledger，不删除原扣分。已经分配兑换码的失败退款拒绝自动执行，需要后续人工对账流程，避免已泄露的码再次发放。

基础兑换方法仅内部调用和测试，没有兑换 HTTP 入口；只支持固定积分、无复杂条件的内部预留验证。所有正式规则默认禁用。每日限额、全部兑换、充值条件、自动审核、成功交付状态流转还未实现，服务遇到未实现策略会拒绝。

## 多语言与消息

后台 admins.ui_language 仅供 UI。Telegram 语言函数不接收此值。优先 preferred_language → 支持的 Telegram language_code → Bot default_language → brand default_language。Telegram 的简写语言如 es 只有在 Bot 的区域候选唯一时才能匹配 es-MX。Bot 默认语言必须属于 supported_languages。

模板按 Bot + key + language 唯一；缺少目标模板尝试 Bot 默认、受支持的品牌默认。没有模板就失败，不临时写入中文。品牌默认在 Bot 默认配置有效时通常不会触发。中文只有被显式配置为 Bot 支持/目标语言时才可能成为发送语言。

菜单表按 Bot + item_key + language 配置 label、callback/url、排序、启用状态。后续必须由授权服务校验语言、按钮规则并写 Audit；本期没有菜单编辑 API。

scheduled_messages 分开存 admin_request、target_language、final_content；保留创建人、确认人和确认时间。批准及发送态要求确认字段。AI 仅预留契约，不能把管理员原始指令作为 final_content 默认值。UI 编辑批准内容后必须重新确认；未来发布服务负责这一状态机，本期不存在发送执行器。

未来独立服务端 worker 提取批准的到期消息，创建 delivery logs。Telegram sendMessage 没有通用幂等 Key：网络超时后不能宣称绝对不重复，保留 uncertain 状态并人工核实，不盲目重发。

## 管理权限与 Secret

角色：Super Admin、Admin、Operator、Viewer；admin_roles 可按品牌或 Bot 授权，只有 Super Admin 的空品牌授权是全局。每次请求查询激活管理员及真实权限，不信任浏览器传来的角色。

第一阶段使用服务端配置的随机 Bearer 凭证摘要到管理员 UUID 映射，默认空表拒绝访问。仅供受控服务集成/本地验收，不能把这个映射或共享固定管理令牌打包给 Lovable。下一阶段浏览器登录应接 OIDC/JWT（校验发行方、受众、签名、有效期），映射 auth_subject 至管理员；可通过 Authenticator 注入，RBAC 服务不变。

Bot 表只保存 Secret 引用名，真实 Token/Webhook Secret 仅由服务器环境/部署 Secret 取得。没有任何 API 返回 Token 或引用。兑换码同样仅存 Secret 引用及指纹。缺失 Secret 验证失败，API 日志不输出请求体/SQL 参数/Token URL。

## 上线前仍需完成

本阶段不代表已上线或完成全部生产加固。需后续完成身份供应商、TLS/网关限流、Secret 管理轮换、数据库最小权限账号生产部署验证、备份恢复演练、监控告警、任务重试与对账、数据留存策略、真实 Bot 沙箱联调。现有实现不注册 Webhook、不接正式 Token、不发消息或运营积分。

参考协议：[Telegram Bot API](https://core.telegram.org/bots/api)、[PGlite 测试运行时](https://pglite.dev/docs/)。本机以 PGlite PostgreSQL 引擎执行相同 SQL，不以内存 Map 模拟数据库；真正多连接并发还需 PostgreSQL CI 验证。
