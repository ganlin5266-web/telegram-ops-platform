# 第二阶段第 2 批：用户运营查询 API

唯一主仓库继续使用 `ganlin5266-web/telegram-ops-platform`。本批只增加服务端只读查询与索引，不开发 UI，不改变积分、邀请绑定、兑换、Telegram 或语言规则。

## 认证、权限及共同约定

所有路径的前缀为 `/v1/brands/{brandId}/bots/{botId}`，品牌、Bot、userId 均为 UUID。复用现有 HttpOnly Session、精确 Origin/CORS、RBAC；请求 `credentials: include`。本批 GET 不要求 CSRF 写请求 Header，但仍需要有效 Session。任何查询先鉴权；没有跨 Bot/跨品牌联表共享例外。

- 用户、详情、积分和邀请查询要求当前范围 `users.read`。
- 审计要求当前范围 **`audit.read`**。005 默认授予现有 Admin、Super Admin；仍按其 admin_roles 的品牌/Bot授权范围限制，Viewer 与 Operator 未获得此权限。其他角色可由既有受控服务端运维流程授权，不新增角色编辑接口。
- 所有积分字段和 Telegram User ID 是**十进制字符串**；total / invitedCount 也是字符串，避免 bigint/count 精度损失。UUID 是字符串，日期是 ISO 时间字符串，缺失姓名/语言等字段为 null。
- 所有日期筛选使用含时区的 ISO 8601，区间为 **[from, to)**。两端可单独提供，同时提供时必须 from < to。查询不会将日期默认为管理员时区。
- 文本条件最长 100 字符，分页 limit=1～100，默认 50。未知参数、任意 SQL 排序字段、无效枚举均拒绝。

| GET 路径（接上方前缀） | 权限 | 用途 |
|---|---|---|
| `/users` | users.read | 用户搜索、筛选、排序及游标分页 |
| `/users/count` | users.read | 同一范围、同一筛选下的精确用户总数 |
| `/users/{userId}` | users.read | 运营详情，不含认证或 Bot Secret |
| `/users/{userId}/points` | users.read | 保留第一批 `{balance}` 协议 |
| `/users/{userId}/points/summary` | users.read | 当前余额与累计正负流水汇总 |
| `/users/{userId}/point-ledger` | users.read | 用户积分流水 |
| `/users/{userId}/referrals` | users.read | 谁邀请了他，以及他邀请的用户列表 |
| `/referrals` | users.read | Bot 范围邀请关系 |
| `/audit-logs` | audit.read | 当前品牌/Bot 范围的安全操作日志 |

## 用户搜索、筛选、排序

| 参数 | 类型 / 语义 |
|---|---|
| q | 可选字符串。Telegram User ID 精确匹配；username、first_name、last_name 不区分大小写的**前缀匹配**，四个字段 OR。可带开头 @。`%`、`_`、反斜杠按普通字符处理，不允许注入通配符。不是任意子串或分词搜索 |
| status | active / blocked / disabled |
| language | 存储语言代码，不区分大小写的精确匹配 |
| languageField | telegram（默认，telegram_language_code）或 preferred（preferred_language）；不是最终发送语言筛选，不用 COALESCE 猜测语言 |
| startedFrom / startedTo | 首次 /start 时间范围，NULL 首次启动时间不会匹配日期范围 |
| interactionFrom / interactionTo | 最后互动时间范围 |
| sort | id（默认）/ first_started_at / last_interaction_at |
| order | asc（默认）/ desc |
| limit / after | 每页数量 / 服务端返回的不透明游标 |

请求示例：

```http
GET /v1/brands/{brandId}/bots/{botId}/users?q=jo&status=active&language=pt-BR&languageField=preferred&sort=last_interaction_at&order=desc&limit=50
```

响应保持旧字段和结构，无无必要的删除或重命名：

```json
{
  "items": [{
    "id":"00000000-0000-4000-8000-000000000001",
    "telegram_user_id":"9007199254740993",
    "username":"joao", "first_name":"João", "last_name":null,
    "telegram_language_code":"zh-CN", "preferred_language":"pt-BR",
    "first_started_at":"2025-01-01T12:00:00.000Z",
    "last_interaction_at":"2025-01-02T12:00:00.000Z", "status":"active"
  }],
  "nextCursor":"opaque-signed-cursor"
}
```

无下一页时 nextCursor=null。查询在数据库侧筛选、排序、LIMIT；只额外取 1 行判断下一页，不读取全部数据后做 Node 分页。

### 游标规则

- 使用 HMAC-SHA256 签名，绑定接口类型、brandId、botId、相关 userId、所有规范化筛选参数、排序方向。更改筛选或排序必须清空 after，从首批开始。
- 查询参数排列顺序不影响绑定；语义等价但原值不同（例如 q 的大小写）可能要求重开首批。limit 不参与绑定，可以调整每页大小。
- 时间排序以 id 为同方向第二排序键，NULL 固定排最后。游标时间来自 PostgreSQL 原始文本，保留微秒，不通过 JS Date 降精度。
- 默认 id ASC。时间分页使用键集比较，不用 OFFSET；相同时间戳及 NULL 场景已做全量分页验证。
- 游标有效期 1 小时。旧版本裸 UUID after、伪造签名、过期或条件不匹配均返回 **400 invalid_cursor**，前端清空游标重新查询。现有第一批 UI 将 nextCursor 当作不透明字符串，因此无需修改；跨版本部署前打开的旧分页需刷新。
- `QUERY_CURSOR_SECRET` 是**服务端专用**随机密钥，至少 32 字节；所有副本必须使用同一 Secret 引用/环境值，禁止放入 VITE_、Git 或响应。未配置时使用进程随机密钥，重启或请求不同随机密钥副本会安全拒绝旧游标。更换密钥使旧游标失效。
- 这是实时运营查询，**不是跨请求固定数据库快照**。稳定集合的遍历保证唯一排序、无重复/遗漏；用户互动更新时间、状态或新增记录会改变实时结果。前端切换条件或需要最新结果时重开首批，不能把多次分页包装为某一时刻的精确导出。需要固定快照导出时后续单独设计。

### total

```http
GET /v1/brands/{brandId}/bots/{botId}/users/count?q=jo&status=active&language=pt-BR&languageField=preferred
```

```json
{"total":"123"}
```

只接受用户筛选参数，不接受 limit/after/sort/order。与 `/users` 共用同一 SQL 条件生成逻辑，使用数据库 COUNT(*)，是调用时当前事务快照的精确总数，**不是当前页条数、不是估算值**。翻页本身不执行 COUNT。Lovable 应仅在首次进入/筛选变化/主动刷新时单独请求，避免每页重复统计。列表与独立 count 在并发写入期间可能短暂不同。

## 用户详情与语言

`GET .../users/{userId}` 返回现有用户列表字段，并增加 `created_at`、`updated_at`、`resolved_language`、`language_note`。

```json
{"id":"00000000-0000-4000-8000-000000000001","telegram_user_id":"9007199254740993","username":"joao","first_name":"João","last_name":null,"telegram_language_code":"zh-CN","preferred_language":null,"first_started_at":"2025-01-01T12:00:00.000Z","last_interaction_at":"2025-01-02T12:00:00.000Z","status":"active","created_at":"2025-01-01T12:00:00.000Z","updated_at":"2025-01-02T12:00:00.000Z","resolved_language":"pt-BR","language_note":"Resolved preference; individual templates may use their documented fallback."}
```

resolved_language 直接调用现有 resolveLanguage：用户偏好 → 支持的 Telegram 语言 → Bot 默认 → Brand 默认。管理员中文不参与。某个具体模板还可能按原模板规则回退，详情字段不能替代模板实际发送预览。积分/邀请摘要通过下面独立接口读取，避免每次列表扫描汇总所有用户。

## 积分汇总与 Ledger

```http
GET .../users/{userId}/points/summary
```

```json
{"balance":"108","totalEarned":"120","totalSpent":"12"}
```

- balance：当前 point_accounts.balance，无账户为字符串 "0"。
- totalEarned：该用户全部正 delta 的 SUM；**包含退款、人工增加、邀请或活动奖励等所有正流水**。
- totalSpent：全部负 delta 的绝对值 SUM；包含人工扣除等所有负流水。
- 不回溯扣减退款对应的历史消耗，不把这些指标称为“净充值”“兑换消耗”或“实际收益”；只是账本按符号汇总。余额和汇总在同一 SQL 语句快照读取。

```http
GET .../users/{userId}/point-ledger?direction=credit&source=admin&businessType=manual_adjustment&from=2025-01-01T00:00:00Z&to=2026-01-01T00:00:00Z&limit=50
```

所有筛选可选：direction=credit/debit；source、businessType 为现有原始值精确匹配；from/to 为创建时间区间。固定 created_at DESC、id DESC。

```json
{"items":[{"id":"00000000-0000-4000-8000-000000000002","delta":"20","balance_before":"88","balance_after":"108","direction":"credit","source":"admin","business_type":"manual_adjustment","business_id":"00000000-0000-4000-8000-000000000003","note":"原因：人工补偿","created_at":"2025-01-02T12:00:00.000Z"}],"nextCursor":null}
```

Ledger 不返回幂等 Key，也不提供任何编辑、删除或修正余额 API。

## Referral

```http
GET .../referrals?status=bound&rewardStatus=pending&inviter=jo&invitee=10000001&from=2025-01-01T00:00:00Z&limit=50
GET .../users/{userId}/referrals?status=bound&limit=50
```

status=bound/qualified/invalid，rewardStatus=pending/rewarded/ineligible。inviter/invitee 使用与用户搜索相同的 ID 精确/名称前缀语义；日期针对 bound_at。固定 bound_at DESC、id DESC。

Bot 响应：

```json
{"items":[{"id":"00000000-0000-4000-8000-000000000004","boundAt":"2025-01-01T12:00:00.000Z","status":"bound","rewardStatus":"pending","inviter":{"id":"00000000-0000-4000-8000-000000000001","telegramUserId":"10000001","username":"joao","firstName":"João","lastName":null},"invitee":{"id":"00000000-0000-4000-8000-000000000005","telegramUserId":"10000002","username":null,"firstName":"Maria","lastName":null}}],"nextCursor":null}
```

用户响应包含相同 items/nextCursor（**他邀请的人**），另外返回：

```json
{"invitedBy":{"id":"00000000-0000-4000-8000-000000000004","boundAt":"2025-01-01T12:00:00.000Z","status":"bound","rewardStatus":"pending","inviter":{"id":"00000000-0000-4000-8000-000000000001","telegramUserId":"10000001","username":"joao","firstName":"João","lastName":null}},"invitedCount":"12","items":[],"nextCursor":null}
```

无邀请人时 invitedBy=null。invitedCount 为该用户全部首次绑定的邀请关系数量，包含各事实状态，**不受 outgoing 列表筛选影响**。列表条件只作用于 outgoing items；不改变 incoming invitedBy。

**系统尚无正式“有效邀请”资格判定规则，不能把 qualified 数量自行包装为正式有效邀请指标。** API 仅透传现有事实状态与奖励状态，不执行奖励、不提供修改/重绑邀请人接口。不返回原始 start_parameter。

## Audit

```http
GET .../audit-logs?adminId={adminId}&action=points.adjust&objectType=point_ledger&objectId={ledgerId}&from=2025-01-01T00:00:00Z&limit=50
```

adminId、action、objectType、objectId、from/to 均可选，品牌/Bot由路径精确约束。固定 created_at DESC、id DESC。

```json
{"items":[{"id":"00000000-0000-4000-8000-000000000006","created_at":"2025-01-01T12:00:00.000Z","admin_id":"00000000-0000-4000-8000-000000000007","admin_name":"运营管理员","action":"points.adjust","object_type":"point_ledger","object_id":"00000000-0000-4000-8000-000000000002","result":"committed","summary":"积分调整事务已提交"}],"nextCursor":null}
```

采用 SQL **白名单投影**，不是先返回完整日志再在浏览器遮挡：不查询/返回 before_data、after_data、原始 note、IP、request_id，也不暴露认证对象标识。当前已公开动作/对象为 points.adjust / point_ledger，其他未批准类型呈现 other；其他对象ID为 null，结果为 recorded，仅表示有事实记录，不伪造业务成功。points.adjust 的 committed 依赖其与积分同事务提交的现有规则。

auth.* 日志目前无品牌/Bot归属，本接口不返回这些全局安全事件；全局安全审计页面与专门权限/API留后续，不根据管理员当前选择的 Bot 将无归属日志错误分配给它。没有日志修改/删除 API。

## 错误与性能

统一错误响应仍为 `{error,requestId}`：

| HTTP | error | 行为 |
|---|---|---|
| 400 | invalid_request | 修正字段、枚举、limit 或日期格式 |
| 400 | invalid_date_range | 修正日期起止顺序 |
| 400 | invalid_cursor | 清空游标，从首批开始；不能重放错误 after |
| 401 | unauthorized / session_expired | 按第一批协议清空身份与数据，重新登录 |
| 403 | forbidden | 无当前范围的 users.read / audit.read，不能换成无 scope 查询 |
| 404 | not_found | Bot/用户不存在或不在有效范围 |
| 500 | internal_error | 安全通用错误，不返回 SQL/堆栈；包括数据库查询超时，先缩小条件再重试 |

新增查询设置事务内 5 秒 statement_timeout；极宽条件的精确 count 仍可能有成本，超时安全报错，不返回假的 total。所有输入参数绑定，ORDER BY 只来自服务端枚举。积分统计只聚合指定用户账本。邀请查询先分页再读取参与用户安全投影，避免大量关联排序。

005 共新增 17 个索引：用户首次时间正/反向、互动时间、状态、两类语言、三类文本前缀；用户账本时间；邀请范围/邀请人/状态时间；审计范围/管理员/动作/对象时间。Telegram ID 精确搜索继续使用原有 `(bot_id,telegram_user_id)` 唯一索引，邀请 incoming 继续使用 `(bot_id,invitee_id)` 唯一索引。没有引入 pg_trgm 扩展或第二套搜索库。

数据库批量导入后应更新统计信息（ANALYZE）；新索引按现有事务 Migration 执行，大表上线需按运维流程安排维护窗口。本批未执行生产 Migration。

规模验收固定生成 2 Brand、3 Bot、6000 用户、7003 Ledger、5997 Referral、6000 scoped Audit（另有认证测试产生的无范围日志）；其中单用户 1001 流水。测试遍历 5000 用户、4999 邀请、5000 日志及 1001 用户流水，验证无重复/遗漏，并打印 EXPLAIN ANALYZE/BUFFERS 和端到端分页耗时。该规模结果不是百万级生产 SLA；真实 PostgreSQL 17 的数字以当前提交 CI 日志为准。
