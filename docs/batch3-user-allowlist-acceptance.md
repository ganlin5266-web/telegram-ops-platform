# Batch 3 user allowlist repair — 2026-10-28

Base: b1bb05144ddb37958a8b7ec7a21f13b4c10c6824 (production code parent
2548efa1b63e19c8c56ef21ed4b51d3b9aaab732). Branch:
`codex/batch3-reward-user-allowlist`.

Only referral-rewards production code changes. Each existing server allowlist
tuple now requires unique `userIds` (2–100 internal telegram_users UUIDs).
Both actual Referral parties must match, belong to the tuple's Brand/Bot, and
remain active. Evaluation fails closed before any reward/evidence/counter write.
Automatic verified-UID and permissioned manual evaluation use the same guard;
internal/retry calls cannot bypass it. No task scanner or historical replay added.
Inviter-only campaigns still require both users. No schema, runtime grant, Secret,
frontend, or new environment-variable change. Existing tuple-only values safely
disable rewards until separately approved user lists are configured.

Actual targeted validation:

| Check | Pass | Fail | Skip |
|---|---:|---:|---:|
| PostgreSQL 17 referral Lots/user-gate tests | 8 | 0 | 0 |
| PGlite referral gate/Lots/cap regression | 11 | 0 | 2 |
| Mini retention/Admin campaign components | 12 | 0 | 0 |
| Mini V1/Admin campaign browser E2E | 4 | 0 | 0 |

The two PGlite skips require independent connections and passed on PG17.
PG17 includes ten concurrent denied retries, authorized manual 50/20, single
reward under concurrency, Ledger/Lots reconciliation, failure rollback, same-tuple
excluded users at the real UID review hook, both-party gating, active-user checks,
RBAC and no automatic history replay. PGlite retains five rewarded/six qualified,
ten Ledger rows and cross-Bot permanent UID checks. Existing assertions retained;
fixtures updated to explicitly authorize both synthetic parties.
The first test run exposed an old tuple-only fixture; that fixture was corrected
without weakening the new fail-closed behavior. Final results above are reruns.

Backend TypeScript and frontend TypeScript/Vite build passed. Bundle and Secret
scans returned zero findings. UI tests use isolated test data, not real Telegram
redemption evidence. No prior full regression was rerun locally.

Deployment preflight: both Render services bind main with Auto-Deploy disabled;
ordinary feature-branch push cannot deploy. API rollback is
2548efa1b63e19c8c56ef21ed4b51d3b9aaab732 / dep-dbfrtruk1f9s7387f2qg.
Frontend stays at 72d8fba57fa5eeec8ae8f64498b564eb22bbbdee /
dep-dbfqfo0ae00c739llqbg. Deploy API only, master false and allowlist unset.

Next controlled acceptance requires a separate approval to configure exactly the
seven approved Synthetic user UUIDs, enable rewards temporarily, and perform the
100-Point synthetic redemption. Exclude the control identity and two non-Synthetic
accounts. A real Telegram account cannot be treated as one of the reserved
Synthetic identities: any real-account test funding/identity inclusion requires
explicit separate authorization. Recheck membership and record all writes first.
Verify assigned/claimed, copy, original-code recovery and order history, then
disable master and clear the list. No such writes or configuration are authorized
or performed in this repair task.
