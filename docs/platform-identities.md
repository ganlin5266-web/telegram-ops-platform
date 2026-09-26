# P3: Platform configuration and UID verification

Platform belongs to Brand, independently of Bot. A Platform Identity is one immutable submission/version, scoped to a Bot user and Platform; its Telegram numeric identity is protected by a composite user FK. Pending and verified records reserve both `(brand, platform, UID)` and `(brand, platform, telegram_user_id)` using partial unique indexes, including the same Telegram identity entering through different Bots. Conflict rows never own a UID. Their user-facing responses do not identify the existing owner.

## API and authorization

Mini Session scope only:
- `GET /v1/mini/platforms`: configured Brand platforms and this Bot user's latest/current masked binding.
- `GET /v1/mini/platform-identities?cursor=...`: own masked history, signed cursor scoped to Brand/Bot/User/filter.
- `POST /v1/mini/platform-identities`: JSON `{platformId, uid}`, UUID `Idempotency-Key`, `X-Mini-CSRF: 1`, approved exact Origin, Mini Bearer. No client Brand/Bot/user scope fields accepted.

Admin Session + unchanged CSRF/RBAC, prefix `/v1/brands/:brandId/bots/:botId`:
- `GET /platforms`: `platforms.read`.
- `POST /platforms`, `POST /platforms/:platformId/status`: `platforms.manage`, additionally Brand/global grant (Bot-only grant cannot change a Brand-wide platform).
- `GET /platform-identities`: `platform_identities.read`, list masked.
- `GET /platform-identities/:identityId`: explicit detail, `platform_identities.verify`, full UID only here.
- `POST /platform-identities/:identityId/review`: `platform_identities.verify`, `{action: verify|reject|revoke, evidenceReference?, reasonCode?}`.

Only Super Admin receives the four new permissions by default. Custom roles require explicit grants. Admin and Mini authentication remain separate. Admin lists use the current Brand/Bot selector and internal Telegram user identifier; scope changes unmount the review form and discard the full UID.

## Rules

UID remains a string, with configured ASCII digits/alphanumeric (`A-Z a-z 0-9 _ -`), length and case policy. Trim first; optional uppercase normalization. No nickname binding. No platform API, import or browser automation implementation: those modes are reserved and reject submission. Only manual review operates in P3.

Submission produces pending (or a retained conflict), never verified. Verify requires a controlled `CASE-...` evidence reference; references contain no UID or personal information. Reject/revoke require a reason from the allowlist. Verified cannot self-rebind. Revoke/reject preserves the old version; a later submission points to the previous record. Historical platform facts must reference that exact identity version in future phases, not join solely by the UID's current owner.

One short transaction locks the Platform row to serialize submissions and reviews. Database unique indexes remain the final concurrency protection. Duplicate keys with different data reject; same request reuses the prior outcome. Same current owner submitting the same UID reuses it. Repeated identical admin transitions reuse the result without audit noise; conflicting transitions reject. New attempts have a 30-second cooldown and maximum 10/day per Brand/Platform/Telegram identity. Pending reservations require operational review; no automatic expiry or transfer is introduced in P3.

`identity.submit/verify/reject/conflict/revoke` audits commit atomically with mutations. Audit contains identity ID, actor/scope and allowlisted reason, never full UID, request payload, token or evidence text. Platform create/status changes are audited. No point, referral, redemption or reward operation is invoked.

## Database / rollout

Migration `008_platform_identities.sql` adds two tables, user composite UNIQUE, identity constraints/indexes/immutable transition trigger, and four RBAC permissions. Migrations 001–007 are unchanged. The first-stage seed's exact migration guard now expects 001–008; its seed behavior is unchanged.

Runtime additions: SELECT/INSERT on the two new tables; UPDATE only platform status/updated_at and identity review columns. No DELETE/TRUNCATE/DDL or UID overwrite grants. Owner applies migration and exactly these three grant statements. Existing runtime role attributes and ownership stay unchanged.

Before rollout retain checksum/count baseline. Run migration+grants through the existing protected Owner channel with independent runtime login before and after; never SET ROLE through the Render owner. Validate migration 008/checksum/constraints/permissions and unchanged business baseline before main deploy. Deploy backend and canonical `web` together after the schema is present. No Bridge changes or new infrastructure.

For rollback deploy the prior app version to hide P3 endpoints/UI; preserve 008 and all identity/audit history. Do not DELETE/TRUNCATE identities or downgrade migrations. Disable a Platform through its audited admin action if necessary. Do not change existing authentication policies.

## Staging acceptance

Create via authorized admin API/UI only: FUN66_STAGING / FUN66 / BR / America/Sao_Paulo / BRL / manual_admin, alphanumeric uppercase, 1–64 characters. This is configuration for synthetic testing, not a connection to FUN66.

Real user: Mini → My → Platform account → FUN66 → synthetic `BRTEST10001` → pending. Admin reviews the actual pending record and synthetic test evidence, records CASE reference, verifies. Mini refresh/Reload → verified and masked UID. Cross-user conflicts and cross-scope requests are covered by isolated tests, not extra Staging Telegram users. Preserve baseline points 2 accounts/3 ledger, 1 referral, 0 redemption/codes. Audit increases only for explained P3 actions.

Never call submission "verified" before review. No first-deposit eligibility, platform daily facts, entitlements, games or P4 behavior.
