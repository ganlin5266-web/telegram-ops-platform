# Batch 2C fixed redemption flow

Batch 2C reuses the published fixed tiers and encrypted inventory from Batch 2B. It does not check platform deposits, wagering, code redemption, or bonus settlement.

## Mini API

All routes require the existing Mini bearer session. POST routes also require the existing Mini CSRF/recovery protection.

| Method | Path                                   | Behavior                                                                                                                                   |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/v1/mini/redemption-tiers`            | Published effective tiers in the current Brand/Bot, with safe inventory counts and optional HTTPS platform link.                           |
| POST   | `/v1/mini/redemption-orders`           | Requires `Idempotency-Key` and `{ruleId}`. Atomically reserves the daily slot, debits Points through `postPoints()`, and assigns one code. |
| POST   | `/v1/mini/redemption-orders/:id/claim` | Marks the assigned code claimed and reveals it only to its owning Mini user.                                                               |
| GET    | `/v1/mini/redemption-orders/:id/code`  | Re-displays the same assigned code after interruption without another debit or allocation.                                                 |

Each platform uses its own `business_date`. A member may have one non-refunded order per platform/business date and may spend at most 300 Points on that order. Different Bots linked to the same Member cannot bypass this rule.

## Admin API

`GET /v1/brands/:brandId/bots/:botId/redemptions` returns safe order metadata without code ciphertext, fingerprint, secret reference, or plaintext. `POST .../redemptions/:id/review` requires `redemptions.review`. Platform rejection can only enter `review_required`; it cannot trigger an automatic refund or replacement. Only an explicit `confirmed_internal_failure` refund posts a compensating Points ledger entry and releases the daily slot.

`POST .../platforms/:platformId/redemption-url` requires `platforms.manage`, accepts only HTTPS (or null), and audits only whether a link is configured.

## Migration 016

Migration 016 extends existing tables; it adds no new business table or permission. It adds platform/member/business-date evidence to orders, `code_assigned`/`code_claimed`/`review_required`/`refunded` states, claimed timestamp, the daily uniqueness constraint, and an optional HTTPS platform URL. Runtime writes are column-scoped. Staging Migration 016 is outside this branch's local acceptance.
