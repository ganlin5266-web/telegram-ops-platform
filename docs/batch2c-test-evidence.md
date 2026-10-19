# Batch 2C local acceptance evidence

Baseline: `28390e6580039062c060ac13e30fb37d25ef9e07`. Branch: `codex/batch2c-redemption-flow`.

The isolated PostgreSQL 17.11 suite runs with server timezone UTC and replays migrations 001–016. Batch 2C's concurrency test creates its own disposable database so it cannot contaminate other tests. It proves ten simultaneous requests produce one debit and one allocation, cross-platform isolation, Point Account/Ledger/Lot equality after debit/refund, and two allocation rows for two debits.

Final local results:

- PGlite: 454 passed, 29 PostgreSQL-only skipped, 0 failed (483 total).
- PostgreSQL 17: 508 passed, 0 skipped, 0 failed.
- Frontend Vitest: 228 passed, 0 failed.
- Proxy: 45 passed, 0 failed.
- Browser E2E: 20 passed, 0 failed, including Mini create/claim display and Admin manual-review behavior.
- Backend and frontend builds passed; bundle scan examined 11 files with 0 findings.
- Secret scan examined 244 candidate files with 0 findings.

The tests use only synthetic local data. No Staging migration, inventory import, Points mutation, configuration change, or deployment is performed.
