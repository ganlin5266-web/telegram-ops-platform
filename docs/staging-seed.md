# Staging 最小 Brand / Bot seed

此维护 CLI 不由 server.ts、HTTP API、migration 或应用启动调用。当前仅创建一个 Brand、一个 disabled Bot 及必要审计；不创建管理员、用户、积分、邀请、兑换、模板、菜单、频道，不导入 Telegram 或其业务执行入口。

## 命令

从仓库根目录，Node >=22，安装 package-lock.json 锁定的依赖：

```sh
npm run staging:seed
npm run staging:seed -- --dry-run
npm run staging:seed -- --apply
```

前两条均为 dry-run。参数不允许组合或扩展；apply 必须明确给出，不自动重试。

仅在本机可信 Terminal 临时注入 DATABASE_URL。维护人员自行从密码管理器/Render 取得 owner External URL，不向聊天、Codex、Git 提供凭据。例如当前 shell 已安全准备 OWNER_DATABASE_URL 时：

```sh
(
  unsetopt XTRACE VERBOSE
  export DATABASE_URL="$OWNER_DATABASE_URL"
  npm run staging:seed -- --dry-run
)
```

审核 dry-run 后才另行批准 apply。不要使用生产连接、不要将实际 .env 提交，不修改 Render runtime DATABASE_URL。不要用 telegram_app。CLI 在进程内将 URL 设置为 sslmode=verify-full，保留凭据，禁止 NODE_TLS_REJECT_UNAUTHORIZED=0；不覆盖调用者原变量，不降低证书或主机名验证。External IP allowlist 仅临时开放维护者出口，完成后恢复限制。失去连接/提交结果不明时先只读核对，不自动重试。

## 保护与固定数据

必须 current_database() 精确为 telegram_ops_staging、pg_stat_ssl.ssl=true，当前角色拥有数据库及六张相关表且不是 telegram_app。数据库名称本身不是环境认证，操作者仍需核对 External endpoint 属于独立 staging。001–007 的完整记录集和 SHA256 必须与当前检出的文件一致；额外 migration 也拒绝，后续 schema 扩展需先重新审查 seed 工具。

staging-admin 必须对应 local:staging-admin、active、global Super Admin（brand_id/bot_id 均 NULL），且该角色具有 system.manage。只读验证身份，不创建或修改管理员及授权。

Brand：Staging Test Brand / staging-test-brand / zh-CN / UTC / active / countries=[]。

Bot：Staging Test Bot / staging-test-bot-not-telegram / zh-CN / supported_languages=[zh-CN] / timezone=NULL / disabled。合成 username 含连字符，故意不是可注册的 Telegram username。默认时区继承 Brand UTC。

两个引用名 STAGING_TEST_BOT_TOKEN_UNCONFIGURED、STAGING_TEST_BOT_WEBHOOK_UNCONFIGURED 必须在执行环境完全未设置（空字符串也拒绝）。这些只是引用名，不是凭据。API 环境也应保持未配置；CLI 无法读取或证明 Render 的实际环境。禁用 Bot 可供管理查询和 scope selector 使用，不能通过正常 webhook 处理。

## 幂等与冲突

在同一个事务中取得 pg_advisory_xact_lock(741092,1)。dry-run 同样先设置 READ ONLY，锁仅协调并发，不写业务数据。

Brand 按固定 slug 定位；Bot 同时检查固定 username 及两个唯一 secret ref，防止引用碰撞被误认为可新建。已有数据所有受管字段（含 Brand 关联）必须精确一致；一致则复用、不 UPDATE。不一致时只输出 brand_conflict / bot_conflict，不输出数据库原始 detail。新建数据用参数化 SQL，没有 UPSERT 覆盖、DELETE 或自动修复。默认 UUID/时间字段不属于受管字段。

结果只包含非敏感计划、动作和数据库 UUID。dry-run 中尚未存在对象的 UUID 为 null，action=create 表示计划，不表示已写入。

## 审计

现有 audit_logs 支持管理员、Brand/Bot 范围、action、object_type/id、JSON after_data 和 note。每个新对象在同一事务记录 staging.seed.create，actor 为已验证的 staging-admin，note 明确 maintenance CLI，不伪称浏览器请求。after_data 仅固定受管字段（引用名不是 Secret）。完全复用时不增加审计，dry-run 不写审计。任意创建/审计失败回滚整笔事务。

## 验证与撤销

自动化 PGlite 测试覆盖业务数据/审计事务；数据库身份和 TLS 元数据在 PGlite 适配器中模拟，不声称真实 TLS 验证。TEST_DATABASE_URL 下另有真实 PostgreSQL 双连接 advisory lock 测试，仅针对隔离 CI 数据库。

批准 apply 后核对返回 ID、各一条 Brand/Bot、disabled 状态、UTC 继承及审计，再刷新 UI 检查 selector、scope permissions 和空用户列表。全局 Super Admin 自动可见，无需创建 scope grant。

提交前失败自动回滚；提交后不自动删除。若后续需要撤销，先审核精确对象及依赖，保留不可变审计；已有业务流水时不可清库。停用不会隐藏管理员列表记录。本工具没有 rollback/delete 参数。
