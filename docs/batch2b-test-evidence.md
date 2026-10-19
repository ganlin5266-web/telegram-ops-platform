# Batch 2B local test and Admin integration evidence

- Reviewed backend and Admin UI commit: `e48eae0dbc765d92d8c23b38cd95c1c423a1bb6e`
- Readiness branch: `codex/batch2b-key-rotation`
- Base: `fdd4e24d240b57a0b05925ef47be7d0fd8883e39`
- Scope: fixed tiers, encrypted inventory, batch validation/results, status counts, RBAC, audit, and concurrency.
- Online effects: none. Migration 015 ran only in isolated local databases. No deployment, real code import, Points write, or Staging change occurred.

## Admin UI integration and final review

- Full frontend Vitest: 223 passed, 0 failed, 0 skipped (20 files).
- Browser E2E: 20 passed, 0 failed, including 2 new inventory cases.
- Proxy regression: 45 passed, 0 failed.
- TypeScript and production build: passed; bundle scan: 11 files, 0 findings.
- Repository secret scan: 235 candidate files, 0 findings.
- Changed-file Prettier check: passed. The repository-wide check still reports
  three pre-existing files (`Dashboard.tsx`, `metrics.ts`, and `Spaces.tsx`);
  this review did not reformat unrelated code.
- Full PGlite: 448 passed, 0 failed, 28 PostgreSQL-only skipped.
- Full PostgreSQL 17.11 with CI-equivalent `TZ=UTC` and database timezone UTC:
  501 passed, 0 failed, 0 skipped; Migration 001–015 replayed.
- Batch 2B PostgreSQL 17.11 targeted run under the host/database
  `Asia/Yerevan` timezone: 4 passed, 0 failed, including cross-Bot import
  serialization, restricted runtime grants, and stored-key-version decryption
  after rotating the active encryption key.

The first non-UTC full run produced 21 failures in pre-existing date-boundary
assertions because the local PostgreSQL session inherited `Asia/Yerevan`.
Re-running with the CI contract (`TZ=UTC` and PostgreSQL `timezone=UTC`) passed
501/501. Batch 2B rule windows are SQL `date` values, code expiry is an absolute
`timestamptz`, and this batch performs no platform-local daily-limit decision,
so the inherited test-session timezone does not change Batch 2B business
behavior.

The review found one real grant issue: the legacy table-wide runtime UPDATE on
`redemption_codes` would have covered the new encrypted columns. It is now
restricted to `status`, `redemption_id`, and `assigned_at`. PostgreSQL verifies
that state transitions work while ciphertext/fingerprint mutation, DELETE, and
TRUNCATE remain denied.

The readiness review found one additional release blocker: the original vault
could decrypt only the currently active encryption key. It now accepts a
versioned server-side keyring, encrypts with the active version, and resolves
each stored `code_key_version` when decrypting. Tests cover old-code recovery
after rotation, new-key writes, stable duplicate fingerprints, missing old-key
failure, malformed configuration, and rejection of ambiguous legacy/keyring
configuration. No key value is logged or included in browser bundles.

The tests prove same-platform duplicate rejection across Bots, same-batch replay, serialized rule versions, scoped inventory permissions, encrypted-at-rest codes, secret-free responses/audits, and zero writes to redemptions, Points Ledger/Lots, or Growth.
