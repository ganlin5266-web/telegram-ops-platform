# P2 Mini App V1

## Scope and baseline

Based on main `810d8aa0b50d62f73b3ce67dda241d786e0bf07b`. API and frontend Live matched that commit at preflight. P1 final user-run readonly evidence is the database baseline: migrations 001–007 match, real test user 1, synthetic users 3, point accounts 2, ledger 3, referrals 1, redemptions/codes 0. No new migration or runtime grants are required. No database maintenance connection is used by development/deployment.

Canonical `web` remains a single React/Vite build with independent entries: administrator `/`, product `/mini.html`, diagnostic `/p1-mini-test.html`. Mini component state, client, navigation and CSS are separate. Shared build chunks contain only common runtime modules. No deployment URL or secret is in the Mini bundle. The public `p1-staging-auth` selector is not a credential. The dedicated staging Bot is the only approved binding. No Bridge changes.

## Data routes

Existing `/v1/mini/me` remains unchanged. New GET routes: `home`, `points`, `point-ledger`, `referrals`, `redemptions`, `activities`. Every route authenticates a Mini Bearer through current binding, active Brand/Bot/User, unexpired/unrevoked PostgreSQL session. Every user query binds brand/bot/user from that principal. Unknown identity parameters are rejected. Signed cursors bind route and identity; limit 1–50, default 20. Points stay decimal strings. No account is created by reading; missing account returns `accountExists:false,balance:null`.

Only a safe field projection is returned. Internal audit notes, reward configs, redemption snapshots, code references, invitee personal information and platform data are not returned. Invitation counts refer to this user's outgoing bindings, not rewards. Redemption is history only, no apply/action endpoints.

Activity configs are not an approved user-facing publishing/audience contract. `/activities` explicitly returns `catalogueStatus:not_published,participationEnabled:false,items:[]`; this is capability-unavailable, not a claim that internal activities count is zero. Draft names/rules are never exposed. No participation/share/claim buttons. UI language is zh-CN only, separate locale module reserves future locales without changing Telegram language fallback.

## Recovery protocol

Legacy exchange remains one-use and unchanged by default. Product opt-in `{recovery:true}` adds `X-Mini-CSRF:1`, JSON body and exact approved Origin. On successful exchange only, set `__Host-telegram_mini_recovery`: Secure, HttpOnly, SameSite=Lax, Path=/, no Domain, Max-Age=1800. The cookie holds the existing opaque Mini credential; PostgreSQL stores its hash only. It is not the administrator cookie and is never accepted on Mini data routes or admin APIs.

On refresh the product first POSTs `/v1/mini/auth/recover` with appKey, raw Telegram context and the recovery cookie. The endpoint requires JSON, exact binding Origin, custom CSRF header, rejects cross-site Fetch Metadata, authenticates the live session, verifies Telegram HMAC and exact original exchange digest/user. The recovery-only signature verifier allows at most 2100 seconds from auth_date because exchange may occur within the original 300-second window and session lasts 1800 seconds. This does not extend the session. Exchange itself remains limited to 300 seconds.

Recovery returns the existing Bearer into memory: no second exchange/session, no extension, no persistence in local/session storage or URL. Another signed user/context cannot inherit the cookie. New context after close/reopen may perform a fresh one-use exchange. Logout revokes current session, clears cookie and verifies the old Bearer returns 401. Other historical sessions are not deleted. Recovery adds `mini.auth.recovery` Audit; it never writes business data.

Bearer data calls use credentials omit. Cookie exchange/recover/logout use same-origin credentials. CORS does not enable cross-origin credential sharing. Proxy preserves Cookie/Set-Cookie and Origin. P1 diagnostic page stays cookie-free exchange by default. Cookie blocking in other Telegram containers is a compatibility limitation; no SameSite=None workaround is introduced. Expiry/logout require a fresh Telegram context; no replay bypass.

## Rate limit topology

Render edge terminates HTTPS before frontend Node; frontend forwards to API over HTTPS, removes untrusted Forwarded/X-Forwarded metadata; API uses socket peer. No new trusted proxy assumption or forwarding header is accepted.

P2 splits anonymous invalid traffic from valid identities. Invalid signatures and unknown selectors consume persistent 50/15min denial buckets keyed by phase + approved Bot (or unknown) + socket peer. Valid cryptographically verified users do not consume those shared proxy denial buckets; they retain PostgreSQL atomic Bot + Telegram User limit 10/15min. Recovery uses session-specific 30/15min limit after identity/context validation. Body limits and HMAC size checks bound parsing. Anonymous quota is not a replacement for infrastructure DDoS mitigation: verification still runs before classifying validity. Shared-IP malformed traffic can share rejection quota but cannot exhaust valid-user quota. Direct spoofed forwarding headers cannot change these keys. No rate-counter deletion or role expansion.

## Failure handling and safety

User messages distinguish network/timeout/non-JSON/401/403/404/409/429/5xx without exposing raw API error/body. Safe requestId can be supplied to support. No automatic exchange retry; a lost response first attempts credential-backed recovery. Existing transient administrator network observation has no proven root cause and is not claimed fixed.

No changes to administrator Cookie/CSRF/RBAC, points, ledger, referrals, redemptions, webhook, grants or migrations. No UID, platform data, entitlement, games, tracking or reward execution.

## Deployment and acceptance

Deploy existing API and frontend only after tests/CI. Build/start commands unchanged. No new env or secret is required. `/health`, `/ready`, frontend `/healthz`; page navigation Accept:text/html. New authless data routes must 401, recover without cookie must fail, old P1 tests remain. Browser tests use synthetic contracts; they are not actual Telegram evidence.

After automated staging checks, user changes dedicated Bot Menu Button URL to `/mini.html`, opens Desktop, tests all five tabs, Reload recovery, Logout, close/reopen fresh login. No bot token is requested. Record iOS/Android/Web as untested unless actually tested. Re-run narrow readonly DB evidence after real operation: only expected session/exchange/limit/audit/profile updates; business baseline unchanged. Do not conflate UI success with DB proof.

Rollback: restore previous API/frontend commit and Bot menu URL `/p1-mini-test.html`; no down migration/data deletion. Legacy API ignores recovery cookies; sessions retain normal revocation/expiry. Unexpired recovery cookies do not give administrator identity. Stop on any scope/credential/data anomaly.

Official references: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app and https://render.com/docs/web-services#connect-to-your-web-service .
