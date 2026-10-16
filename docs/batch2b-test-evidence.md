# Batch 2B local test evidence

- Branch: `codex/batch2b-inventory`
- Base: `fdd4e24d240b57a0b05925ef47be7d0fd8883e39`
- Scope: fixed tiers, encrypted inventory, batch validation/results, status counts, RBAC, audit, and concurrency.
- Online effects: none. Migration 015 ran only in isolated local databases. No deployment, real code import, Points write, or Staging change occurred.

## Results

- Targeted PGlite Batch 2B: 7 passed, 0 failed, 0 skipped.
- Targeted PostgreSQL 17.11 multi-connection: 2 passed, 0 failed, 0 skipped.
- Full PGlite regression: 446 passed, 0 failed, 26 PostgreSQL-only skipped.
- Full PostgreSQL 17.11 regression with Migration 001–015 replay: 497 passed, 0 failed, 0 skipped.
- TypeScript `--noEmit` and backend build: passed.
- Secret scan: 231 candidate files, 0 findings.

The first full PostgreSQL run inherited the host's Asia/Yerevan database timezone and failed 21 pre-existing fixed-date Dashboard/query assertions. A fresh isolated database with the CI-equivalent UTC database timezone passed 497/497 without changing those tests or their business code.

The tests prove same-platform duplicate rejection across Bots, same-batch replay, serialized rule versions, scoped inventory permissions, encrypted-at-rest codes, secret-free responses/audits, and zero writes to redemptions, Points Ledger/Lots, or Growth.
