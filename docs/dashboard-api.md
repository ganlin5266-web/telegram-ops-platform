# Dashboard 运营统计 API（第 3 批后端）

本批只提供统计查询，不提供 UI、时区管理页面、导出或新业务执行流程。

## 接口与认证

- `GET /v1/brands/{brandId}/bots/{botId}/dashboard/summary?from=2025-01-01T00:00:00Z&to=2025-02-01T00:00:00Z`
- `GET /v1/brands/{brandId}/bots/{botId}/dashboard/trends?from=2025-01-01T00:00:00Z&to=2025-02-01T00:00:00Z&granularity=day`

复用现有 Session/Cookie、CORS、RBAC。要求 `dashboard.read`；006 为 Super Admin、Admin、Operator、Viewer 默认授予此只读权限。仍按 admin_roles 的 Brand/Bot 范围校验，不凭角色名称授权，不提供跨 Bot 汇总。未知参数拒绝，不支持浏览器指定时区覆盖。

## 时间和一致性

`from`、`to` 必填，严格 ISO 时间戳，带 Z 或明确 offset，采用 `[from,to)`；起点必须早于终点。每日按 **Bot.timezone 非空优先，否则继承 Brand.timezone** 分组。006 新字段默认 NULL，不静默设置 UTC。两者未设置时返回 409 `dashboard_timezone_not_configured`。配置接受 PostgreSQL 支持的 IANA 名称（如 America/Sao_Paulo、America/New_York、Asia/Manila）或明确 UTC，数据库触发器拒绝无效名称；配置修改仅由可信服务端运维执行，本批无新写接口。既有账户在明确配置前 Dashboard 不可用，原有 API 不受影响。

业务负责人明确选择时区后，运维以参数化 SQL 设置 brands.timezone；Bot.timezone 保持 NULL 即继承，确需不同日界线时再覆盖。不要把管理员 UI 语言或浏览器默认时区当作业务配置。前端日期选择器需按响应业务时区计算日边界，DST 日可能为 23/25 小时；趋势首尾可为不完整日。

最多 **90 个被区间触及的业务日历日期**，并设 90×24小时+1小时的绝对区间上限；超限 400 `dashboard_range_too_large`，倒序/空区间 400 `invalid_date_range`，格式或粒度错误 400 `invalid_request`。测试覆盖 1/7/30/90 天及纽约 DST 春秋边界。该上限在隔离 10,000 用户级数据集验证，不是生产 SLA；生产规模增长需复测，不能据此允许无限范围。

每次响应在单连接 `REPEATABLE READ READ ONLY` 事务内完成鉴权、时区和全部聚合，数据库 statement_timeout=5s。无业务行锁、无缓存，不并发占用多条池连接。`snapshotAt` 是事务开始时间标记，不是可重放的历史快照 ID；summary 与 trends 两次请求不保证同一快照。查询超时使用现有安全 internal_error 响应，不暴露 SQL。实时指标是查询时存量，不能当作历史余额或历史用户数。

## Summary 契约

公共字段：`scope:{brandId,botId}`, `timezone`, `timezoneSource:brand|bot`, `from`, `to`, `interval:"[from,to)"`, `snapshotAt`, `maxDays:90`。

所有计数是非负安全整数 number；超出安全范围明确报错，不舍入。所有积分是十进制 string，SQL numeric 求和防止 bigint SUM 溢出及负数取绝对值溢出。

| 字段 | 定义 / 数据来源 / 时间字段 | 日期筛选 |
|---|---|---|
| realtime.totalUsers | 当前 Bot 的 telegram_users 档案 COUNT；跨 Bot 相同 Telegram ID 不合并 | 否 |
| realtime.pointsBalance | 当前 Bot 的 point_accounts.balance SUM | 否 |
| period.newUsers | first_started_at 在区间的档案数；首次正确 /start，非 created_at 注册时间 | 是 |
| period.pointsEarned | point_ledger.created_at 在区间、delta>0 的 SUM；包括退款 | 是 |
| period.pointsSpent | 相同区间 delta<0 的绝对值 SUM | 是 |
| period.manualAdjustments.creditCount / creditPoints | source=admin 且 business_type=manual_adjustment 且 delta>0 的次数/积分 | 是，Ledger.created_at |
| period.manualAdjustments.debitCount / debitPoints | 同条件 delta<0 的次数/绝对值积分 | 是，Ledger.created_at |
| period.referrals.newRelations | referrals.bound_at 在区间的记录数 | 是 |
| period.referrals.uniqueInviters | 上述记录 DISTINCT inviter_id | 是 |
| period.referrals.rewardStatus.pending/rewarded/ineligible | 区间新增绑定记录的当前 reward_status 分布 | 是，bound_at |
| period.redemptions.created | redemptions.created_at 在区间的订单数 | 是 |
| period.redemptions.currentStatusOfCreatedOrders | 上述创建队列的**当前** pending/processing/success/failed/cancelled 状态分布 | 是，created_at |
| period.refunds.orders / points | 区间内正 Ledger，source=redemption 且 business_type=redemption_refund，business_id 与相同 Brand/Bot/user 的 redemptions.id 关联；COUNT DISTINCT 订单和 SUM delta | 是，Ledger.created_at |

退款与订单创建队列不是同一口径：早期创建订单在本期退款仍纳入退款指标；不要求订单当前仍是 failed。不用 note、updated_at 猜测退款或业务来源。退款已包含于 pointsEarned，勿再次加到总收入。

兑换 schema 接受 pending/processing/success/failed/cancelled，但当前服务仅实现 reserve→pending、assignCode→processing、fail→failed+退款。success/cancelled 可作为现存记录状态统计，**不能称为期间成功交付/取消事件数量**；没有完整交付流程及状态事件时间历史，不提供交付成功率、delivered/approved/refunded 状态或状态变化趋势。

本批不提供按未知 source 的业务猜测分类，仅提供真实人工调整和关联退款分类。无需下载 Ledger 明细自行汇总。

## Trends 契约

公共字段同 summary，另有 `granularity:"day"`，`items` 按 date 升序：

```json
{"date":"2025-01-01","newUsers":0,"pointsEarned":"0","pointsSpent":"0","newReferrals":0,"redemptions":0}
```

字段口径对应 summary。日期是业务时区 YYYY-MM-DD；数据库 GROUP BY 聚合、generate_series 补齐空日期，只返回最多 90 个汇总行，无用户/Ledger 明细。

## 不支持指标与空数据

两个接口统一返回 `unsupported`：

```json
{
  "activeUsers":{"supported":false,"value":null,"reason":"historical_activity_facts_missing"},
  "effectiveInvitations":{"supported":false,"value":null,"reason":"qualification_policy_undefined"},
  "deliveredRedemptions":{"supported":false,"value":null,"reason":"delivery_completion_not_implemented"}
}
```

已支持指标空数据返回计数 0、积分 "0"。不支持指标不返回假 0，不提供任何转化率或成功率。

**当前不能可靠重建历史 DAU**。telegram_users.last_interaction_at 会覆盖历史；telegram_updates 虽按 Bot/update_id 去重，但只有 kind/status/time，没有 user_id、真实用户标记和互动事实。processed 还可包含频道和系统事件，不能直接 COUNT。后续应单独设计活动事实表：brand_id/bot_id/user_id/update_id、事件类型、事件发生/接收时间、唯一去重键；由后端统一明确哪些真实用户 message/edited_message/callback 算互动，排除频道、系统、Bot、自身及重复事件。现有历史记录无法无损回填。本批不修改 Update 处理或新增活动事件写入。

## Migration、索引与验收

006 增加 Brand/Bot timezone、验证触发器、dashboard.read 和两条范围日期索引：point_ledger(brand_id,bot_id,created_at)、redemptions(brand_id,bot_id,created_at)。用户 first_started_at 和 Referral bound_at 复用 005；账户复用既有 Bot/user 唯一索引。001–005 未改。

新增 tests/dashboard.test.ts，真实 PG17 CI 与 PGlite 均执行。主 Bot 10,000 用户、32,000 Ledger、9,999 Referral、10,000 Redemption，另有同 Brand Bot、不同 Brand Bot 和空 Bot。所有账户通过真实 Ledger trigger 入账。测试数据 success/cancelled 仅验证 Schema 记录投影，不能视为生产交付功能。

日志 `DASHBOARD_PERF` 逐项记录 1/7/30/90 天 summary/trends：dbMs 为数据库聚合+事务往返时间（不含 HTTP/RBAC），apiMs 为 Fastify inject 含鉴权和序列化的总时间（不含公网延迟），bytes 为 JSON 字节数。CI artifacts 保存本次精确性能记录。性能不依赖复杂缓存，单次测试的暖缓存结果不是并发压测或线上 SLA。

### PostgreSQL 17 首次实测记录

GitHub Actions run `36062733652`，Node 22.23.2 / PostgreSQL 17.11，以上主 Bot 数据规模。Dashboard 专项通过；该轮整体因原有 PG 验收仍断言 5 个 Migration 而失败，随后仅修正为 6。下面是实际测量，后续成功验收日志也会保留，不能当作生产性能承诺。

| 天数 | Summary DB / API ms / bytes | Trends DB / API ms / bytes |
|---|---|---|
| 1 | 11.54 / 9.60 / 1105 | 3.71 / 5.16 / 749 |
| 7 | 11.21 / 12.81 / 1122 | 6.98 / 11.23 / 1457 |
| 30 | 16.57 / 18.53 / 1134 | 12.89 / 16.48 / 4171 |
| 90 | 30.77 / 37.00 / 1149 | 35.43 / 33.91 / 11251 |

DB 与 API 各自独立执行计时，暖缓存及调度波动可能使后一次 API 比前一次 DB 计时更短。本次最大范围毫秒级、返回约 11KB，因此保留 90 日上限，不引入缓存。
