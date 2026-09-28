# Protected Core

本文件定义 Lovable 默认不得修改的核心。Frontend 需求不能成为绕过服务、账务、权限或证据链的理由。

## 1. 默认禁止修改

### Auth / Security

- `src/browser-auth.ts`：Admin Session、Cookie、CSRF、Origin/CORS、登录限流、Logout、RBAC session context。
- `src/mini-auth.ts`、`src/mini-sessions.ts`、`src/mini-recovery.ts`、`src/telegram-init-data.ts`：Mini exchange、Recovery、Bearer、Logout、重放保护。
- `src/auth.ts`、`src/admin-directory.ts`：权限解析与 Brand/Bot scope。
- `web/server/staging-server.mjs`：Proxy 严格 TLS、安全诊断、超时分类、错误映射；禁止给 POST 加自动重试。

不得把 Session 放进 LocalStorage，不得弱化 Cookie、TLS、CSRF、Origin 或 RBAC，不得记录密码、Cookie、Authorization、initData 或 Token。

### P3 Identity

- `src/platform-identities.ts`
- `src/platform-routes.ts`
- Migration `008_platform_identities.sql`

保护 UID canonicalization、脱敏、Brand/Bot/User/Platform scope、唯一有效 owner、审核状态和不可变历史。

### P4 Platform Data

- `src/platform-adapters.ts`
- `src/platform-data-input.ts`
- `src/platform-data.ts`
- `src/platform-data-routes.ts`
- `src/platform-trusted-input.ts`
- Migration `009`、`010`

保护 Adapter/Mapping、Canonical Decimal、currency/timezone/business_date、completeness、conflict、Fact Revision、Activate 和证据 hash。Frontend 不得解析平台 Raw 金额或重新 scale/round。

### P5-A Points

- `src/points.ts`
- `src/point-lots.ts`
- `src/point-lot-maintenance.ts`
- `src/point-expiry-routes.ts`
- Migration `011_point_lots.sql`

保护 Point Account、Ledger、Lot、Allocation、Expiry、Refund、幂等、FEFO/FIFO 和 Account=Ledger=Lot 对账。Frontend 不得计算余额或直接写最终账务。

### P5-B Qualification

- `src/entitlement-domain.ts`
- `src/entitlement-mapping.ts`
- `src/entitlements.ts`
- `src/entitlement-routes.ts`
- Migration `012_daily_entitlements.sql`

保护 Rule Version、Mapping Approval、D→D+1、Entitlement Revision、Conflict、Task/SLA、Input Fingerprint 和旧任务保护。

### Batch A Member/Growth

- `src/member-domain.ts`
- `src/member-growth.ts`
- `src/member-routes.ts`
- `src/member-worker.ts`
- `src/member-task-queue.ts`
- Migration `013_member_growth.sql`

保护 Member 合并/隔离、Growth Account/Ledger、Growth 来源、Evaluation、Daily Reconciliation、Daily Cap 350、来源优先级、Correction、Level Rules、Growth Rules、Level History、只升不降和并发幂等。

Growth 不等于 Points。UI 不得把 P5-B 测试 tier 当正式会员 Level，也不得根据充值、Points 或资格状态自行推断等级。

### Database / Audit

- `db/migrations/001_*.sql`–`013_*.sql`
- `db/runtime-grants.sql`
- Triggers、unique/check/foreign-key constraints
- `audit_logs` 不可变安全模型

禁止修改旧 migration、放宽 runtime grants、移除约束或用 UI 直接写数据库。新 schema 只能新增下一编号 migration，并由 Codex/Claude 审核。

## 2. 前端允许做什么

- 调用现有 API，完善 typed response。
- 调整页面布局、交互、文案、响应式和可访问性。
- 实现 loading、empty、unavailable、error、permission denied、session expired。
- 将技术证据收进“高级诊断”，运营默认界面仅显示业务含义。
- 为 `BACKEND_PENDING` 功能建立无副作用 mock contract/type 和 UI，但必须明确未上线，不能伪造数据。

## 3. 需要后端变化时

立即停止修改核心，提交 `BACKEND_CHANGE_REQUIRED`，包含：所需能力、业务原因、当前 API 缺口、期望输入、期望输出、empty/loading/error，以及是否涉及 ledger、migration、concurrency、idempotency、Telegram 或 Secret。

## 4. 合并门禁

- 只在 feature branch 工作。
- 变更必须通过 Frontend tests、browser tests、build、bundle/secret scan。
- 任何触碰 Protected Core 的 diff 必须由 Codex/Claude 审核并运行对应 PostgreSQL/安全测试。
- 禁止把未完成的 Benefits、Games、Content Backend 写成“已上线”。

