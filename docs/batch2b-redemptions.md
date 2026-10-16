# Batch 2B inventory and fixed-tier handover

This branch implements only the frozen Batch 2B rule and inventory boundary. It does not deploy or execute Migration 015.

Implemented:

- Platform-bound fixed tiers with Points cost, face value, currency, effective window, draft/publish/disable lifecycle, and immutable published history.
- Encrypted code import using AES-256-GCM plus a separately keyed HMAC fingerprint.
- All-or-nothing batch validation, same-platform code deduplication across Bots, idempotent same-batch replay, and imported/rejected result records.
- Inventory totals for available, expired, disabled, assigned, and claimed states. Batch 2B itself never assigns or claims a code.
- Scoped Admin APIs, separate read/rule/inventory permissions, Super Admin bindings, and secret-free audit records.

Explicitly excluded:

- Mini redemption APIs.
- Points debit or refund.
- Code assignment, claim, re-display, or gaming-platform redemption.
- Redemption review workflow.

Those operations belong to Batch 2C. Migration, runtime grants, vault keys, rule publication, and inventory import each require separate Staging approval.
