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

开发时可由可信服务器脚本/DBA 写入 brand、bot、admin 与 admin_roles；Bot 默认 disabled，真实 Secret 仅环境变量。具体映射与权限参阅架构文档。管理 API 默认拒绝访问（ADMIN_CREDENTIALS_JSON 为空），没有后门账号或默认密码。

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
