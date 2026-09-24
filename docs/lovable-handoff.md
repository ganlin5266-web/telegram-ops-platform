# Lovable 下一阶段接入说明

项目指定唯一主仓库为 ganlin5266-web/telegram-ops-platform；本轮将第一阶段底座和 PostgreSQL 17 验收提交到该仓库。不要另建独立积分数据库。CI 实际结果以 GitHub Actions 对应 commit 的运行记录为准。

## 已实现接口

所有管理 API 使用 `Authorization: Bearer <个人凭证>`，默认未配置账号，全部拒绝访问。品牌/Bot UUID 是路径参数；无权限 403、不存在 404、重复 Key 内容冲突 409、参数无效 400。错误响应 `{error,requestId}`。积分和 Telegram ID 均以字符串返回。

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

1. 后端接 OIDC 登录，提供安全会话（不要把初期服务集成凭证硬编码进前端）；部署同源反代或配置精确来源 CORS。
2. 先使用用户列表、余额、模板预览 API 建立只读后台。
3. 管理积分 UI 接入调整 API，设置业务事件 UUID、重试 Key、理由、确认预览。
4. 后端补充 Bot/模板/菜单/活动接口后再制作配置页面；发送和兑换需单独验收。

管理员中文 UI 不决定用户消息语言。运营页必须展示目标 Bot、目标语言、真正将发送的内容；菜单/模板显示语言明确，绝不能用后台 i18n 的文案当 Bot 文案。

## 不可绕过的服务端边界

唯一主代码仓库：[ganlin5266-web/telegram-ops-platform](https://github.com/ganlin5266-web/telegram-ops-platform)。Codex 与 Lovable 在这个仓库协作，不创建另一套后端或数据库。已有 GET 管理接口都是只读；当前唯一后台业务写接口是人工积分调整。Webhook 是 Telegram 接入端，不能作为管理员业务写接口使用。

**Lovable 浏览器不得直接写任何业务表**，包括使用 Supabase SDK、SQL/RPC、service-role key 绕过本后端。当前没有前端可直接调用的数据库 RPC。未来如新增 RPC，必须单独验收鉴权和事务边界。

| 模块 | 必须由服务端执行的边界 |
|---|---|
| Auth / RBAC | 验证个人身份、账号状态、权限及 brand/bot scope；角色来自数据库，不能信任浏览器传来的角色。初期 Bearer 摘要映射仅限受控集成；浏览器正式接入前完成 OIDC/会话 |
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
