# P5-A: point expiry and lot accounting

This is the point-expiry foundation only. It does not implement daily entitlements,
opportunities, games, participation, platform qualification or rewards.

## Release gates

1. Apply schema 011 and its minimum grants, with `POINT_LOTS_ENABLED` unset/false.
   The schema migration creates no opening lots, credits or balance changes.
2. Complete independent runtime LOGIN tests, health checks and read-only legacy
   preflight. Obtain explicit user approval before **any staging cutover**.
3. Run owner-controlled `cutoverBot` inside a transaction per approved scope.
   Recheck balances and ledger sums under Bot → Account locks. Each positive
   account gets one permanent opening lot, no new ledger. Empty scopes still get
   a cutover marker so future credits cannot bypass lots. Verify independently.
4. Obtain separate approval before enabling `POINT_LOTS_ENABLED=true`.
5. Only then publish explicitly approved STAGING TEST ONLY policies and run the
   synthetic acceptance workflow. Production refund compensation days remain
   **NOT_APPROVED**. Seven days is a test value, not a default.

No API, startup hook or seed invokes cutover. Runtime cannot insert openings or
cutover markers. Do not run the old staging seed again to test P5-A.

## Accounting

`postPoints` remains the sole application ledger writer. Every post-cutover
positive ledger has matching lots; every negative ledger has matching immutable
allocations. Deferred database guards verify sums at commit, including direct
runtime inserts. Existing ledger triggers remain the balance authority.

Available = remaining on lots whose exclusive expiry is still in the future, or
permanent. Book balance may temporarily exceed available when expiry is pending.
An absent account remains absent; reads never create accounts.

FEFO sorts expiry ascending (permanent last), then granted time and ID. Only lots
actually consumed are row-locked. Current nonzero lots use a partial index; old
exhausted lots do not enter the available-balance aggregate.

Source policy resolution: explicit approved version → exact source → explicit
`*` default. Missing policy rejects the credit. Published versions are immutable;
changes create new versions. Drafts are immutable except one-way publication.
To correct a draft, copy its inputs into a new version. `rolling_days` means
N × 24 hours. Fixed date input is converted by PostgreSQL using its IANA timezone
to the next local midnight, exclusive. The UI displays the last inclusive date.

## Refunds

The existing redemption state machine is unchanged. An assigned code still
requires manual reconciliation. Only full refunds are supported; partial refunds
return `unsupported_partial_refund`.

Each original allocation creates one compensation lot. Permanent stays
permanent. Finite expiry is max(original expiry, refund time + configured minimum)
when a minimum exists. Without a minimum, an unexpired original expiry is retained;
an already-expired source rejects with `refund_review_required`.

The refund minimum is snapshotted from the original grant's policy version. New
policy versions do not silently change old lots. Original allocations are uniquely
refundable; repeated callbacks do not generate another credit.

Pre-cutover orders have no fabricated allocations. They require an explicitly
published `legacy_refund` source policy; the `*` default is insufficient.

## Maintenance and reconciliation

`expirePointsBatch` scans at most 100 due lots (default 50), then settles each in a
separate transaction with Bot → Account → Lot locks. Stable `expiry:<lot-id>` keys
and database constraints permit retry and competing workers. No zero ledger is
created. The durable outstanding queue is the due-lot index, not process memory.

`npm run points:maintenance` (or `-- --preflight`) is Staging-only, defaults to a read-only transaction, verifies all migration checksums and reports each Bot scope. It does not perform cutover. After separate enable approval, `npm run points:maintenance -- --expire` runs one bounded batch with an independent `telegram_app` connection. Supply DATABASE_URL only through an approved secret channel; errors never print it. A failed batch logs only a safe classification and the remaining due lots can be retried.

No scheduler is provisioned by this release. The inspected Render API service is
Free and can sleep; it cannot be treated as a reliable timer. Expired lots remain
unspendable without any worker. Connecting a Cron/worker is a separate deployment
decision; no new paid infrastructure is authorized.

Read-only reconciliation compares Account, ledger SUM and lot remaining SUM. It
never auto-balances mismatches. Every managed write reconciles under the account
lock and rejects mismatch. Future optimizations must retain commit-time guards.

## Rollback

Before cutover, the false flag preserves the existing point path. After cutover,
the false flag refuses new writes with `point_writes_paused`; reads still compute
available points from lots. `POINT_WRITES_PAUSED=true` is an explicit maintenance
mode. Do not deploy a pre-P5 binary after cutover: database guards reject its
ledger-only inserts, but it cannot provide proper available-balance presentation.

Keep schema/history. Stop jobs and writes; forward-fix using a schema-compatible
version. Never delete ledger, allocation, lot, opening or audit records.

## Call-site inventory

- Admin adjustment: positive requires resolved policy; negative uses FEFO.
- Redemption reserve: unified negative post plus allocations, same transaction.
- Redemption failure: original debit reference, compensation lots, atomic status.
- Staging users seed: existing writes still call postPoints; after enabling, it
  must not be used to bypass explicit policies/cutover. This release never reruns it.
- Activity reward tables: no new reward executor is introduced.
- Mini/admin reads: Mini gets only own available balance and 7×24h expiry summary;
  administrator can inspect book/available/pending/permanent balances and lineage.

## Logging

No connection URL, credential, full UID, initData, Cookie or request-body logging.
Audit includes safe IDs, action, amounts and reason. Automatic actions use null
admin and a system/job reference, never an invented administrator identity.
