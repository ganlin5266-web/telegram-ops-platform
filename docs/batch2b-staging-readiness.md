# Batch 2B Staging readiness

Reviewed application base: `e48eae0dbc765d92d8c23b38cd95c1c423a1bb6e`.
Migration 015 has not been applied to Staging, no Render secret was changed, no
application was deployed, and no redemption code was imported.

## Current read-only Staging baseline

- Database: `telegram_ops_staging`, PostgreSQL 17.11, strict TLS.
- Migrations 001–014 match the repository exactly; Migration 015 is absent.
- Runtime role has schema usage and the expected DML grants, but no schema
  create, DELETE, TRUNCATE, or direct `schema_migrations` read capability.
- Points: account balance 2640, Ledger 2640, Lot remaining 2640; zero account or
  lot mismatches and no negative lot.
- Growth: account balance 1205 and Ledger 1205; zero mismatches.
- Existing redemptions and redemption-code inventory: zero rows.
- Member, Identity, P4, P5-B, Referral, RBAC, and Audit counts were captured in
  the encrypted backup receipt. The read-only check made zero writes.

## Backup and recovery evidence

- Pre-Migration-015 backup ID:
  `telegram-ops-staging-pre015-20261019T150135Z-7e1a3b83`.
- Encrypted size: 430512 bytes.
- Encrypted SHA-256:
  `e3c122c55d30ff3742afec49e63bd9f908983d01839a9eb60e4a68d8d494e27b`.
- `pg_dump` custom archive, encrypted with AES-256-CBC/PBKDF2 in the restricted
  local backup store. The key and archive are outside Git.
- An isolated PostgreSQL 17 restore reproduced migrations, catalog, business
  counts, Points, and Growth exactly. The source database had zero writes.
- Render Recovery currently offers a three-day point-in-time restore window and
  a logical export action. No restore or export was triggered by this review.

## Migration 015 compatibility

Migration 015 is additive. It extends the legacy redemption tables with nullable
V2 fields, creates one inventory-batch table, and adds three RBAC permissions.
V2 checks and unique indexes apply only to rows with a platform/batch scope, so
legacy rows remain valid. The migration creates no rules, codes, redemptions,
Points, Lots, or Growth records and starts no worker or historical scan.

After Migration 015, apply only the reviewed runtime grants. They allow rule and
batch inserts plus narrow lifecycle updates. The runtime role cannot update
ciphertext, authentication tags, fingerprints, scope, batch, key version, or
expiry; it also cannot delete or truncate inventory. The grant script first
revokes the legacy table-wide `redemption_codes` UPDATE privilege because a new
column-level grant does not implicitly narrow an existing grant.

## Key configuration and rotation

Server-only Render secrets must provide a permanent fingerprint key, a JSON
version-to-key map, and an active version. Keep every key referenced by stored
inventory. Add a new key before switching the active label; never replace or
reuse a version. Roll back by restoring the prior active label while retaining
both keys. The API validates the complete configuration at startup and never
returns or logs key material. Frontend and bundle configuration contain no key.

## Approved-order proposal

1. Reconfirm the backup receipt if execution is delayed or business counts have
   materially changed.
2. In one Owner transaction, apply Migration 015 and the reviewed runtime
   grants; verify checksums, catalog, grants, and unchanged ledgers.
3. Add the initial keyring, active label, and permanent fingerprint key to the
   API service only. Keep `BATCH2A_REFERRAL_REWARDS_ENABLED=false`.
4. Deploy the reviewed API commit; verify SHA, health/readiness, RBAC, empty
   inventory, and secret-free failure behavior before any import.
5. Deploy the matching Frontend commit and verify the Admin rule/inventory flow.
6. Import no real codes until a separate approval and post-deploy acceptance.

The application rollback target is the currently accepted API/Frontend release.
Migration 015 should remain in place because it is additive; use a forward fix
instead of destructive DDL rollback. Before any inventory import, application
rollback leaves all new tables empty. During later key rotation, retain both key
versions, so either active label can be restored without losing decryption.
