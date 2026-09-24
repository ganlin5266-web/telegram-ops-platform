# 管理员认证：初始化与运维

本轮只提供后端认证与范围发现，不创建真实账号，不部署生产环境。现有数据库架构、Telegram、积分和兑换业务保持不变。

## 首次 Super Admin 初始化

1. 用独立 Migration owner 应用包括 `004_admin_sessions.sql` 的全部 Migration。禁止修改已应用的 001–003。
2. DBA 为运行账号应用更新后的 `db/runtime-grants.sql`；浏览器无数据库账号。Migration/Bootstrap owner 不得作为日常 API 账号。
3. 在服务器的受控 Secret 目录创建一个当前用户所有、权限 0600 的普通 JSON 文件，字段为 `login`、`displayName`、`password`。不要放在代码工作区、共享目录或 Git 中，不要把密码作为命令参数。密码至少 15 个字符且不超过 128 UTF-8 字节，由负责人通过密码管理器生成和保存；本仓库不提供默认密码。
4. 将 owner 数据库连接通过服务器 Secret 环境注入 `DATABASE_URL`。运行：

```sh
node --import tsx src/bootstrap-cli.ts /secure/admin-bootstrap.json
```

5. CLI 只输出新管理员 UUID。确认成功后移除临时密码输入文件，并恢复受限账号启动 API。

Bootstrap 使用数据库表锁与事务，仅在 admins 表完全为空时允许执行，创建一个 zh-CN 管理员、scrypt 密码记录、全局 Super Admin 授权和审计事件。重复/并发初始化不能创建第二个首任管理员；运行账号没有初始化权限，也没有公共注册或 bootstrap HTTP 入口。

如果现有库已有管理员，CLI 会拒绝，不会自动覆盖密码或扩大权限。由负责人确认现有账号来源后，另行安排受审计的迁移/恢复操作；本轮没有密码重置后门。

## 配置与运行

查看 `.env.example` 的 `ADMIN_ALLOWED_ORIGINS`、`ADMIN_COOKIE_SECURE`、`ADMIN_COOKIE_SAME_SITE`、`ADMIN_SESSION_SECONDS`。生产必须设置 NODE_ENV=production、HTTPS 和精确前端 Origin。原 ADMIN_CREDENTIALS_JSON 不再由 server.ts 读取；保留旧 verifier 仅为原有服务级兼容测试，不构成浏览器认证退路。

本机开发可使用 localhost UI Origin 和非 Secure Cookie，API 默认只监听 127.0.0.1。运行已有 `npm run dev` 或构建后 `npm start`；环境由本机 .env 或部署 Secret 提供。

首次登录不会生成品牌/Bot/Telegram 用户。已有授权数据通过发现接口读取；没有数据时返回真实空列表。品牌/Bot 配置写 API 不在本轮范围。

## 生命周期与限制

Session 使用随机 32 字节 Token，服务端只存摘要；默认 8 小时绝对过期。登录轮换来访 Cookie 对应旧 Session，退出撤销当前 Session。禁用管理员使其所有 Session 在后续认证时失效；撤销不回滚已经完成的请求。

认证日志使用现有不可变 audit_logs，无密码、哈希、Cookie、CSRF 或 Bot Secret。过期与禁用失效在首次后续访问时记录，不引入定时任务。

管理员认证表、Session 表、限流表不能暴露给浏览器。将来运维需要定义 Session/限流历史保留与清理策略，本轮未新增后台调度器。基础限流不替代边缘网关 DDoS 保护；代理环境默认不信任客户端转发 IP。

OIDC 可沿现有 auth_subject/Principal 边界扩展；目前没有声称已实现 OIDC 登录或 MFA。密码恢复、第二个管理员的管理流程、统一 Session 撤销页面属于后续范围。

参考：[Node.js scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)、[OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)、[OWASP CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)。
