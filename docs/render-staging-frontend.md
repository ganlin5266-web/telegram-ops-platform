# Fixed Render Staging frontend

Canonical frontend: `telegram-ops-platform/web`. `github-connect` remains the
Lovable UI development bridge; review and copy approved UI changes into canonical
web before CI and staging acceptance. No database or backend code is copied here.

## Architecture and security

Browser -> fixed frontend HTTPS origin -> relative `/v1` -> Node HTTPS proxy ->
existing staging API -> existing staging PostgreSQL. This replaces Lovable Preview
in the acceptance path; it does not replace the existing API or database.

`server/staging-config.json` contains only the fixed approved API URL. Only the
Node server reads it. No client import, public asset, VITE variable, define injection
or environment target override is used. Missing/changed config fails startup.
The server rejects nonempty VITE_API_BASE and disabled TLS verification. Build
also checks Vite production env files and scans every dist file. Do not set
VITE_API_BASE; no `.env.local` is required. Never add DB credentials, session
secrets, Telegram tokens or webhook secrets to this service.

The proxy accepts only origin-form `/v1` and `/v1/*`, preserves method, raw body,
query, browser Origin, Cookie, CSRF headers and Idempotency-Key. It sets upstream
Host, strips hop-by-hop (including Connection-nominated) and untrusted forwarding
headers, validates HTTPS certificates, and preserves status/body and separate
Set-Cookie values. Cookie attributes are not rewritten. It neither follows
redirects nor retries requests. Incoming Origin is never rewritten to a trusted
origin: the backend remains responsible for exact Origin and CSRF validation.
Client headers and query parameters cannot change the fixed upstream.

Every API response has Cache-Control: no-store, including proxy errors. Keep
Render edge caching disabled. Do not enable a platform rule that caches `/v1`.
The total upstream deadline is 15 seconds, below the client's 20-second deadline.
Before response headers, timeout returns JSON 504 and connection/TLS failure
returns JSON 502; after a partial response, the connection is aborted because
HTTP cannot safely replace an already-sent status/body. API responses NEVER enter
SPA fallback. Platform-level cold-start/error pages remain outside this server.

Static files are served only from dist (outside symlinks/dot paths rejected),
with correct content type and no-cache. Only GET/HEAD HTML navigation to extensionless
non-API routes falls back to index.html. Missing assets/extensions return 404.
`/healthz` is local frontend liveness and does not contact the API or DB.
The server logs only fixed startup/error messages, no request/access logs,
headers, bodies, URLs, credentials or raw errors. Upstream sees proxy egress IP;
existing backend rate limits still apply. Do not blindly trust X-Forwarded-For.

## Checks

From repository root:

```sh
npm ci
npm --prefix web ci
npm --prefix web run build
npm --prefix web run test:proxy
npm --prefix web test
npm --prefix web run test:e2e
node scripts/scan-secrets.mjs
npm --prefix web run scan:bundle
```

Proxy integration tests use a temporary local HTTPS server and certificate, never
Render. TLS verification remains enabled, with trust limited to the injected test
agent. Test keys are generated outside the repository and removed after tests.
Playwright uses the existing isolated test fixture (PGlite locally, PostgreSQL 17
in CI), never staging. Bundle scanning checks known secret identifiers, credential
patterns and server deployment strings; it is not proof against arbitrary unknown
secret encodings. No deployment credentials belong in the build environment.

## Future Render setup (not performed by this change)

- Type: Web Service, Native Node (Node 22 compatible).
- Repository: ganlin5266-web/telegram-ops-platform, branch main.
- Root Directory: web.
- Region: Oregon.
- Build Command: `npm ci --include=dev && npm run build`.
- Start Command: `npm run start:staging`.
- Health Check Path: `/healthz`.
- NODE_ENV: production; PORT: provided by Render; listen host: 0.0.0.0.
- VITE_API_BASE: unset. No DATABASE_URL or other backend secrets.
- Auto deploy: After CI Checks Pass; ensure required jobs actually run.
- Prefer an always-on paid instance for stable acceptance. A Free API still cold
  starts even if the frontend is paid, and may exceed the client/proxy deadline.

Candidate name: telegram-ops-admin-staging. Use the actual assigned origin, not a
presumed available name. No new service, deployment, env change, bootstrap, seed,
DB write or login is part of the code implementation phase. A GitHub main push may
trigger pre-existing platform auto-deploy integrations; this code adds none.

After separate approval, add the actual frontend HTTPS origin to the existing
backend ADMIN_ALLOWED_ORIGINS (temporarily retaining migration origins). Preserve
Secure, HttpOnly, SameSite=Lax, Path=/ and no Domain for the host-only cookie.
Browser receives that cookie on the frontend host and sends it on relative /v1;
the proxy forwards it. A new domain requires a fresh login, not cookie migration.
Verify login, Set-Cookie, refresh /v1/me, CSRF failure, permissions, Brand/Bot scope,
user list, logout, 401/403 and isolation in a real browser. Only after acceptance
remove the old Lovable origins. Never allow localhost:8080 or wildcard origins.

Preserve all existing staging users, brand, disabled bot, ledger, referrals and
audit. Production is a separate future service/API/DB/secret/origin/release path,
not a config switch driven by browser input or the staging main auto-deploy.
Rollback frontend to a previous tested frontend deploy; no database rollback or
re-seeding is required. Do not remove required origins before rollback review.
