# Lovable 下一阶段接入说明

项目指定唯一主仓库为 ganlin5266-web/telegram-ops-platform；本轮将第一阶段底座和 PostgreSQL 17 验收提交到该仓库。不要另建独立积分数据库。CI 实际结果以 GitHub Actions 对应 commit 的运行记录为准。

## 已实现接口

第二阶段第 1 批：正式服务器的所有管理 API 使用服务端 Session Cookie。旧的固定 Bearer 认证不再由 `server.ts` 启用；没有初始化管理员时，无法登录。品牌/Bot UUID 是路径参数；无权限 403、不存在 404、重复 Key 内容冲突 409、参数无效 400。错误响应 `{error,requestId}`。积分和 Telegram ID 均以字符串返回。

| 方法 | 路径 | 权限及行为 |
|---|---|---|
| GET | /health | 存活检查 |
| GET | /ready | 数据库连接检查 |
| POST | /webhooks/telegram/{botId} | Telegram Secret Header；不可由后台代替身份鉴权 |
| GET | /v1/brands/{brandId}/bots/{botId}/users?limit=50&after=UUID | users.read；最多 100 条，按 UUID 游标分页 |
| GET | /v1/brands/{brandId}/bots/{botId}/users/{userId}/points | users.read；当前余额，无账户返回 0 |
| POST | /v1/brands/{brandId}/bots/{botId}/points/adjustments | points.adjust；事务流水 + Audit |
| GET | /v1/brands/{brandId}/bots/{botId}/users/{userId}/templates/{key} | users.read；按用户语言解析模板（预览，不发送） |

人工调整请求 Header 需 `Idempotency-Key`（8–160 字符）。Body：

```json
{"userId":"USER_UUID","delta":"100","eventId":"CLIENT_GENERATED_UUID","note":"人工调整原因"}
```

返回 `{ledgerId,balance}`；每次新操作生成 eventId 和请求 Key，网络重试保持两者不变。不允许前端 UPDATE point_accounts。前端显示成功前等待 API 响应，遇到超时使用同 Key 重试。

## 待实现接口契约（现在不可调用）

- BotSettingsService：品牌/Bot 范围鉴权，配置语言/菜单/模板，Secret 只由服务端按引用读取，写 Audit。
- ActivityService：验证活动规则与时间，草稿/启用/暂停状态机，写 Audit。
- RedemptionService：外部请求身份与规则校验后，调用事务原语 reserveRedemption / assignCode / failRedemption；补齐日限额、人工审核、库存保密和对账。
- MessagePublishingService：保存管理员要求和生成结果，目标语言验证、预览、人工确认、修改后撤销确认、服务端调度、发送日志。
- AIContentProvider：输入 `{adminRequest,targetLanguage,brandId,botId}`，输出 `{generatedContent,targetLanguage}`；不能将 adminRequest 原样充当最终正文。

当前没有这些 CRUD/发布接口；Lovable 不可绕过边界直写底层表。新增 API 必须继续实现服务端权限、scope、参数校验和 Audit，补充测试与接口文档。

## 前端开工顺序

1. 先按下面的 Session 登录与作用域发现流程接入；部署同源反代或配置精确来源 CORS。OIDC 联邦登录留作后续可选接入，不能在前端硬编码管理凭证。
2. 先使用用户列表、余额、模板预览 API 建立只读后台。
3. 管理积分 UI 接入调整 API，设置业务事件 UUID、重试 Key、理由、确认预览。
4. 后端补充 Bot/模板/菜单/活动接口后再制作配置页面；发送和兑换需单独验收。

管理员中文 UI 不决定用户消息语言。运营页必须展示目标 Bot、目标语言、真正将发送的内容；菜单/模板显示语言明确，绝不能用后台 i18n 的文案当 Bot 文案。

## 不可绕过的服务端边界

唯一主代码仓库：[ganlin5266-web/telegram-ops-platform](https://github.com/ganlin5266-web/telegram-ops-platform)。Codex 与 Lovable 在这个仓库协作，不创建另一套后端或数据库。已有 GET 管理接口都是只读；当前唯一后台业务写接口是人工积分调整。Webhook 是 Telegram 接入端，不能作为管理员业务写接口使用。

**Lovable 浏览器不得直接写任何业务表**，包括使用 Supabase SDK、SQL/RPC、service-role key 绕过本后端。当前没有前端可直接调用的数据库 RPC。未来如新增 RPC，必须单独验收鉴权和事务边界。

| 模块 | 必须由服务端执行的边界 |
|---|---|
| Auth / RBAC | 验证个人身份、账号状态、权限及 brand/bot scope；角色来自数据库，不能信任浏览器传来的角色。现已使用本地密码认证和安全 Session；以后可接入 OIDC 身份验证，继续使用同一管理员与 RBAC |
| Bot 配置 | 通过授权配置服务维护品牌、Bot、语言；**Lovable 不能读取 Bot Token 或 Webhook Secret**，也不能访问服务端环境变量 |
| 用户管理 | 当前仅列表及余额读取；Telegram ID 是身份，username 可变；不可改用户 Bot/品牌归属绕过隔离 |
| Point Account / Ledger | **Lovable 不能直接 UPDATE point_accounts.balance**；任何增减必须调用服务端积分 Service/API、经过幂等校验并产生 Ledger。不得 INSERT/UPDATE/DELETE 流水伪造余额 |
| Referral | 仅服务端首次绑定；不得重绑邀请人、自邀或跨 Bot 绑定；奖励必须调用统一积分服务 |
| Redemption | **Lovable 不能直接把兑换状态改成 Success**；预留的订单/扣分/库存/退款必须由事务服务协调。无完整兑换 API，不能通过直接写表补功能 |
| Activity | 当前仅模型，规则启用、条件判定、奖励发放均留在服务端；前端不能直接发奖 |
| Message Template | 当前提供只读解析预览；后续写接口校验范围、语言、模板版本并记 Audit，不能从后台中文 i18n 自动生成发送模板 |
| Bot Menu | 当前仅结构；未来授权服务校验 callback/URL、语言、排序与启用状态，并写 Audit |
| Scheduled Message | 当前仅结构；预览、目标语言、人工确认、修改后重新确认、计划执行都由服务端状态机和 worker 控制；不能依赖浏览器定时器发送 |
| Audit Log | 由服务端伴随敏感操作同事务写入；前端不能伪造管理员/前后值，不得修改或删除日志 |

隔离规则没有跨 Bot 共享特例：同一个 Telegram User ID 在 A1、A2、B1 中是不同运营档案、钱包及邀请关系。即使同品牌也不能共享积分账户。未来如需要汇总或共享，必须另行确认架构，不得让 UI 自行联表写入实现。

## 第二阶段第 1 批：浏览器认证与范围发现（已实现）

不需要 Mock 管理员、品牌或 Bot。数据来自真实 admins/admin_roles/brands/telegram_bots。新数据库没有品牌/Bot 时返回空列表；不得把空列表替换成虚构运营数据。本轮没有新增品牌/Bot 创建 API。

| 方法 | API | 成功返回 |
|---|---|---|
| POST | `/v1/auth/login` | `{csrfToken,expiresAt}`；Session 仅通过 HttpOnly Set-Cookie 下发 |
| POST | `/v1/auth/logout` | 204；服务器撤销 Session，同时清除 Cookie |
| GET | `/v1/me` | `id,displayName,status,uiLanguage,grants,csrfToken,expiresAt` |
| GET | `/v1/me/permissions` | `{grants:[{brandId,botId,role,permissions}]}` |
| GET | `/v1/me/permissions?brandId=UUID&botId=UUID` | 当前范围实际生效的 `{brandId,botId,permissions}`；两个参数必须同时提供 |
| GET | `/v1/me/brands` | `{items:[{brandId,name,status,defaultLanguage}]}` |
| GET | `/v1/me/brands/{brandId}/bots` | `{items:[{botId,brandId,name,username,status,defaultLanguage}]}` |

权限必须读取 `permissions` 数组，不根据角色名字推断。未指定范围的 grants 不能简单合并为全局权限。空 brandId 的有效授权仅来自现有全局 Super Admin；brand 范围角色覆盖该品牌的 Bot；bot 范围角色只覆盖指定 Bot。列表可展示授权范围内的 disabled 品牌/Bot，保留其状态，便于后台读取已有数据，不意味着允许 Telegram 执行。

品牌、Bot 切换是前端选择下一次请求的路径范围，不修改 Session，不新增服务端“当前 Bot”全局变量。因此多个浏览器标签页可以选择不同 Bot；每次 API 仍独立验证范围。切换时清理旧范围的缓存及表单。

### 浏览器请求顺序

1. 页面加载调用 `/v1/me`，所有请求使用 `credentials: 'include'`。401 时进入登录页。
2. 登录使用 JSON `{login,password}`，携带 `X-CSRF-Protection: 1`；浏览器自动发送 Origin。登录名会去空格并转小写。不要保存密码。
3. 登录响应的 `csrfToken` 只保存在内存；重新加载可通过 `/v1/me` 重新获取。不要尝试读取 HttpOnly Cookie。
4. 获取 `/v1/me/brands`，选择品牌后获取 bots，再查询该范围的实际权限。
5. 使用原有 users 与 points GET 接口显示真实数据。用户列表仍只有 `limit/after`，没有新增搜索、排序或导出。
6. 退出请求使用 POST，携带 `X-CSRF-Token`。所有已登录写请求（包括既有积分调整接口）均要求这一 Header，以及可信 Origin。

```javascript
// apiBase 来自非敏感的部署配置，不含任何凭证。
const response = await fetch(`${apiBase}/v1/auth/login`, {
  method: 'POST',
  credentials: 'include',
  headers: {'Content-Type': 'application/json', 'X-CSRF-Protection': '1'},
  body: JSON.stringify({login, password})
});
// 先处理非 2xx，再从 JSON 取得 csrfToken；本示例没有硬编码账号或密码。
```

### Cookie / CORS / CSRF

- 服务器生成 256 位随机 Session Token；数据库只存 SHA256 摘要，管理员密码存带随机盐的 scrypt 哈希（N=32768,r=8,p=3）。
- Session 默认 8 小时绝对有效期，不自动续期；可通过 `ADMIN_SESSION_SECONDS` 设置 60–86400 秒。
- 生产 `NODE_ENV=production` 强制 Secure，Cookie 名 `__Host-telegram_ops_session`，HttpOnly、Path=/、不设置 Domain。普通本地 HTTP 开发使用 `telegram_ops_session`。
- 默认 SameSite=Lax。前后端同站点的不同子域仍需精确 CORS；真正跨站点使用 `ADMIN_COOKIE_SAME_SITE=None` 和 Secure/HTTPS。
- 第三方 Cookie 可能被浏览器阻止；优先同源反代或同站点域名。不能为了跨站点可用性关闭 CSRF 或把 Session Token 改放 localStorage。
- `ADMIN_ALLOWED_ORIGINS` 是逗号分隔的精确 Origin（协议、域名、端口），无通配符、无路径。生产只接受 HTTPS Origin。即使同源，也应把后台页面 Origin 加入列表。
- 已允许 Origin 得到对应的 Allow-Origin 与 Allow-Credentials:true；未知 Origin 返回 403，无凭证 CORS 放行头。
- 写请求必须有可信 Origin。登录额外要求 JSON 与自定义 Header，阻止跨站表单登录；已登录写请求另要求绑定当前 Session 的 CSRF Token。
- Cookie 被服务器轮换、退出撤销、过期或管理员被禁用后不能继续使用。权限更改在后续请求实时查询，不能把 `/me` 的权限缓存当成授权依据。
- `/v1/` 响应禁止缓存。不得把 Cookie、CSRF Header 或密码写到前端监控、分析埋点和日志。

### 错误处理

| HTTP / error | Lovable 行为 |
|---|---|
| 401 `invalid_credentials` | 显示统一“登录信息错误或账号不可用”，不区分账号是否存在 |
| 401 `unauthorized` / `session_expired` | 清除前端身份、权限、CSRF 和租户数据缓存，转登录；不能自动重放上次写操作 |
| 403 `forbidden` | 无权访问所选范围/操作；刷新权限与范围选择，不退化成其他 Bot 数据 |
| 403 `origin_not_allowed` / `origin_required` / `cors_denied` | 部署 Origin/CORS 配置问题，不应让用户反复重试 |
| 403 `csrf_failed` | 重新获取 `/me`；确认身份后由用户重新操作，不盲目重发敏感请求 |
| 400 `invalid_request` | 修正参数 |
| 429 `login_rate_limited` | 登录限流，按 Retry-After 提示等待 |
| 404 `not_found` | 对象不在有效范围或不存在；不要尝试移除 scope 再查 |
| 500 `internal_error` | 展示 requestId 供管理员排查，禁止展示内部 SQL/Secret |

登录基础限流使用 PostgreSQL 持久化计数，15 分钟窗口：每个规范化登录名最多 10 次、每个来源 IP 最多 50 次（含成功尝试），跨进程共享；不存在的登录名也同样计数。服务器默认不信任 X-Forwarded-For，不能用伪造 Header 绕过。反向代理部署应在可信网络层限流，并按部署拓扑由后端负责人配置可信代理；不要直接开启 trustProxy:true。当前未添加代理信任配置。

### 审计和边界

新增事件：登录成功/失败/限流、退出、Session 轮换/撤销/过期、权限拒绝、首次初始化。过期在 Session 再次被使用时惰性记录；已过期 Session 即使没有访问也不能认证。日志不包含密码、哈希、Session Token、CSRF Token或 Bot Secret。

后端复用原 RBAC，未改变 points/referral/redemption/telegram/language 业务服务。管理员 `uiLanguage=zh-CN` 只影响后台，模板解析继续由服务端执行。OIDC 协议回调、MFA、密码找回、管理员 CRUD、Session 管理页面尚未实现，不要自行在 UI 拼出这些流程。

首次管理员创建见 [admin-auth-operations.md](admin-auth-operations.md)。本轮未创建真实管理员或密码，正式联调前由负责人完成初始化、准备已有真实授权数据和测试环境配置。

## 第二阶段第 1 批 UI 实现位置

中文后台位于同仓库 `web/`。只开放总览与 Telegram 用户，并在用户详情提供余额读取及实际 `points.adjust` 授权下的调整入口。详情见 [前端接入与运行](../web/README.md)。所有业务数据使用上文已有 API，不添加直连数据库或前端积分事务。

当前实现不持久化品牌/Bot ID、不保存身份令牌或 CSRF 到 Storage。登录恢复时重新读取 `/me`、授权及品牌；切换时失效旧请求、清空列表及详情。分页使用 `limit=50/after` 和本地游标历史，不展示虚构总条数。后台 UI 固定中文，不写任何用户、Bot 或模板语言。

今后扩展应先补相应服务端 API，再增加前端路由；不要解禁核心表直写。前端测试 fixtures 和 `web/e2e/server.ts` 仅用于隔离验收，不得导入生产入口或用于正式账号初始化。

## 第二阶段第 2 批后端：用户运营查询

已新增数据库侧用户搜索/筛选/排序、独立精确 count、用户详情、积分汇总/流水、邀请关系和范围审计查询。**完整接入契约、请求与响应示例、字段类型、错误码、权限、游标规则及指标口径见 [用户运营查询 API](operations-query-api.md)**，后续 Lovable 第 2 批 UI 必须按此文档接入；本轮没有开发该 UI。

- 现有 `/users` 的 items 字段和 nextCursor 结构保持兼容；默认 id ASC，仍用 limit/after。新增游标为签名不透明字符串，筛选或排序变化必须重开首批；旧 UUID cursor 返回 400，清空重试。
- `/users/count` 单独请求，不应每翻一页重新 COUNT。q 是 ID 精确/名称前缀搜索，language 必须明确 telegram/preferred 来源，不能当成最终发送语言筛选。
- 用户详情、`points/summary`、`point-ledger`、用户/范围 `referrals` 使用当前范围 users.read；`audit-logs` 使用新 audit.read，Viewer/Operator 没有默认审计权限。
- 所有积分、Telegram ID、total、invitedCount 都为字符串。累计获得含退款等所有正流水，累计消耗为全部负流水绝对值；不自行重新解释历史业务。
- **有效邀请暂不能作为正式指标**。status/rewardStatus 仅为现有事实；不得新增重绑入口。
- Audit 不返回原始 before/after、note、IP 或认证标识；没有范围的 auth.* 安全日志不混入某个 Bot。
- `QUERY_CURSOR_SECRET` 只在服务端配置，不得使用 VITE_ 前缀，不得进入前端或 Git。新增 005 Migration 只增加只读权限和查询索引，001–004 原样保留。

## 第二阶段第 2 批 UI：用户运营中心已接入

同仓库 `web/` 已按上述查询契约接入用户搜索/筛选/排序/count/游标分页，以及详情概览、积分汇总与流水、邀请关系、Bot 邀请列表和权限审计。手机使用筛选面板与全屏详情。运行、查询语义和测试说明见 [前端说明](../web/README.md)。

本批只修改前端与交付文档，后端核心及 migrations 001–005 保持原样。积分调整继续使用既有服务端接口、CSRF、固定幂等标识和确认流程；成功后重读余额、汇总及流水。没有添加直接数据库写入、Referral 重绑或兑换动作。

详情“操作记录”仅在 audit.read 时可见，其内容明确标注当前 Bot 范围；服务端尚无用户级审计过滤，不做前端全量过滤或伪造用户归属。全局 auth.* 安全日志、有效邀请指标和 CSV 导出仍无本批接入接口。列表/count/汇总是独立实时请求，不构成跨请求数据库快照，并发业务变化时数值可能短暂不同。

所有 Telegram 语言解析继续由后端决定，中文后台只展示偏好、Telegram 语言及后端解析结果，不更新语言回退规则。生产入口没有 Mock，测试 fixtures 仅在组件测试和隔离端到端测试服务中使用。下一批必须先明确对应 API 和权限边界，再扩展新模块。
