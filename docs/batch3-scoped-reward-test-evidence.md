# Batch 3 scoped referral reward test evidence

- Branch: `codex/batch3-reward-allowlist`
- Base: `5c94d8ce9051231aaa47fce19c5b11db522e4460`
- PostgreSQL 17 targeted acceptance: 23 passed, 0 failed, 0 skipped.
- PGlite targeted regression: 37 passed, 0 failed, 1 skipped. The skipped
  multi-connection case passed in PostgreSQL 17.
- Frontend Vitest (invite, Mini, recovery and i18n): 31 passed.
- Invite Admin browser E2E: 2 passed.
- Backend TypeScript build: passed.
- Frontend TypeScript/Vite build: passed; bundle scan 0 findings.
- Secret scan: 248 candidate files, 0 findings.

Verified behavior includes exact Brand/Bot/Platform matching, missing/empty/
invalid configuration failing closed, automatic verified-UID and manual/internal
entry gating, no history backfill, 50/20 Points, five-invitation cap, cross-Bot
permanent UID de-duplication, concurrent idempotency, Point Ledger/Lots balance,
and transaction rollback on Point write failure.

