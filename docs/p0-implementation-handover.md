# P0｜Mini 运营增长体验交接

## 交付范围

- 基线：`46958f2bc1956d41dad338b8bfe3f1e1f79dd85c`；分支：`codex/p0-growth-experience`。
- 首页按 Points、兑换差额、唯一主操作、签到、邀请进度、最近订单排序。推荐动作由后端计算，审核中的 UID 不重复催绑。
- 首页与会员 GET 改为真正只读，不初始化会员、不更新等级。显式签到仍复用原业务流程；显示当天实际 Growth 净入账、上限和下次时间，Points 独立。
- 邀请按选定 Platform 当地日期展示活动、已奖励人数和合格人数；最新异常优先展示待复核。奖励关闭或无资格仍可分享，不承诺必得奖励。
- 尚无 Member Link 的邀请人显示待初始化，保留分享及显式签到入口，读取不会创建会员。
- 兑换展示服务端精确余额差额、库存及每日额度；保留一次确认、幂等键、原订单重取、复制与安全 HTTPS 跳转。领码不代表游戏平台核销。
- 四个底部入口：首页、奖励、邀请、我的；隐藏未开放任务、小游戏及会员权益。会员/Growth 放到“我的”。
- 中、英、巴西葡语、墨西哥西语、Filipino 全量静态文案，包含错误、空态、成功反馈；后台配置的活动名/平台名/等级名属于业务数据，不冒充已翻译文案。

接口合同见 [p0-mini-api.md](p0-mini-api.md)，机器可读测试记录和文件清单见 [p0-test-evidence.json](p0-test-evidence.json)。

## 安全与兼容

没有新增 Migration、Runtime Grants、依赖或环境变量。Migration 001–016、Points/Lots 原语、奖励发放入口、兑换写事务、Mini Auth/Session、Webhook、RBAC、Proxy 和 Staging Server 均保留。`referral-rewards.ts` 仅增加展示用 gate helper。

全部数据库验证使用本机隔离 PostgreSQL 17 或 PGlite；未连接或写入 Staging，未部署，未修改 main、Render、奖励总开关或白名单。原有脏工作区保持原状。

读取状态是建议值，不保证多个 SELECT 构成同一瞬时快照。最终资格、金额、库存、额度仍由原写事务重新校验。推荐可参与邀请不代表未来被邀请人也满足白名单或资格条件。

## 测试证据与边界

最终数量以 `p0-test-evidence.json` 为准。覆盖全量 PG17/PGlite、Migration 001–016 双次 replay、前端组件、Proxy、浏览器、TypeScript/Build、Secret/Bundle Scan。PGlite 明确跳过仅适用 PostgreSQL 多连接的用例；PG17 实际执行这些用例。

P0 定向测试包括：只读事务内 GET、刷新零初始化、实际签到及后续 Correction、Points 不受签到影响、跨 Bot 共享会员兑换额度、精确大整数、六合格/五奖励、开关/用户范围、未知会员不误示资格、当前 Revision 状态、跨 Platform 隔离。

浏览器中的 Mini 认证与业务响应使用明确标注的合成合同 fixture；SQL、认证、权限、幂等和账务由真实隔离数据库测试验证。Admin 浏览器流程连接本地测试 API。**本轮没有执行真实 Telegram 或 Staging 人工验收，不能以本地 fixture 结果替代。**

初次 PG17 全量出现 21 项旧日期夹具失败：本地集群默认 `Asia/Yerevan`，无时区字面量与 UTC 查询窗口不一致。改为测试连接 UTC 后全量通过；未修改业务日期逻辑或删除断言。Proxy/PGlite 启动曾因沙箱禁止本地监听/IPC 失败，授权本地测试后通过。

## 分支和部署边界

只读查看 Render 两个服务：均绑定 main，自动部署关闭；本功能分支普通 Push 不触发部署。GitHub push workflow 仅验证，不含部署步骤。

后续申请 Staging review：优先 API 后 Frontend，使用同一固定版本；API 扩展保留旧字段，旧前端可继续读取。新前端应配套新 API，缺少资格字段时保持不可兑换/未确认，不能当作零余额。部署需另行批准。

剩余待验：真实 Telegram 的五语页面、平台切换、人工复制/重取及视觉确认；三种新增完整翻译建议运营母语审校。它们不阻止提交代码审核，不代表已经通过线上验收。

## 成果恢复

完整提交保存在上述功能分支。完整 patch、原始测试日志及其 SHA-256 清单保存在项目 `output/p0-growth-experience-20261029/`，patch 另做精确基线干净应用检查。不得将该目录内任何历史 Staging 凭据或业务备份加入提交；本次只保存非敏感本地测试证据。
