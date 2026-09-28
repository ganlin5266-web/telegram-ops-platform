# Staging login availability — 2026-09-28

## Observed evidence (UTC)

Both Staging services were Live at 57412b91d15b35e1855b08eb757ccba859506a18. Their latest deploys were hours before the observed failure window; no simultaneous deployment was visible. Both use Free compute.

Frontend safe proxy logs recovered real login failures:

| UTC | Method/path | Correlation | Upstream | Proxy duration |
|---|---|---|---|---|
|12:41:54.944|POST /v1/auth/login|e1eec43c-da0f-4be4-8a2d-0048b408095d|502 text/html|193 ms|
|12:42:24.508|POST /v1/auth/login|e152a56f-5e70-4388-91d1-eb974176b00e|502 text/html|94 ms|
|12:45:25.273|POST /v1/auth/login|3ef9efc6-631f-41f2-9435-663dd8c412be|502 text/html|103 ms|
|12:47:10.866|GET /v1/me (credential-free probe)|81830614-c217-4c34-bced-cb7c41fdfe5a|502 text/html|104 ms|

All these records have `upstream_http_error`, no network error, no proxy timeout, and socket_reused=false. Browser-to-proxy probe elapsed time was 2751 ms; this differs from the proxy's own upstream duration.

The next credential-free API Direct /v1/me took 23672 ms and returned 401 JSON, requestId req-1. API logs show a new hibernate instance running at 12:47:25 and listening at 12:47:31. The next /ready returned 200 in 1300 ms; frontend /healthz returned 200 in 1279 ms. Three subsequent Direct/Proxy pairs all returned 401 JSON in 1259–1512 ms.

## Conclusions and boundaries

- Confirmed failure layer: API-side upstream HTTP gateway/instance availability, transparently forwarded by the frontend. Not a locally generated proxy timeout. The API source emits JSON errors, not HTML.
- Cold-start association is supported by the new instance timeline and delayed direct request. Exact Render routing reason for repeated immediate proxy HTML 502 is not proven.
- No concurrent deploy, CSRF/RBAC refusal, DB exception, TLS/DNS/network error or socket-reuse failure was evidenced for these particular requests. This does not exclude those causes for other historical incidents.
- Application request logging is disabled; failed request arrival at the API process cannot be independently established. The later ready probe verifies current DB connectivity, not DB readiness during the unavailable interval.
- Mini live authentication was not replayed; technical failure handling is covered by targeted automated tests, not claimed as real Telegram acceptance.

## Minimal hardening

- Normalize non-JSON upstream 502/503/504 into safe JSON `upstream_gateway_unavailable`, preserving status and locally generated correlation header. Retain upstream status/type/timing in diagnostics; never forward the gateway body or its cookies.
- Add fixed safe path label for Mini recovery.
- Admin classifies 502/503/504 and client timeout as temporary connectivity failures, separate from 401, CSRF, permissions and application 500. Manual reconnect only rechecks the session with GET; passwords are not resubmitted.
- Mini recognizes gateway failure before JSON parsing and displays localized reconnect guidance. Existing explicit recovery-before-exchange behavior and one-attempt exchange guard remain unchanged.
- Proxy 15-second and browser 20-second budgets remain unchanged. No automated POST retry, TLS/Origin/CSRF change, session storage change, DB write, migration, member rule or feature flag change.

## Infrastructure decision required

`ROOT_CAUSE_PARTIALLY_PROVEN`; `LOGIN_STABILITY = PARTIAL` pending infrastructure and post-deploy acceptance.

`RENDER_ALWAYS_ON_RECOMMENDED`: remove idle spin-down from API first and from the frontend web service as well, so neither public entry nor auth dependency must cold-start during login. Render dashboard currently quotes $7/month each for 0.5 CPU / 512 MB, approximately $14/month compute for two services, excluding taxes, database, bandwidth and other charges. No paid change is authorized or executed. This addresses spin-down, not a guarantee against every gateway failure.

For development, prefer feature-branch CI and one approved batch release to Staging. Keeping CI-gated auto-deploy on main is compatible with that process if main changes only at release boundaries. Do not change Render auto-deploy or health-check settings without approval. Existing /ready checks DB; /healthz checks the frontend process. Confirm routing/readiness settings separately if further evidence points to deployment transitions.

Real hot Admin password login, real Mini first open/recovery/reload/logout, and controlled post-fix cold entry remain pending. Never call hot health probes cold-state verification.
