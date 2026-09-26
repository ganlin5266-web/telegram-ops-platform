# P4 Platform daily facts

P4 imports source-reported facts. It does not grant points, rewards, eligibility, entitlement, redemptions or marketing. P1–P3 boundaries remain intact. No Telegram network request is part of this pipeline.

## Storage and ownership

Migration 009 adds `platform_accounts`, `platform_import_batches`, `platform_import_evidence`, `platform_user_daily_facts`, `platform_user_daily_fact_revisions`. Migrations 001–008 are unchanged.

An immutable account is identified by Brand + Platform + the P3 canonical UID. Daily facts have one stable subject per account/date and an atomic current revision pointer. Revisions and row evidence cannot be changed/deleted. Their composite FKs constrain Brand, Platform, date, batch, evidence and subject. A revision snapshots an already verified identity at activation, if any. The Mini summary requires that exact identity to still be verified and belong to the Session user/Bot/Brand. Rebinding never transfers old revisions to a new Telegram user. Unknown accounts are valid and do not create Telegram users. Historical association after later verification is deliberately not automatic; it needs a separately approved, audited policy/operation.

## Import contract

Admin routes under `/v1/brands/:brandId/bots/:botId/platform-data`:

- POST `/preflight` (upload + validation only)
- GET `/batches`, GET `/batches/:id`
- GET `/batches/:id/evidence/:evidenceId` (explicit raw evidence access)
- POST `/batches/:id/activate` with `{approveChanges:false}` (true only after explicit comparison review)
- GET `/facts`, GET `/facts/:id` (all revisions and source references)

Metadata explicitly supplies platformId, businessDate, timezone, currency, sourceType, filename, mapping, coverage, completeness, replacement, reason. `fileBase64` carries at most 2 MB of CSV/XLSX. Admin Browser Auth / CSRF / Origin are unchanged. The file's SHA256, metadata hash and scope hash are computed server-side. Source bytes are not retained: controlled raw row values + file digest + row number + row digest are durable evidence. Audit records IDs/actions, never filenames, UID, raw rows or values.

`businessDate` is the explicit export date, YYYY-MM-DD (2000–2100); never inferred. timezone/currency must match Platform configuration. Timestamps must be ISO text with explicit offset; native Excel date cells are rejected, rather than silently interpreted in the server timezone. Missing optional fields normalize to NULL, real zero remains zero. Amounts use a decimal point, no grouping/currency symbols/exponents, at most 22 integer + 6 fractional digits. No rounding: excess precision is rejected. BigInt normalizes amounts, PostgreSQL NUMERIC(28,6) stores them. Original cell text is retained; source_net is never replaced by calculated net. Comparison uses exact six-place arithmetic (tolerance 0 at accepted precision).

Explicit mapping keys: uid, tier, login_account, registered_at, login_time, channel, agent, deposit, deposit_count, gift, withdrawal, source_net, bet, payout, game_profit, first_deposit_date, first_deposit. Values are exact source column names. `uid` is required; omit unavailable optional keys. No fuzzy column matching. CSV must be UTF-8 and rectangular. XLSX must have one sheet, text/number cells, no formulas, hyperlinks, external links, macros or native date values. Limits: 1000 rows, 64 columns, 2000 chars/cell, 2 MB compressed input, 16 MB validated inflated content. A numeric Excel cell is limited to safe JS numeric range; use text for precision-sensitive source values. No float arithmetic is used for money. ZIP entries are checked with bounded inflation before ExcelJS parses the workbook.

Completeness defaults unknown; complete is an operator declaration, not proof inferred from upload. Coverage explicitly captures full/filtered and filter text. Batch states: rejected / ready / review_required / active / superseded. Fatal rows prevent the entire activation. Unknown UID or missing metrics/time and source-net mismatch are warnings. Duplicate canonical UID rows are fatal; never summed.

Identical file/Platform/date with identical metadata returns the existing batch, without repeated audit. Changed metadata for those same bytes is a conflict, not silently reinterpreted. Different files are compared against current values and completeness. Changed values require a declared same-scope replacement or explicit review. A preflight snapshots the current revision; activation fails `preflight_stale` if it changed. Changed scope is rejected. A full complete replacement cannot omit an existing account for that date (no implicit deletion or zeroing). Late complete data creates a new revision of the same subject. Equal values/completeness do not create another revision. Old batches are marked superseded only when no current facts reference them. Batch activation serializes on the Platform row and commits accounts, revisions, pointers, status and audit in one transaction.

Freshness reports whether an explicit date has a complete active batch. No automatic SLA alarm, entitlement, aggregation or source-priority fusion is implemented. Future API/Webhook/automation adapters must supply the same explicit metadata and normalized model; they are not enabled in P4.

## Permissions and privacy

`platform_data.read`, `.import`, `.activate` default only to Super Admin. As facts are Brand-wide (including unbound accounts), access requires a Brand-wide matching permission or global Super Admin; Bot-only roles cannot read other Bot/unbound accounts. UI platform selection additionally uses existing `platforms.read`.

Lists mask UID. Raw evidence requires import permission and an explicit detail action. It can contain source personal data and is not an ordinary list/log/audit. No public file URLs. Mini GET `/v1/mini/platform-data-status` returns only Platform ID, latest current linked fact business date, updated/waiting. It returns no UID, raw evidence, deposits, bets, profit, withdrawals or another user's data. An updated date does not imply complete data or an entitlement.

Runtime has SELECT/INSERT on new tables, only status/activation fields UPDATE on batches and current_revision_id UPDATE on facts. No DELETE/TRUNCATE/DDL, no change to ledger/balance/audit-history permissions.

## Staging acceptance and rollback

Use only FUN66_STAGING and synthetic files explicitly labeled STAGING SYNTHETIC. Explicit date 2026-09-26; one existing verified synthetic UID and one unknown synthetic account. Test preflight, activation, duplicate bytes and same-day replacement; expected stable facts 2, no duplicate current subject, versions traceable. Compare point_accounts=2, point_ledger=3, referrals=1, redemptions=0, redemption_codes=0 before/after. Do not connect to a real platform.

Pause deployment if schema or business baseline mismatches. Roll back API/frontend to the preceding compatible commit and retain additive schema/evidence. Do not delete batches/revisions/accounts or reverse business history. Data corrections use a new explicitly approved revision; no destructive cleanup. No P5 implementation.
