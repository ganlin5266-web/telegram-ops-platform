# Product UI Scope

## 1. 产品语言

用户只需要理解：

- **Level**：身份。
- **Growth**：升级。
- **Points**：奖励与兑换。
- **Benefits**：等级权益。

不要向普通用户或运营直接展示 fingerprint、Fact Revision、Lot Allocation、Rule JSON、mapping hash、idempotency key。需要时进入“高级诊断”。

## 2. Mini 最终目标

### 首页

- 当前 Level、Growth 进度、距离升级。
- Points 和即将过期 Points。
- 今日权益、今日行动、重点活动。
- 未接入项显示“正在准备/待接入”，不能显示假 0、假次数、假奖励。

### 会员

- 当前等级、Growth、升级进度。
- 当前权益、下一等级权益。
- “去赚 Growth”入口。
- Benefits 未接后显示清楚的未上线状态，不编造权益。

### 活动

- 推荐、任务、会员活动。
- 当前 Activity Backend 只有安全未发布状态；不得伪造参与、完成或奖励。

### 游戏

- 普通游戏入口、今日次数。
- 当前真实游戏和次数账户均为 `BACKEND_PENDING`；当前 UI 只能做未开放态。

### 我的

- 平台账号、Growth 记录、Points 记录、邀请、兑换、语言、帮助、Logout。
- UID 默认脱敏；不得展示认证材料。

## 3. Admin 最终目标

主导航：总览、用户、会员、内容、活动、积分、游戏、数据、设置。

- **总览**：老板/运营打开即可知道今天发生了什么。
- **用户**：Telegram 用户、User 360、平台绑定、Member 摘要、Points/Growth 历史。
- **会员**：Member、Level、Growth、Rules、History。
- **内容**：创建、发布计划、发布记录、内容模板；当前后端 pending。
- **活动**：活动与任务；未接入时明确显示状态。
- **积分**：余额、流水、有效期、Policy/Lot 高级诊断。
- **游戏**：机会、次数、结果；当前后端 pending。
- **数据**：日/周/月、统一筛选与服务端 metric。
- **设置**：品牌、Bot、平台及必要配置。

运营高频流程尽量三步内完成。能点选就不要求手输；能由后端从 scope 推导就不让运营重复选择。

## 4. Dashboard 和数据中心

Dashboard 指标目标：用户、新增、活跃、绑定、会员、升级、Growth、Points、活动、游戏、邀请、待处理。

数据中心支持日、周、月，统一筛选：日期、Platform、Country/Market。Metric 口径必须来自服务端：

- `SUM`：周期事实求和。
- `DISTINCT`：周期内去重主体。
- `SNAPSHOT`：指定时点快照。
- `RATE`：服务端统一分子/分母。

没有可靠数据时显示“待接入”。Frontend 不自行跨页聚合，也不把请求失败、无权限或未接入显示为 0。

## 5. Content Publishing UI（Lovable 推荐起始任务）

下一阶段优先建立 UI 信息架构和 typed contract：

1. 创建内容
2. 发布计划
3. 发布记录
4. 内容模板

创建内容支持：正文、图片、视频、Caption、Inline Buttons、Telegram Preview、保存草稿、立即发布、定时发布。

当前以下均为 `BACKEND_PENDING`：Media Storage、Telegram API 发送、Scheduler、Worker、Idempotency、Delivery Unknown。UI 可以完整设计，但所有执行按钮必须是明确的未接入/测试态，不能假成功。

如 UI 需要正式 API，提交 `BACKEND_CHANGE_REQUIRED`，由 Codex/Claude 实现后端。

## 6. 页面状态规范

每个远程模块必须覆盖：

- **Loading**：骨架或“正在读取”，不闪假数据。
- **Empty**：解释为什么为空，并提供真实可执行下一步。
- **Unavailable/BACKEND_PENDING**：明确功能未上线。
- **Permission denied**：说明无权限，不清空成 0。
- **Session expired**：回到登录/关闭重开流程。
- **Service unavailable**：显示“服务正在连接，请稍候后重试”；Login/Publish 等 POST 不自动重发。
- **Conflict**：提示刷新状态，不覆盖服务端事实。

## 7. 视觉与交互原则

- 用户三秒看懂重点。
- 现代、高级、清爽、轻量。
- 避免 AI 模板感、Excel 后台感、廉价博彩感、过度霓虹和渐变。
- 将技术复杂度留在服务端；运营页面使用业务词汇和渐进披露。
- 高风险写操作显示影响、scope 和确认；幂等 key 由 client 一次生成并在同次重试中复用。

## 8. Responsive

- Mini 必测：320、390、430 px 和 Telegram Desktop。
- Admin：Desktop 优先，Tablet 基本可用。
- 不依赖 hover 才能完成核心流程；抽屉/对话框需要键盘焦点管理。

## 9. i18n

继续 `web/src/mini/i18n.ts` 的既有体系：`zh-CN`、`en`、`pt-BR`、`es-MX`、`fil`。Admin 当前产品文案使用 `web/src/product/i18n.ts` 和 `copy.ts`。

不得新增第二套 i18n。新增 key 必须有明确 fallback；未完整翻译时显示既有 fallback notice，而不是空白或机器拼接。

## 10. 验收边界

- UI 数据必须来自 `FRONTEND_API_CONTRACT.md` 中的真实接口。
- 不变更 `PROTECTED_CORE.md`。
- 不把未完成能力写成已上线。
- Frontend component、browser、build、bundle/secret scan 必须通过。
- PR 描述列出：真实能力、pending 能力、empty/loading/error、responsive 尺寸和 API gap。

