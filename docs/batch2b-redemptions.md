# Batch 2B inventory and fixed-tier handover

This branch implements only the frozen Batch 2B rule and inventory boundary. It does not deploy or execute Migration 015.

Implemented:

- Platform-bound fixed tiers with Points cost, face value, currency, effective window, draft/publish/disable lifecycle, and immutable published history.
- Encrypted code import using AES-256-GCM plus a separately keyed HMAC fingerprint.
- All-or-nothing batch validation, same-platform code deduplication across Bots, idempotent same-batch replay, and imported/rejected result records.
- Inventory totals for available, expired, disabled, assigned, and claimed states. Batch 2B itself never assigns or claims a code.
- Scoped Admin APIs, separate read/rule/inventory permissions, Super Admin bindings, and secret-free audit records.
- Admin UI for fixed-tier preview/create/publish/disable, encrypted batch import,
  inventory state counts, and safe import results. Raw codes exist only in the
  import request and are cleared after the server responds; they never appear in
  ordinary lists, batch history, audit payloads, or exports.

Key management:

- `REDEMPTION_CODE_ENCRYPTION_KEYS` is a server-only JSON object mapping an
  immutable version label to each 32-byte base64 AES key.
  `REDEMPTION_CODE_ACTIVE_KEY_VERSION` selects the key for new imports. Stored
  `code_key_version` selects the matching old key during decryption, so rotating
  the active key does not make existing inventory unreadable.
- `REDEMPTION_CODE_FINGERPRINT_KEY` is an independent 32-byte base64 secret and
  remains stable across encryption rotations. This preserves same-platform
  duplicate detection. Changing it requires a separately designed data
  migration and is outside Batch 2B.
- Partial, malformed, ambiguous, or missing-active-key configuration fails
  startup without printing key material. Completely absent configuration
  disables imports with a safe 503. Legacy single-key variables remain accepted
  for a controlled transition but cannot be mixed with the keyring variables.
- Rotation order: add the new version while retaining every referenced old
  version; deploy and verify old-code decryption; switch only the active version;
  verify new imports record it. Remove an old key only after a read-only query
  proves no inventory row references that version. Roll back by restoring the
  prior active label while retaining both keys.
- The fingerprint key is a permanent deduplication identity and must remain
  stable. Key values belong only in Render secret environment variables or an
  equivalent secret manager; they never enter Git, logs, audits, API responses,
  browser bundles, or Admin UI.
- Runtime grants allow only code state/assignment transitions. Ciphertext,
  authentication tag, fingerprint, scope, batch, key version, and expiry cannot
  be updated by the runtime role.

Timezone boundary:

- Batch 2B does not make a business-day decision. Rule windows are explicit
  `date` values and inventory expiry is an absolute `timestamptz` supplied with
  an explicit offset. Platform-local daily redemption limits remain Batch 2C.

Explicitly excluded:

- Mini redemption APIs.
- Points debit or refund.
- Code assignment, claim, re-display, or gaming-platform redemption.
- Redemption review workflow.

Those operations belong to Batch 2C. Migration, runtime grants, vault keys, rule publication, and inventory import each require separate Staging approval.
