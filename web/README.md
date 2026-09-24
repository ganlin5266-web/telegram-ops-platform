# 第一批中文运营工作台

同一仓库内的独立 React + TypeScript + Vite 前端。后端继续使用根目录 Fastify/PostgreSQL 服务。当前开放总览、Telegram 用户、余额读取及授权人工调整积分。没有生产 Mock、默认账号或浏览器数据库连接。

## 本地运行

先按 `../docs/admin-auth-operations.md` 在开发环境初始化管理员与授权数据，再从仓库根目录启动已有后端（3000 端口）。在本目录执行：

```sh
npm ci
npm run dev
```

访问 `http://localhost:5173`。开发服务器 `/v1` 代理至 `http://127.0.0.1:3000`，保留浏览器 Origin。后端 `ADMIN_ALLOWED_ORIGINS` 必须包含实际访问 Origin，默认值已包含 `http://localhost:5173`。端口固定，冲突时显式报错。没有管理员或授权数据时，请通过已有服务端运维流程准备，前端不自建账号或伪造数据。

## 配置与部署边界

默认 API 基址为空，使用同源 `/v1`。生产静态产物位于 `web/dist`，应由同源 HTTPS 站点托管，`/v1` 反向代理到已有后端。本批没有部署动作。

若确实使用独立 API 域，可在构建环境设置公开配置 `VITE_API_BASE=https://api.example.com`，不要带尾部斜线。**所有 VITE_ 配置都会进入浏览器构建产物，只允许公开 API 地址；禁止存放任何凭证。** 必须同时由后端负责人正确配置精确 CORS、Secure Cookie 和 SameSite；前端不关闭 CSRF。完整跨域规则以交接文档为准。

React 本地内存保存当前身份、CSRF、范围、列表和操作状态。没有 localStorage/sessionStorage 持久化；页面刷新重新调用 `/me` 并加载授权列表。Cookie 由浏览器处理，所有 API 使用 `credentials: include` 和 `cache: no-store`。

401 或 CSRF 失效清空会话、范围与数据。403 清空当前范围数据及权限并提示重新加载授权范围。后端仍执行最终鉴权。范围和详情请求携带本地代数标识，切换时同步失效，旧请求返回后不能写入新范围。

积分始终使用十进制字符串；预计余额只使用 BigInt。提交包含固定 eventId 和 Idempotency-Key，失败时原操作重试不生成新标识。成功后必须重新 GET 余额，读取失败显示“暂无数据”，不使用预测值冒充余额。关闭未确定结果的操作后应先重新读取账户并核查操作，避免人为发起另一次相同业务。Session 过期不自动重放写请求。

## 验证

```sh
npm test
npm run build
npm run test:e2e
```

组件测试使用明确隔离的 API 响应 fixtures，覆盖错误及延迟竞态；生产入口不导入它们。端到端测试启动现有 Fastify 应用、真实认证/RBAC/积分服务，使用临时生成的测试密码和独立测试数据。默认使用内存 PGlite，CI 指定 TEST_DATABASE_URL 后使用真实 PostgreSQL 17。**只允许指向可丢弃测试数据库，切勿将 TEST_DATABASE_URL 指向真实环境。** 测试不运行正式 Bot，不读取实际 Secret。无 Playwright trace/HAR，避免记录登录请求凭证。

首次运行浏览器测试先执行 `npx playwright install chromium`。浏览器测试占用 3000 和 5173 端口，并拒绝复用已有服务，避免误连真实后端。

## 目录

- `src/App.tsx`：会话、授权范围、页面与积分确认流程
- `src/api.ts`：带 Cookie 的 API Client、安全错误映射、CSRF 请求和积分操作标识
- `src/style.css`：桌面固定导航、移动抽屉、列表与详情
- `tests/`：组件与 API Client 验证
- `e2e/`：隔离数据库测试服务及真实浏览器验收
- `vite.config.ts` / `playwright.config.ts`：开发代理及测试配置

当前未提供搜索、全量数量、CSV、积分流水列表、运营指标、品牌/Bot 创建、管理员管理或其他后续模块；依赖未来服务端管理 API。
