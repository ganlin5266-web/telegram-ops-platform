# Batch 1 backend test evidence

Validation date: 2026-10-09.

Baseline: `fc9036dc113e0d2e4605c586b194ea4f39773236`.

## Targeted contract validation

| Environment | Result |
| --- | --- |
| PGlite Batch 1 route/service suite | 12 passed, 0 failed, 0 skipped |
| PostgreSQL 17 Batch 1 route/service suite | 12 passed, 0 failed, 0 skipped |
| PostgreSQL 17 Member/Growth regression affected by dated fixture | 25 passed, 0 failed, 0 skipped |

The Batch 1 suite covers route authorization, independent pending permissions,
Brand/Bot isolation, exact Decimal arithmetic, Member deduplication within a
period and across platforms, multi-currency behavior, current revisions,
historical attribution after UID revoke and fact revision, missing withdrawal,
deposit-count contradictions, unknown/incomplete/open periods, and query
failure behavior.

## Full validation

| Check | Result |
| --- | --- |
| TypeScript no-emit | passed |
| PGlite full suite | 457 total: 434 passed, 0 failed, 23 PG17-only skipped |
| PostgreSQL 17 migration replay | 001–013 applied twice successfully on a fresh database |
| PostgreSQL 17 full suite | 482 passed, 0 failed, 0 skipped |
| Backend build | passed (`tsc`) |
| Secret scan | 191 candidate files, 0 findings |
| Diff whitespace check | passed |

PostgreSQL validation uses a disposable local PostgreSQL 17 database, UTC for
the database and Node process, and the repository's real multi-connection tests.
No online database is accessed.

## Earlier diagnostic run

The first UTC PG17 run reported 478 passed and 3 failed. All 12 new Batch 1
tests passed. The three failures were pre-existing Member/Growth P4 fixtures
whose identity `verified_at` used the real database clock while the fact dates
were fixed to 2026-10-01. The test-only fixture was made clock-relative; the
affected suite then passed 25/25. No production Growth behavior was changed.

```text
PGLITE_FINAL=434_passed_0_failed_23_skipped
PG17_FINAL=482_passed_0_failed_0_skipped
BUILD_FINAL=passed
SECRET_SCAN_FINAL=191_files_0_findings
```
