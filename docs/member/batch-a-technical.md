# Batch A Member/Growth technical contract

## Structure
Migration013 creates 10 tables: member_rule_versions, members, member_user_links, growth_accounts, growth_sources, growth_evaluation_revisions, growth_daily_reconciliations, growth_ledger, member_level_history, growth_evaluation_tasks.
Rule heads and individual tier tables are folded into immutable typed JSON version rows; level/growth/platform kinds share version infrastructure but remain separate rule purposes. Audit reuses audit_logs. No independent snapshot table or event bus. Growth tasks are separate from P5B economic task semantics.

## Invariants and concurrency
Brand member uniqueness and composite user-link foreign keys prevent cross-scope linking. Lock growth account before source/reconciliation changes. P4-related evaluations first use the existing Platform lock, then account lock. Shared input reads current P3/P4 evidence only; existing P5B decisions and mapping comparison remain unchanged.
Account is trigger-derived from append-only ledger. Runtime lacks balance update, DELETE, TRUNCATE and DDL. UPDATE(member_id) enables row locks only; trigger forbids changing identity. Positive redistribution deltas precede negative ones in one transaction, followed by one final level calculation; transient intra-transaction totals never cause upgrades. Source business identity is unique independently of rule version; fingerprint is revision-specific. Same historical fingerprint cannot roll current source pointer back. New Fact revision with equal award produces evidence but no duplicate credit.

Unknown evidence keeps existing economic attribution until resolved; this is explicit provisional history, not a zero determination. Reconciliation stores allocation and underlying current evaluation IDs via its fingerprint and source links. Account insufficiency fails atomically with growth_correction_review_required; task records safe error and requires operator review.

## Source contracts
Platform consumes trusted P4 canonical numeric(28,6), approved mapping, immutable Fact revision and conflict evidence. No raw UID/amount in Mini responses or application logs. No historical attribution before member initialization or verified identity; partial identity/cutover day is excluded conservatively because a daily Fact cannot split ownership by hour.
Check-in server selects day, ignores client date. Internal confirmedGrowth takes a verifier executed inside the transaction; not exposed as an HTTP award endpoint. Task/referral producers must revalidate authoritative completion, stable Brand-level business key, occurrence time, and evidence ID. It does not invent a production referral qualification definition or task workflow.

## Tasks
Persisted queue, lease token, bounded attempts, latest-input reread, safe failure code, catch-up by original day. API process wakes worker every30s; DB is authoritative. Free Render sleep delays work; catch-up restores results, not wall-clock punctuality. No extra Render service created. Growth flag false bypasses queue hooks and worker entirely.

## API and scope
Admin /v1/brands/:brandId/members: status/list/detail/rules/preview/publish/cutover-preview/analytics/adjustments. Brand-level roles or global Super Admin required for shared economics. Existing Bot-scoped users.read can read associated summary only. Mini /member, /member/growth, /member/checkin use existing Mini principal, no caller-selected member/brand/user. Summary init only with flag enabled; no Points side effects.
Large adjustment confirmation >=500 is server-enforced, request-bound HMAC, 5minute lifetime, process-local secret; restart invalidates confirmation, never money. No persistent plaintext secret. Admin idempotency payload changes are rejected.

Analytics issued=grant positives, net=all signed entries, earners=distinct positive non-admin recipients. Corrections are not relabeled original issuance. History supplies period-end member/level state; levels never inferred from today's balance. Dates are inclusive UI business dates, converted to half-open instants for member/history aggregates.

## Tests and boundary
Use isolated PostgreSQL17 for schema/runtime/concurrency. Legacy P5B conflict fixture dates use controlled test clock. Do not claim Staging, Cutover or Mini real-client acceptance from local tests. No production economics authorization.
