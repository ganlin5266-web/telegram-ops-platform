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

- `REDEMPTION_CODE_ENCRYPTION_KEY` and `REDEMPTION_CODE_FINGERPRINT_KEY` are
  independent 32-byte base64 secrets. Partial or malformed configuration fails
  startup; completely absent configuration disables imports with a safe 503.
- The fingerprint key is a permanent deduplication identity and must remain
  stable. Encryption-key rotation needs a versioned key ring before Batch 2C can
  decrypt older inventory; this branch does not rotate keys or expose codes.
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
