# P1 staging acceptance entry

This is a test-only entry, not a product Mini App. No UID, rewards, points,
referrals, redemption, platform data or P2 functionality is added.

The fixed frontend serves `/p1-mini-test.html`. Open it from the dedicated
`FUN_Club_Staging_bot` using BotFather's Mini App/menu configuration. The precise
origin is `https://telegram-ops-admin-staging.onrender.com`; the public selector is
`p1-staging-auth`. A selector is not a credential. Do not enable the synthetic Bot.

The page uses the official Telegram Web App SDK and sends raw `WebApp.initData`
to the existing exchange endpoint for server-side verification. It never uses
`initDataUnsafe`, URL identity selectors or a client-provided Bot/secret reference.
No authentication semantics, administrator routes, migrations or grants change.
The SDK source and integration contract are documented at
https://core.telegram.org/bots/webapps#initializing-mini-apps.

All API requests are relative `/v1/mini/*`, `credentials: omit`, `cache: no-store`,
with redirects rejected and no automatic retries. Bearer exists only in a closure,
never in storage, UI, URL or logs. Only the server-returned internal user ID is
displayed (masked); the page does not claim unverified Telegram profile data is
authenticated identity. Brand/Bot IDs come from `/me`.

Connect exchanges at most once per page lifetime. A timeout may mean the server
consumed initData; close/reopen instead of silently retrying. Refresh/page exit
clears memory. P1 intentionally provides no recovery protocol. Logout confirms
the revoked bearer receives 401 from `/me`; unexpected acceptance is a safety stop.

Only configure the dedicated Bot binding after owner-reviewed staging setup.
Bot token belongs in Render's secret environment value, never JSON or frontend.
The dedicated webhook secret reference must remain unconfigured; do not register
a webhook or send Telegram messages. Mini enabled scope is the single binding.

No real Telegram/client acceptance is implied by synthetic unit or browser tests.
Record each tested client, new-user/auth-record counts, replay results and refresh
steps separately. Fixed proxy preserves Authorization and Origin. IP limiting still
uses `req.ip` without trusting forwarded headers: proxy users may share a bucket.
This limitation must be reviewed before broader use, not silently relaxed.

Rollback: set Mini authentication false and redeploy the existing API; retain all
audit/auth history and users. Remove the test entry from BotFather if necessary.
The administrator entry remains `/`; do not down-migrate or reset business data.
