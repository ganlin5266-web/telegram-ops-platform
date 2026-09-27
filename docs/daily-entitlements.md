# P5-B Daily Member Entitlements

Status: implementation under validation. Not approved for first Staging rule publication.

This module calculates only `member_daily_status`. It does not call points, lots, redemption,
referral, Telegram or opportunity services. The Mini App is unchanged (`ADMIN_ONLY`).

## Dates and rules

D is P4's `business_date`; the entitlement date is calendar D+1, never an elapsed 24-hour offset.
The source timezone comes from Platform; entitlement timezone is explicit in each version.
Data cutoff defaults in the form to 12:00 source-local time and is an SLA, not a wait-until gate.
Versions have bounded inclusive effective dates (maximum 366 days), so publication validates every
local cutoff and rejects ambiguous/nonexistent DST times and cutoffs outside the entitlement day.
This explicit upper bound avoids an unvalidated unlimited future timezone window.

Only `deposit_amount` is approved, mapped to P4's `deposit` NUMERIC(28,6). Rule comparison uses
six-decimal BigInt units. There is no conversion, scaling, rounding or foreign exchange in P5-B.
Tiers have stable keys and strictly increasing thresholds. Match only the highest threshold.
A rule explicitly approves the immutable Mapping definition of an existing Platform import batch.
A new definition must be reviewed through a new rule version; merely reusing a canonical field
name does not grant compatibility. `bet_amount` and production thresholds remain NOT_APPROVED.

Missing data, NULL, unavailable fields and incomplete/unknown completeness remain pending.
Explicit complete zero can be ineligible. Currency, identity or data conflicts require review.
Before cutoff, missing facts mean waiting_for_data; after cutoff they remain pending/stale_data.
SLA findings are unique by subject and kind; resolution preserves the original warning.

## History and execution

The stable subject is Brand/Bot/User/Platform/type/date. Revisions are append-only. Composite FKs
protect scope, current pointer ownership and supersedes ownership. Database triggers enforce
sequence, immutability and current-source checks. Input fingerprints include revision evidence,
identity verification snapshot, rule, metric, quality and date context. Same input is a no-op;
new evidence in the same tier remains a new revision.

P3 identity review and P4 activation enqueue persistent tasks in their existing transaction only
when DAILY_ENTITLEMENTS_ENABLED=true. When false, these hooks do nothing. P5-B does not alter their
business rows. Explicit range scheduling includes users without facts, plus existing subjects.
Past unassessed dates require explicit administrator scheduling; no unlimited historical scan.

The runner claims a bounded number of tasks with SKIP LOCKED, a lease and ownership token. Each
subject is evaluated in a short independent transaction using current inputs. Evaluation shares
the existing Platform row lock used by P3/P4, so an old task cannot commit stale source data over a
new result. This serializes short evaluations within a Platform; it is a deliberate first-version
throughput tradeoff. No transaction locks an entire population for evaluation.

There is no new paid Cron, background timer or deployment startup execution. An authorized admin
uses a controlled runner endpoint. A reliable external scheduling cadence must be approved and
configured before unattended cutoff guarantees are claimed. Durable tasks survive process restart,
but persistence alone does not prove timely execution.

## Administrator APIs

All routes are inside the existing administrator authentication/CSRF boundary:
`/v1/brands/:brandId/bots/:botId/entitlements`.

- GET /rules; POST /rules; POST /rules/preview
- POST /rules/:id/publish and /retire with explicit confirmation
- GET /daily, /daily/:id, /sla, /tasks
- POST /recalculate with Platform/date and reason (optional one user)
- POST /tasks/run with a bounded limit

Reading, financial explanation, rule management and recalculation use separate permissions.
Lists mask UID. Sensitive canonical values and snapshots require entitlements.explain_sensitive.
Raw source evidence remains behind the existing P4 permission boundary. No Mini API is added.

## Deployment gate

Migration 012 adds only qualification schema and its permissions; 001–011 are unchanged.
DAILY_ENTITLEMENTS_ENABLED is independent from POINT_LOTS_ENABLED and defaults false.
The first FUN66_STAGING rule (BRL, >=100/500/1000) requires explicit user approval before publication.
Until then, only Draft and synthetic Preview are permitted in Staging. Local disposable tests can
publish fixtures; they do not authorize a Staging publication.

Staging Schema execution requires strict TLS, expected database identity, independent runtime
verification, checksum and business fingerprint preflight. No P5-A balances may change.
Rollback is flag-off and forward repair, never deleting rule/revision history or reverting P4 facts.
