# 七天小范围试运营｜最小版本交接

基线：P0 已验收 `b05330a583b836a3661d50850f9f86dcce01465d`。本分支只开发和隔离测试，尚未部署，不代表本轮新增能力已经在 Staging 可用。

## 现状与本次完成

| 区域 | 原基线真实状态 | 本次处理 |
|---|---|---|
| Bot | Webhook 验证、用户/upate去重、ref_邀请绑定已实现；没有发送欢迎消息 | 在正式Webhook私聊路径响应新/回访欢迎、/invite、/help；按Bot独立发布，五语；未发布不回复 |
| Mini | 首页唯一主操作、UID、签到Growth、邀请/Points、兑换/原码重取均已验收 | 全部复用，仅增加可信Bot按钮的 `?view=invite` 邀请页导航，不使用URL选择身份/Brand/Bot |
| Admin邀请 | 创建、预览、发布、停用、长期有效、可选20 Points均真实API | 保留；活动中心增加内容/会员/库存的现有模块快捷入口，不增加菜单 |
| 内容中心 | 占位UI；模板和菜单表存在，只有模板读取API | 替换为五语草稿、新/老欢迎、按钮、客服、服务端手机预览、发布/停用、并发版本保护 |
| 数据总览 | Ops/会员/库存等真实接口可用 | 增加7天运营事件卡片，独立权限；未知/无权限/失败不填0 |
| 任务/游戏/主动提醒 | 不具备完整安全发布和送达执行链 | 不开发、不展示可领奖入口；旧scheduled_messages/message_delivery_logs不冒充可用发送器 |

没有重复实现 Points、Growth、Referral、Redemption、RBAC、Session，不修改奖励/兑换写事务。Migration 001–016 无变化，无新表，无新依赖、Secret或环境变量。内容发布需要独立批准最小 Runtime Grants，见附录；未执行任何 Staging SQL。

## Bot 与内容API

沿用 `/v1/brands/:brandId/bots/:botId/operations/content`，全流程检查现有 `messages.publish`、Brand/Bot Scope和原Session/CSRF/Origin。

- GET：`{draft,draftVersion,published,publishedVersion,enabled,miniUrl}`。
- POST `/draft`：`{config,expectedVersion}`，保存草稿。
- POST `/preview`：`{config,language,audience:"new"|"returning"}`，返回`{text,buttons,deliveryConfirmed:false}`，不发送。
- POST `/publish`：`{expectedVersion:draftVersion}`；POST `/disable`：`{expectedVersion:publishedVersion}`。
- Config：五个语言键 `zh-CN/en/pt-BR/es-MX/fil`，各含 `newUser/returningUser/openLabel/inviteLabel/supportLabel`；`supportUrl`为null或无query/hash的`https://t.me/用户名`。未配置客服则隐藏客服按钮。
- 复用`message_templates`中的两个保留key（`OPS_BOT_CONTENT_DRAFT`、`OPS_BOT_CONTENT_PUBLISHED`，存储language=en，body内完整五语JSON）。不碰已有模板。发布内容同一事务写版本与管理员Audit，不记录Token、原始认证材料或个人信息正文。
- Mini URL只能从服务端当前Bot的可信Mini binding产生；前端不能自填任意跳转。`view=invite`只影响导航，必须先通过现有Telegram认证。
- `/start`：首次Bot启动/回访不同欢迎。仅chat.type=private且chat.id等于发起人；错误Bot后缀、群聊、重复update不发送。
- 发布不会群发。只有用户发命令才以Webhook JSON `method=sendMessage`响应。无后台Worker、无自动重试、无Token额外读取。Telegram不提供该方式的发送结果，因此不宣称“已送达”；用户可再次发/start。
- 官方依据：[Telegram Webhook响应调用方法](https://core.telegram.org/bots/api#making-requests-when-getting-updates)。本地测试只验证协议响应，不向真实Telegram发送。

## 七天数据口径

GET `.../operations/metrics?days=7`，只读一致性事务。滚动7天UTC按事件时间统计，不是各平台业务日汇总，也不是严格转化漏斗。每个值为精确整数字符串；`forbidden/pending_collection`为null，真实空集合才为`ok/0`；数据库失败返回标准错误。

| 指标 | 可靠来源 / 边界 | 独立权限 |
|---|---|---|
| Mini参与用户 | 成功认证exchange关联session，Bot内去重user；不是PV/DAU，纯恢复不算新exchange | users.read |
| UID核实 | immutable identity.verify Audit事件；撤销不抹掉历史核实事件，不等于当前有效人数 | platform_identities.read |
| 签到 | **待采集**：Growth按Brand/Member共享，现存来源缺Bot，不以关联Member或修订流水猜测Bot次数 | growth.read |
| 邀请达标 | 期间曾verified/cap_exceeded证据，按Platform/Referral去重；关闭奖励时未评估的不计 | referrals.read |
| 邀请奖励发放 | granted事件Points求和，含双方50/20；不是人数，不混Growth | referrals.reward.review |
| 兑换创建 | 期间创建订单，含后来退款/复核 | redemptions.review |
| 兑换码领取 | 首次code_claimed_at，重取原码不增加；不代表游戏平台核销 | redemptions.review |

入口另需dashboard.read。所有查询都有Brand/Bot条件；无权限不返回值，后台不请求未授权模块。不增加用户追踪埋点，待采集指标暂不阻塞基本流程。

## 最简7天运营顺序（需要单独批准Staging开放）

1. 审核本分支和最小列权限，再批准必要服务部署。先保持奖励关闭，发布仅测试Bot的五语欢迎/客服；真人验证/start、回访、/invite、/help和两个Bot隔离。
2. 运营确认五语文案、客服账号、游戏平台HTTPS跳转地址、活动有效期、固定档位/有效期/库存和Points来源有效期。用已有后台配置，不新建奖励规则。
3. 单独批准确切Brand/Bot/Platform + 邀请双方用户白名单及有限合成库存；核对隔离、基线后才能短时启用奖励。未批准前保持关闭，不开放真实兑换。
4. Day 1引导Mini→UID；Day 2–3签到Growth及邀请进度；Day 4–6符合已批准规则时邀请/兑换；Day 7复核记录、账务、反馈并决定继续/停止。没有签到Points、额外任务或游戏奖励。
5. 每日只查看本次7天卡片与现有异常审核、库存、账务；邀请失败/待复核沿现有流程，游戏平台拒码不自动补发或退款。
6. 结束关闭奖励并清空试验白名单，保留流水/Audit，不删除数据。内容停用仅影响新命令回复，不修改历史消息或库存。

## 真正上线阻塞

- 本分支未部署；欢迎内容存储写权限仍未获批/执行。SQL仅草案。
- 需运营提供并确认客服地址、五语文案、具体活动/库存/平台链接；未配置客服不得假称可用。
- 新Webhook欢迎方式还需经批准部署后真实Telegram确认（本轮只有隔离协议和E2E）。BotFather域名现有配置应继续匹配现有Mini origin，不能未经批准修改。
- 真实奖励/真实码/真实用户开放仍需单独批准；本分支不打开任何奖励开关。

## Runtime Grants 最小审批草案（禁止本轮在Staging执行）

已有Runtime只有模板SELECT。本方案不需要DDL Migration；在批准窗口由Owner事务授予：

```sql
BEGIN;
GRANT INSERT (brand_id, bot_id, template_key, language, body, enabled, version)
  ON message_templates TO telegram_app;
GRANT UPDATE (body, enabled, version, updated_at)
  ON message_templates TO telegram_app;
COMMIT;
```

不授予DELETE/TRUNCATE/DDL/对象所有权，不授予UPDATE scope/id/key/language，不改变Points权限。数据库级权限覆盖模板表这些列；保留key与scope由现有授权API限制，并非新增RLS隔离。审批必须接受这一既有runtime信任边界。

回退：停用新内容或回滚到P0代码，不删模板/Audit。若撤销新权限，仅撤销本次此前不存在的上述列grant，禁止重置全部Runtime ACL；先对照执行前权限快照。旧P0不读取这两个保留key，回滚不会影响已发布活动/积分/兑换数据。正常上线前后使用原账务只读核对，本轮未连接Staging数据库。

## 本地验收

PG17 20/20；PGlite新功能20/20；既有Webhook相关7/7；前端定向39/39、Admin整合回归89/89；浏览器3/3（2项真实本地Admin API，1项明确标注的Mini导航合同夹具）。上述均0失败/跳过，未重复Batch全量。后端Build、前端TypeScript/Build、Secret Scan和Bundle Scan通过。日志SHA-256见`seven-day-test-evidence.json`。

专项验收修复了两处真实缺陷：PG统计窗口微秒精度损失，以及新Bot按钮错误入口路径。最终使用正式`/mini.html?view=invite`。没有以模拟initData冒充线上Telegram验收。
