# Frontend API Contract

本文件按基线 `06bdc9a4cd37ae153e2b0b3800573fce1d91c2d1` 的真实路由整理。字段名来自当前代码；Frontend 不得自行补造业务字段。

## 1. 通用约定

### Admin

- 同源 `/v1`；浏览器使用 HttpOnly Session Cookie，`credentials: include`。
- 所有写请求发送 JSON、精确 Origin 和 `X-CSRF-Token`；登录使用 `X-CSRF-Protection: 1`。
- Scope 路径通常为 `/v1/brands/:brandId/bots/:botId/...`；Member 是 Brand scope：`/v1/brands/:brandId/members/...`。
- 错误 JSON：`{error, requestId}`。常见：`invalid_request` 400、`unauthorized`/`session_expired` 401、`forbidden`/`csrf_failed`/Origin 错误 403、`not_found` 404、冲突类 409、`login_rate_limited` 429、`internal_error` 500。
- UI 状态：首次 `loading`；空列表显示真实 empty；403 显示无权限；401 清空本地视图并重新登录；502/503/504 显示“服务正在连接”，不要自动重试登录 POST。

### Mini

- 基础路径 `/v1/mini`；业务 GET 使用内存 Bearer。Recovery Cookie 仅用于受保护 recovery。
- 所有 POST 为 JSON、精确 Telegram Mini origin；需要 recovery protection 的请求发送 `X-Mini-CSRF: 1`。
- Gateway 502/503/504 归类 `service_unavailable`；POST 不自动重试。
- 主要安全错误：`mini_unauthorized` 401、`mini_origin_not_allowed`/`mini_origin_required`/`mini_csrf_required` 403、`mini_json_required` 415、`mini_rate_limited` 429、`mini_init_data_used` 409。

## 2. Mini Auth / Recovery / Current User

| Method | Path | Request | Response key fields | Empty/loading/error |
|---|---|---|---|---|
| POST | `/v1/mini/auth/recover` | `{appKey, initData}` + recovery cookie + `X-Mini-CSRF` | Bearer session：`tokenType`, `token`, expiry/scope fields | 首选恢复；401 后才允许单次 exchange |
| POST | `/v1/mini/auth/exchange` | `{appKey, initData, recovery:true}` | Bearer session，并建立 recovery cookie | 单次提交；重放/来源/限流按安全错误展示 |
| GET | `/v1/mini/me` | Bearer | `userId`, `brandId`, `botId`, `expiresAt` | 401 清除内存 token，提示关闭重开 |
| POST | `/v1/mini/auth/logout` | `{}` + Bearer | revoke result；清 recovery cookie | 成功后旧 Bearer 必须 401 |

## 3. Mini 业务读取

| Method | Path | Scope/Auth | Response key fields | UI contract |
|---|---|---|---|---|
| GET | `/v1/mini/home` | 当前 Mini user | `member`, `profile`, `points`, `invitedCount`, `redemptionCount`, `activities` | 首页聚合；`activities.participationEnabled=false` 时不得显示可参与 |
| GET | `/v1/mini/member` | 当前 Mini user | `enabled`, `available`, `level`, `levelName`, `growth`, `progress`, `nextThreshold`, `protected`, `todayGrowth`, `dailyCap` | unavailable 显示“会员成长尚未启用”，不能假等级 |
| POST | `/v1/mini/member/checkin` | 当前 Mini user | Growth reconciliation result | 用户触发；不自动重试；幂等由后端保证 |
| GET | `/v1/mini/member/growth?after=` | 当前 Mini user | `{available, items:[id,delta,kind,business_date,created_at], next}` | 空历史显示 empty；游标分页 |
| GET | `/v1/mini/points` | 当前 Mini user | `accountExists`, `balance`, 可选 `expiringSoon` | 无账户和零余额要区分；Lot flag 关闭时可能无 expiringSoon |
| GET | `/v1/mini/point-ledger?cursor=&limit=` | 当前 Mini user | `{items:[id,created_at,delta,source,business_type], nextCursor}` | Points 记录分页 |
| GET | `/v1/mini/referrals?cursor=&limit=` | 当前 Mini user | `items`, `nextCursor` | 当前仅历史读取；不要伪造邀请入口 |
| GET | `/v1/mini/redemptions?cursor=&limit=` | 当前 Mini user | `items:[id,created_at,points_cost,status]`, `nextCursor` | 当前仅历史读取 |
| GET | `/v1/mini/activities` | 当前 Mini user | `{items:[], participationEnabled:false, catalogueStatus:'not_published'}` | 安全占位，不能显示已发布活动 |
| GET | `/v1/mini/platform-data-status` | 当前 Mini user | `items:[platformId,latestDate,status]` | 数据新鲜度提示 |
| GET | `/v1/mini/platforms` | 当前 Mini user | 平台配置及当前 `identity` | 无平台显示 empty |
| GET | `/v1/mini/platform-identities?cursor=` | 当前 Mini user | 脱敏历史、status、nextCursor | 不显示完整 UID |
| POST | `/v1/mini/platform-identities` | 当前 Mini user + recovery protection + Idempotency-Key | `{platformId, uid}` → 脱敏 identity | UID 属敏感输入；前端不得记录；409 显示状态变化 |

语言不是服务器写接口。当前选择保存在设备侧，复用 `web/src/mini/i18n.ts` 的 `zh-CN`、`en`、`pt-BR`、`es-MX`、`fil`，不要建立第二套翻译源。

## 4. Admin Session 和 Scope

| Method | Path | Request/Response |
|---|---|---|
| POST | `/v1/auth/login` | `{login,password}`；返回 `csrfToken`, `expiresAt` 并设置 HttpOnly Cookie |
| POST | `/v1/auth/logout` | CSRF；204 |
| GET | `/v1/me` | 管理员 profile、grants、csrfToken、expiresAt |
| GET | `/v1/me/permissions?brandId=&botId=` | 全局 grants 或 scope permissions |
| GET | `/v1/me/brands` | `{items}` 可访问品牌 |
| GET | `/v1/me/brands/:brandId/bots` | `{items}` 可访问 Bot |

## 5. Admin Dashboard / Analytics

| Method | Path | Permission | Response |
|---|---|---|---|
| GET | `/v1/brands/:brandId/bots/:botId/dashboard/summary?from=&to=&timezone=` | `dashboard.read` | `realtime`, `period`, referrals/redemptions/Points 等服务端聚合 |
| GET | `/v1/brands/:brandId/bots/:botId/dashboard/trends?from=&to=&timezone=&granularity=day` | `dashboard.read` | `items` 日趋势 |
| GET | `/v1/brands/:brandId/members/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD` | `growth.read` | `available`, `members`, `distribution`, `issued`, `net`, `earners`, `upgrades`, `timezone`, `aggregation` |

数据中心只展示服务端聚合。未知 metric 返回/映射为“待接入”，禁止在前端把多个列表页自行求和。当前 aggregation 类型为 `SUM`、`DISTINCT`、`SNAPSHOT`、`RATE`。

## 6. Admin Users / User 360 / Points

基础 scope：`/v1/brands/:brandId/bots/:botId`，主要读取：

- `GET /users`、`GET /users/count`：筛选、排序、游标分页。
- `GET /users/:userId`：Telegram user detail 与 resolved language。
- `GET /users/:userId/points`：`balance`，Lot 开启时还包含 point summary。
- `GET /users/:userId/points/summary`：账户摘要。
- `GET /users/:userId/point-ledger`：不可变流水分页。
- `GET /users/:userId/referrals`、`GET /referrals`：邀请关系。
- `GET /users/:userId/member`：Bot scope 只返回 `{available,level,growth}`，不泄露其他 Bot 来源。
- `GET /platform-identities?userId=`：脱敏平台身份。
- `POST /points/adjustments`：`{userId,delta,eventId,note}` + CSRF + Idempotency-Key；权限 `points.adjust`。

Empty：没有账户、流水或邀请要显示真实 empty。完整 Telegram/UID 技术字段只在权限允许的详情中出现，普通列表应脱敏。

## 7. Admin Member / Growth / Rules

基础路径 `/v1/brands/:brandId/members`：

- `GET /status` → `schemaReady`, `enabled`, `visibility`。
- `GET /?after=&limit=` → Member 列表 `id`, `level`, `growth`, `initialized_at`。
- `GET /:id` → Member、Growth Ledger、Level History、Daily Reconciliations。
- `GET /:id/level-history` → 历史分页。
- `GET /rules`、`GET /rule-options` → 规则版本及 Platform/Mapping 选项。
- `POST /rules/preview` → readonly preview、mappingApproval、examples，业务写入 0。
- `POST /rules` → Draft；`POST /rules/:id/publish` → Published immutable version。
- `POST /:id/adjustment-preview` → confirmation token；`POST /:id/adjustments` → 服务端 Growth 调整。大额调整必须确认。
- `GET /cutover-preview` → readonly；仅技术/审批流程使用。

关键错误：`member_growth_disabled`、`member_rule_not_available`、`member_rule_not_draft`、`member_rule_overlap`、`growth_confirmation_required`、`growth_idempotency_conflict`、`member_mapping_changed`。前端不得自行更正余额、Level 或 Daily Cap。

## 8. Platform / P4 Data

- Platform：`GET/POST /v1/brands/:brandId/bots/:botId/platforms`，`POST /platforms/:platformId/status`。
- Identity：列表、permission-protected detail、`POST /platform-identities/:identityId/review`。
- P4 数据基础路径 `/v1/brands/:brandId/bots/:botId/platform-data`：`GET /adapters`、`POST /preflight`、`POST /batches/:id/activate`、`GET /batches`、`GET /batches/:id`、`GET /batches/:id/evidence/:evidenceId`、`GET /facts`、`GET /facts/:id`。

前端只上传源文件/显式 mapping 配置并展示服务端 Preflight。不能自己转金额、推导 completeness 或创建 Fact。

## 9. P5-A Point Expiry

基础路径 `/v1/brands/:brandId/bots/:botId/point-expiry`：

- `GET /policies`、`POST /policies/preview`、`POST /policies`、`POST /policies/:versionId/publish`。
- `GET /lots`、`GET /lots/:lotId`、`GET /accounts/:userId`。

Empty：schema/feature 不可用时显示未启用。关键冲突：`point_expiry_policy_required`、`point_lot_cutover_required`、`point_reconciliation_mismatch`、`insufficient_available_points`。

## 10. P5-B Qualification

基础路径 `/v1/brands/:brandId/bots/:botId/entitlements`：

- 规则：`GET /platforms`、`GET /mapping-batches`、`GET /rules`、`POST /rules`、`POST /rules/preview`、`POST /rules/:id/publish|disable`。
- 资格：`GET /daily`、`GET /daily/:id`。
- 运维：`GET /sla`、`GET /tasks`、`POST /recalculate`、`POST /tasks/run`。

响应必须保留 status/reason/revision/evidence 的服务端含义。运营默认显示业务状态，技术 mapping/fingerprint 放高级诊断。关键错误：`entitlements_disabled`、`entitlement_metric_semantics_unapproved`、`entitlement_mapping_changed`、`entitlement_platform_mismatch`。

## 11. Audit

Admin User 360 使用现有 audit query/panel，只读展示 action、时间、对象和安全摘要。完整 UID、Secret、Cookie、Token、initData 不属于前端 contract。Audit 是服务端不可变事实，Frontend 不得生成或修改。

## 12. BACKEND_PENDING

以下没有可安全使用的正式 endpoint：

- Benefits catalogue、Member Benefits、Weekly Reward。
- Game Opportunities、次数账户、游戏执行和结果。
- Content Publishing Center 的 Draft/Publish/Schedule/Delivery API。
- Media upload/storage。
- Scheduler、Worker、delivery idempotency、delivery-unknown reconciliation。

Lovable 可以建立 typed interface 和 UI，但请求层必须明确 `BACKEND_PENDING`，不得调用猜测路径或伪造成功数据。

