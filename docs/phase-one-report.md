# 第一阶段交付报告

本次仅建设核心底座，完成后停止，不进入第二阶段。项目保存在本地 Git 工作区；未配置 GitHub remote、未推送、未发布、未接入正式 Bot Token、未发送 Telegram 消息或正式运营积分。

| 交付项 | 结果与说明 |
|---|---|
| 1. 技术栈 | Node.js 22+、TypeScript 严格模式、Fastify 5、PostgreSQL 17、pg 连接池、Zod 校验；测试使用 PGlite 的 PostgreSQL 引擎 |
| 2. 项目目录结构 | src 共享服务与 HTTP；db/migrations 数据库；tests 自动化；docs 交接；.github/workflows CI；README 启动入口 |
| 3. 数据库 Schema | 3 个有序 SQL Migration；事务应用、互斥锁、SHA256 校验和；包含外键、CHECK、唯一索引及不可变 Trigger |
| 4. 数据表清单 | 23 张业务表、1 张 Migration 元数据表，见 schema.md |
| 5. 核心表用途 | schema.md 逐表说明；核心关系、用户、积分、订单、状态独立字段；规则与快照合理使用 JSON |
| 6. 多 Bot 隔离 | 每 Bot 独立用户、账户、邀请、Update、模板、菜单；复合外键 + 带 scope 查询 + RBAC |
| 7. 多品牌隔离 | brand → bot；所有业务关系携带 brand_id/bot_id；不硬编码品牌名称 |
| 8. Webhook 处理 | 验证活跃品牌/Bot 及 Secret Header，校验输入，事务保存收据、upsert 用户与邀请；群/频道事件暂记类型 |
| 9. Telegram Update 去重 | (bot_id,update_id) 主键；收据与业务同事务；失败回滚可重试，已成功 Update 返回 duplicate=true |
| 10. 积分 Ledger | 账户 + 不可变 Ledger；前后余额、增减、来源、业务事件、幂等 Key、备注、时间；bigint 与字符串 API |
| 11. 积分不重复发 | 同 Bot 事件与 Key 双唯一；事务及行锁；冲突内容拒绝；余额只在流水成功插入后更新，覆盖 ON CONFLICT DO NOTHING 边界 |
| 12. 邀请防重复 | 禁止自邀、首次绑定唯一；后续 start 不重绑，数据库拒绝修改绑定身份；具体奖励规则未实现 |
| 13. 兑换防重复扣分 | 内部事务原语：订单 Key 唯一、订单与扣分原子、库存行锁和一单一码、退款追加新 Ledger；没有正式兑换 API |
| 14. 多语言工作方式 | 主动选择 → 支持的 Telegram 语言 → Bot 默认 → 品牌默认；模板同序回退，缺失则失败 |
| 15. 后台中文不会导致 TG 中文 | 管理员 ui_language 与 Bot 语言函数完全隔离；不把管理员要求当发送正文，不隐式加入中文兜底 |
| 16. Lovable 配置菜单 | 表已准备 label/language/type/callback/url/sort/enabled；后续通过 BotSettingsService 授权接口配置，当前没有编辑 API |
| 17. Message Template 管理 | Bot+Key+语言唯一，支持正文/版本/启用；已有用户语言解析预览 API，管理编辑 API 留下一阶段 |
| 18. Token/Secret 保存 | 数据库只有环境变量/Secret 引用名；实际值仅在服务端，日志不记录；无接口返给浏览器，.env 被 Git 忽略 |
| 19. 已完成能力 | Schema/Migration、多租户、Webhook、Update 去重、用户 upsert、邀请绑定、统一积分、模板回退、API 基础、RBAC、人工调整 Audit、测试、构建、文档 |
| 20. 仅预留结构 | 活动奖励、复杂规则、菜单编辑、完整兑换审批/交付、定时 worker、频道/群出站、AI 生成、后台 UI、OIDC 登录、监控与运营部署 |
| 21. 自动化测试 | 最终结果见下方验收记录；覆盖用户要求的十类规则，并包含权限/事务/Secret/数据库冲突边界 |
| 22. Build | npm run build 完成 TypeScript 编译，退出码 0；没有前端 Build，因为本期未制作 UI |
| 23. Lovable 接入点 | docs/lovable-handoff.md 的现有 HTTP API 及待实现服务契约；先接正式登录和只读列表，再逐模块加入授权 API；禁止直写关键业务表 |

## 验收记录

本机 Node.js v26.5.0；CI 目标 Node.js 22。安装依赖完成且生成 package-lock.json，安装时 npm audit 为 0 vulnerabilities。

`npm test`：**18 项通过，0 失败，0 跳过**，退出码 0，耗时约 1.28 秒。

`npm run build`：**通过**，退出码 0。

测试执行了全部 3 个 Migration、重复迁移校验、HTTP 注入请求、数据库约束/Trigger/事务，以及最小权限角色验证。

PGlite 使用实际 PostgreSQL SQL/外键/Trigger/事务，但单进程数据库队列不等同于真实 PostgreSQL 多连接并发。GitHub Actions 已配置 PostgreSQL 17 服务的第二轮测试；因为未配置远程仓库，本次没有云端 CI 或真实 PostgreSQL 17 执行记录，不能声称已验收该环境。

已在本机测试受限 telegram_app 角色能处理积分与 Webhook，并拒绝直接修改余额。生产环境仍须部署独立数据库账号、网络控制、TLS、身份系统、备份/恢复与监控后再进行上线验收。

## 十项要求对应测试

| 要求 | 测试验证 |
|---|---|
| 重复 Update 不重复处理 | 并发请求相同 Update；只有一次非 duplicate |
| 重复 /start 不创建重复用户 | 两个不同 Update 相同 Telegram 用户；只有一个档案 |
| 同积分事件不能重复入账 | 同事件并发请求同 Ledger ID；改变金额冲突 |
| 余额和 Ledger 一致 | 100 加分、25 扣分合计 75；拒绝直接改余额及删除流水；冲突丢弃不变更余额 |
| 不能自己邀请自己 | 使用自己的 ref code，零邀请关系 |
| 不能重复绑定邀请人 | 后续另一 ref code 不替换；SQL 修改被拒绝 |
| 重复兑换不重复扣分 | 两请求同订单 ID，仅扣一次；失败只退款一次 |
| 同码不能分配两次 | 两订单争抢一条库存，只有一项分配成功 |
| 语言回退不受后台中文影响 | zh-CN Telegram 语言回退 pt-BR，缺失模板拒绝使用中文模板 |
| Bot 数据不能串 | 跨品牌及同品牌不同 Bot 的账户/邀请/模板访问失败；相同 Telegram ID 可独立存在 |

第一阶段交付至此停止，等待负责人确认，不自动继续后台或其他第二阶段业务。
