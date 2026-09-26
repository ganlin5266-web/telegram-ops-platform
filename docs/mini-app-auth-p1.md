# P1: isolated Telegram Mini App authentication

Code-only, default OFF. This is not a Mini App frontend or a deployment. No UID,
platform data, member entitlement, activity, tracking, reward or redemption API.
Never activate the existing disabled synthetic staging Bot. No Telegram outbound
requests, webhook registration, real credentials or real users in automated tests.

## Boundaries

All existing administrator routes keep their URLs and run inside an encapsulated
Fastify plugin with the unchanged browser-auth hooks, Cookie, CSRF and RBAC. Mini
routes are a sibling plugin. Admin Cookie is ignored by Mini, Mini Bearer is not
an administrator credential. Webhook and health routes remain at root. Explicit
admin preflight routing preserves the existing CORS contract after encapsulation.

Enable only after separate deployment approval with server-only MINI_AUTH_ENABLED=true
and MINI_APPS_JSON={"bindings":[{"appKey":"approved-app","botId":"<existing UUID>","origin":"https://<approved origin>","tokenSecretRef":"<existing Bot token reference>"}]}.
Default false/unset installs no Mini routes and accesses no Mini tables. Invalid
explicit flags/config fail startup. Entries require unique appKey, Bot and secret
reference, exact HTTPS origin without path/query/credentials/wildcards. appKey is
only a selector, never authentication. The chosen reference must match the active
Bot row; Brand must be active. No environment or request can select arbitrary
secrets. Never put token values in JSON/VITE variables. Missing secret fails closed.

## Contract

- POST /v1/mini/auth/exchange: JSON {appKey,initData}. No query or extra identity fields.
  Returns {token,tokenType:"Bearer",expiresAt}; no Set-Cookie. Store only in caller
  memory. No localStorage, URL, analytics, error telemetry, logs or persistent storage.
- GET /v1/mini/me: Authorization: Bearer <token>; returns only
  {userId,brandId,botId,expiresAt}. No user/Brand/Bot selector parameters.
- POST /v1/mini/auth/logout: same Bearer, JSON {}; revokes current Session and returns {ok:true}.

All responses no-store. Use credentials:"omit". Requests carrying an Origin must
match an approved exact origin; exchange and logout require it. Session Origin
must match that Session's configured app, not merely another entry's origin.
GET may lack Origin (same-origin browsers); a valid Session is still required.
CORS allows only GET/POST and Content-Type/Authorization, no wildcard or credentials
allowance. POST requires JSON. OPTIONS only preflights; it grants no identity.
Bearer is explicitly supplied rather than an ambient Cookie; administrator CSRF
is not disabled or reused. Clients still need XSS protection. Real Telegram
containers and Origin behavior remain unverified until separately approved.

## Verification, Session and replay

Validate raw initData using Telegram HMAC-SHA256: WebAppData-derived Bot key,
alphabetical decoded fields excluding hash, including optional signature. Reject
ambiguous duplicate fields, invalid encoding, control-line ambiguity, invalid user
schema, oversized inputs, invalid digest and unsafe numeric identity. Compare
fixed-size digests in constant time. auth_date maximum age 300 seconds, future
skew 30 seconds. Recheck age after waiting for the Bot transaction lock.
No initDataUnsafe, URL user ID, nickname or start parameter establishes identity.

Canonical payload SHA256 is unique per Bot, including after query reordering or
alternate URL encoding. One exchange creates at most one Session. Exchange receipt,
minimal user upsert, Session and audit commit atomically. Failure rolls all back;
a committed exchange with a lost response cannot mint another Session.

Session is 32 random bytes represented as hex; only SHA256 stored. Absolute expiry
1800 seconds, no refresh/rotation endpoint. Session scope comes from relational
FKs, never client fields. Every read checks session revocation/expiry, user active,
Bot active, Brand active and current app binding. Removal of binding or disabling
Mini authentication stops acceptance. Logout updates only revocation fields.
Existing blocked/disabled users are not reactivated, preferred_language and
first_started_at are preserved. Mini login never fabricates /start or a referral.

Refresh loses the memory token. Reusing the same initData is rejected; close and
reopen the Mini App to obtain fresh Telegram initialization. Whether all containers
reissue usable initData must be verified. P2 should design recovery separately if
required, without allowing replay. No recovery protocol is implemented here.

## Database, grants, rates and audit

007_mini_auth.sql adds mini_auth_exchanges, mini_sessions, mini_auth_limits only.
No changes to migrations 001–006. Seed guards require exact 001–007 checksums;
old six-migration staging will refuse these updated seed CLIs until approved
maintenance migrates it. No startup migration or seed.

Existing admin_login_limits is administrator-specific. Reuse its PostgreSQL atomic
UPSERT approach, not its table: Mini has its own minimal counter table and grants.
Rate buckets are hashed; 50 exchange attempts/IP/15 minutes, 10 verified attempts
per Bot/user/15 minutes. Commit counters independently of rejected exchange
transactions. Concurrent replicas share PostgreSQL, not process memory. Forwarded
IP headers are not trusted; a same-origin proxy may cause clients to share an IP
bucket. Tune only after separately reviewing trusted proxy topology and load.

Runtime may select/insert Sessions/exchanges and update only Session revocation
fields. No DELETE/DDL, direct balance writes or admin credential changes. A future
maintenance cleanup may remove expired auth records under owner authorization,
never replay receipts within their acceptance window. No scheduler added in P1.
Audit records successful exchange/logout, scope, internal Session object ID and
request ID; no token, hash, initData, request body, Cookie or raw error. Limit
counters record rejections without creating an unlimited invalid-login audit stream.
No global request logging is enabled.

## Acceptance and rollback

Tests use synthetic keys/users and isolated PGlite/PostgreSQL 17, including real
multi-connection replay/rate races, runtime grants, FK isolation, rollback and
administrator regression. Browser tests cover the existing admin UI. No Mini UI
or Telegram container is created; real container acceptance remains pending.

After code/CI approval, obtain separate approval for a dedicated Telegram test Bot,
Mini test frontend, exact HTTPS origin, safe secret configuration, owner migration
and grants. Do not reuse or silently enable the disabled synthetic seed Bot. Check
Android/iOS/Desktop/Web launch, expiration, logout, reload and reopen, then admin
regression. No platform/entitlement data is needed.

Rollback: disable MINI_AUTH_ENABLED, restart all replicas, optionally revoke Mini
Sessions through approved maintenance; roll application code back, retain additive
tables and audit history. Do not delete users or down-migrate historical migrations.
A main push may trigger already-configured Render automation; this feature remains
OFF and does not require a staging migration while disabled. This change creates
no deployment integration and does not operate Render.

Local implementation acceptance: Node 26.5.0, PostgreSQL 17.11 disposable localhost
UTC database, migration applied twice before the parallel suite (same sequence as
CI). Backend 257/257 passed; PGlite 239 passed with 18 PostgreSQL-only skips. New
Mini tests: 49 total (3 require PostgreSQL); seed migration-guard cases also added.
Admin browser regression: 8 Playwright tests; frontend: 67 Vitest tests; fixed proxy:
37 tests, including Authorization forwarding. Backend/frontend builds, secret scan
and bundle scan passed. CI additionally validates Node 22/PostgreSQL 17. Real
Staging migration, Telegram Bot configuration and container acceptance are not done.
