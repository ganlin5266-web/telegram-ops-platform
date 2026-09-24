# Telegram 运营管理平台 — 第一阶段核心底座

多品牌、多 Bot 的服务端基础项目。Node.js 22+ / TypeScript / Fastify / PostgreSQL 17。没有正式 Token、没有正式发布、没有 Telegram 出站发送、没有第二阶段后台 UI。

## 本地验证

```sh
npm ci
npm run build
npm test
```

默认自动化测试使用 PGlite 在本机运行 PostgreSQL 引擎并应用真实 Migration；无须 Docker。CI 另外对 PostgreSQL 17 服务执行同一套测试，验证真正多连接事务与锁。测试只用生成的隔离测试数据。

## 连接独立开发数据库

```sh
cp .env.example .env
# 填写独立开发库 DATABASE_URL（初始化时使用 Migration owner）
npm run migrate
# 使用独立受限运行账号更新 .env 中 DATABASE_URL
npm run dev
```

`npm start` 运行 build 产物。数据库不在进程启动时自动迁移。Migration 使用单事务、锁和校验和；数据库变更必须新增 Migration，不修改已应用文件。

部署准备时 DBA 分别建立 Migration owner 与 `telegram_app` 账号，owner 应拥有 public 下的应用表，然后执行 `db/runtime-grants.sql`。不要用超级用户启动服务，更不要向 Lovable 浏览器分发数据库凭证。本阶段没有创建真实账号、Bot 或生产数据的命令。

开发时可由可信服务器脚本/DBA 写入 brand、bot、admin 与 admin_roles；Bot 默认 disabled，真实 Secret 仅环境变量。具体映射与权限参阅架构文档。第二阶段第 1 批管理 API 使用服务端 Session；没有初始化管理员时无法登录，没有后门账号或默认密码。首次初始化与运行配置见 [管理员认证运维](docs/admin-auth-operations.md)。

## 目录

```text
src/
  app.ts             HTTP 校验、鉴权、API
  server.ts          环境变量、服务启动/关闭
  db.ts              连接池、事务、Scope
  migrations.ts      Migration 锁与校验和
  migrate.ts         Migration CLI
  telegram.ts        Webhook、去重、用户、首次邀请
  points.ts          统一积分服务
  redemptions.ts     内部兑换/库存/退款事务原语
  language.ts        Telegram 语言与模板
  auth.ts            身份适配与数据库 RBAC
 db/migrations/      PostgreSQL Schema / 数据库防护
 db/runtime-grants.sql  最小权限部署脚本
 tests/              实际数据库自动化测试
 docs/               架构、Schema、Lovable、阶段报告
 .github/workflows/ci.yml  Build + 双数据库测试
```

详见 [架构](docs/architecture.md)、[数据表](docs/schema.md)、[Lovable 接口](docs/lovable-handoff.md)、[第一阶段报告](docs/phase-one-report.md)。

唯一主代码仓库：[ganlin5266-web/telegram-ops-platform](https://github.com/ganlin5266-web/telegram-ops-platform)。本轮仅进行第一阶段代码入库和 PostgreSQL 17 CI 验收；不进入第二阶段。实际验收以 Actions 对应 commit 的日志为准。

第二阶段第 1 批已新增登录、退出、当前身份/权限和授权品牌/Bot发现；原有用户/余额 API 复用 Session 认证及既有 RBAC。详细浏览器接入协议见 [Lovable 交接](docs/lovable-handoff.md)。未制作 UI、未接正式 Bot、未部署生产。

## 第二阶段第 1 批 UI

现已在同仓库 `web/` 增加中文运营工作台：登录、总览、授权品牌/Bot切换、Telegram用户游标列表、余额及人工调整积分。前面的“未制作 UI”描述是后端前置批次的历史范围。后端核心服务和 001–004 Migration 不变；未接正式 Bot，未部署生产。运行与测试见 [前端说明](web/README.md)。

CI 保留原有 PostgreSQL 17 的 58 项后端验收，增加前端构建、组件测试和真实 API 浏览器验收；结果以当前提交 Actions 日志为准。

## 第二阶段第 2 批后端查询

新增用户运营只读 API：搜索、筛选、稳定游标、独立 count、详情、积分汇总与流水、邀请关系、范围操作日志。契约见 [运营查询 API](docs/operations-query-api.md)。升级先按现有流程应用新增 005 Migration；多副本配置相同的服务端 QUERY_CURSOR_SECRET。没有开发第 2 批 UI、接正式 Bot 或发布生产环境。
