# Staging synthetic Telegram users (maintenance only)

This independent CLI adds long-lived synthetic fixtures only to the existing Staging Test Brand and disabled Staging Test Bot. It never creates or updates Brand/Bot, administrators, grants, templates, activities, redemptions or Telegram updates. No Telegram credentials, webhook calls or network send implementation are used.

Commands from the repository root, after locked dependency installation:

- `npm run staging:seed-users` or `npm run staging:seed-users -- --dry-run`: READ ONLY transaction, checks and proposed create/reuse result, no writes or audit.
- `npm run staging:seed-users -- --apply`: explicitly authorized maintenance write. No automatic retry.

Do not execute either command against staging until separately approved. This implementation task only tests disposable local databases.

## Connection and safety boundary

The operator supplies DATABASE_URL temporarily in their own terminal from a securely held owner External URL; never paste credentials into chat, Git or command arguments/history. Do not change Render runtime DATABASE_URL. The CLI forces sslmode=verify-full, removes ambiguous ssl/uselibpqcompat URL overrides, rejects NODE_TLS_REJECT_UNAUTHORIZED=0, and never logs the connection string or raw errors. TLS certificate/hostname validation must succeed; the transaction independently requires SSL=true.

The database must be exactly telegram_ops_staging. The connected user must own the database and all 11 inspected seed/dependency tables; telegram_app is rejected. Migrations 001–006 and SHA-256 checksums must exactly match repository files. The existing active local:staging-admin credential must have a global Super Admin role with system.manage. Its existence is a prerequisite, not an authentication of the operator: owner credentials authorize this maintenance action, and audit notes identify the maintenance CLI.

Brand/Bot must exactly match the first seed constants (including disabled Bot and unconfigured synthetic Secret references). Missing entities are errors, never created. Both referenced Secret environment variables must be absent. No runtime API or security policy is changed.

## Fixed fixtures

| User | Telegram ID (string) | Username | Telegram language | Status | Events | Balance |
|---|---|---|---|---|---|---|
| A | 9007199254740901 | staging-test-user-a | zh-CN | active | +1000 | 1000 |
| B | 9007199254740902 | staging-test-user-b | pt-BR | active | +500, -120 | 380 |
| C | 9007199254740903 | staging-test-user-c | en | disabled | none | API reports 0; no account |

first_name is Staging Test User A/B/C. last_name, preferred_language and first_started_at are NULL; no real /start is simulated. Internal UUIDs and referral codes are stable in src/staging-users-seed.ts. These IDs are synthetic, not sampled from real accounts; positive numeric values are not a Telegram-reserved test namespace. Never use them to contact Telegram. The Bot stays disabled and has no credentials.

Bot supported_languages remains [zh-CN]; B/C retain their raw Telegram language for filtering, while resolved delivery language falls back to zh-CN. No message is sent.

## Transaction, idempotency and audit

All writes occur in one transaction, protected by the same transaction advisory lock (741092,1) as phase one. Apply locks Brand then Bot and rechecks scope. Fixed users must match every managed field; IDs/codes/names cannot silently adopt other data. Existing seed objects require matching audit records. Conflicts abort, with no overwrite, repair, deletion or partial commit.

postPoints() creates all three events using source/businessType staging_seed, stable versioned businessId/idempotencyKey, and note synthetic staging test data. No manual ledger insertion or direct balance update. BEFORE/AFTER ledger triggers and immutable constraints remain enabled. B's debit is a synthetic consumption, not a redemption. Only A→B is created, with bound/pending status and A's ref_ parameter; no reward. Composite foreign keys, uniqueness and immutable binding constraints remain in force.

Before commit, A=1000, B=380, C has no account, and each user's ledger sum must match. Unrelated events/balances or altered referral/profile state are conflicts, never automatically reset. Existing audit markers without matching data are also conflicts. The fixed staging_seed business type is reserved for this fixture set in this Bot.

First complete apply creates 3 users, 2 accounts, 3 ledger entries, 1 referral and 8 audits (3 users, 3 point events, 1 referral, 1 maintenance marker). createdObjects counts the 8 audited objects, not total physical rows. Repeat apply creates zero rows and zero audits. created_at/last_interaction_at defaults are not refreshed on reuse. Future UI changes may intentionally make reruns fail; do not alter immutable history to force a rerun.

## Retention and tests

These are permanent staging synthetic fixtures. No cleanup/reset command exists. Never DELETE ledger/referrals, TRUNCATE tables, disable triggers or reset balances. Any future compensation must be a new authorized ledger event. A full staging rebuild requires a separate reviewed operation.

Tests use PGlite or disposable PostgreSQL databases selected only by TEST_DATABASE_URL. Test-only adapters substitute external identity/TLS metadata so these fixtures cannot be confused with a real staging connection; production code has no bypass. PostgreSQL tests use real triggers, transactions and multiple independent pool connections for lock/rollback/idempotency acceptance. The external Render TLS handshake is not exercised by this test suite.

## Implementation acceptance

Local verification used PostgreSQL 17.11, UTC, with migration replay before the parallel test suite (same ordering as CI): 204 backend tests passed, including all 28 new users-seed cases and the two-connection concurrent apply case. PGlite baseline: 189 passed, 15 PostgreSQL-only cases skipped. Existing frontend: 67 component tests and 8 browser tests passed. Backend/frontend builds and repository secret scan passed. Only disposable local fixtures were written; this does not certify any Render staging execution or TLS handshake.
