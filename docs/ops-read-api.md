# Batch 1 operations read API

This contract adds three read-only administrator endpoints under the existing
Brand and Bot scope:

```text
/v1/brands/:brandId/bots/:botId/ops
```

All endpoints use the existing administrator session, Origin/CSRF policy and
RBAC model. They run in a repeatable-read, read-only transaction, set a five
second database statement timeout and return `Cache-Control: no-store`.

## Metric envelope

Every dashboard value which can be unavailable uses this envelope:

```json
{
  "status": "ok | not_applicable | backend_pending | data_incomplete | forbidden",
  "value": "decimal string | integer | null",
  "currency": "BRL",
  "reason": "stable_safe_reason"
}
```

`currency` is returned only for an available money metric. `reason` is returned
for non-`ok` states. A query or database failure is an API error and is never
converted to `ok/0`.

## `GET /ops/platform-data-status`

Required permission: Brand-wide `platform_data.read`. A Bot-only grant is
rejected.

Returns each active platform's latest activated P4 business date and the
stored completeness state. `reviewRequired` is true while the platform has an
unresolved P4 review batch. Expected business date and SLA configuration are
outside Batch 1 and are explicitly reported as `backend_pending`.

```json
{
  "items": [
    {
      "platformId": "uuid",
      "code": "FUN66_STAGING",
      "displayName": "FUN66",
      "timezone": "America/Sao_Paulo",
      "currency": "BRL",
      "latestBusinessDate": "2026-09-28",
      "completeness": "complete | incomplete | unknown | conflicting | missing",
      "reviewRequired": false
    }
  ],
  "expectedBusinessDate": {
    "status": "backend_pending",
    "value": null,
    "reason": "expected_business_date_not_configured"
  }
}
```

## `GET /ops/private-performance`

Required permission: Brand-wide `platform_data.read`. A Bot-only grant is
rejected.

Query parameters:

- `period`: `day`, `week` or `month`.
- `date`: a real `YYYY-MM-DD` business date. A week is Monday through Sunday;
  a month is the full calendar month containing `date`.
- `platformId`: optional active platform UUID.

The range is applied directly to each platform's local `business_date`; it is
not converted through the server or browser timezone. A range containing the
platform's current local date or a future date is `period_open`.

```json
{
  "scope": {
    "platformId": null,
    "period": "day",
    "from": "2026-09-28",
    "to": "2026-09-28"
  },
  "platforms": [
    {
      "platformId": "uuid",
      "code": "FUN66_STAGING",
      "displayName": "FUN66",
      "currency": "BRL",
      "timezone": "America/Sao_Paulo",
      "completeness": "complete",
      "depositors": { "status": "ok", "value": 12 },
      "depositAmount": {
        "status": "ok",
        "value": "1234.560000",
        "currency": "BRL"
      },
      "netDeposit": {
        "status": "ok",
        "value": "1000.000000",
        "currency": "BRL"
      }
    }
  ],
  "total": {
    "depositors": { "status": "ok", "value": 12 },
    "depositAmount": {
      "status": "ok",
      "value": "1234.560000",
      "currency": "BRL"
    },
    "netDeposit": {
      "status": "ok",
      "value": "1000.000000",
      "currency": "BRL"
    }
  }
}
```

The endpoint uses only the current P4 fact revision and an active import batch.
Attribution uses the first verified immutable identity snapshot recorded for
the fact, so a later UID revoke or rebind cannot remove or transfer historical
performance. The snapshot must resolve to a Member through the requested Bot.

Depositors are Members whose canonical deposit is greater than zero. They are
deduplicated for the full range, then deduplicated by `member_id` again for the
all-platform total. Deposit amount is canonical deposit only. Net deposit is
canonical deposit minus canonical withdrawal. Gift, first-deposit and
`source_net` do not contribute. Decimal arithmetic is exact at the P4
`numeric(28,6)` scale and money values are JSON strings.

An incomplete range, non-full coverage, rejected input row, unresolved
conflict, missing Member link, invalid deposit, or missing required date returns
`data_incomplete` and a null affected value. A canonical field unavailable on
every relevant batch returns `not_applicable`. Different currencies retain
per-platform values and depositor totals, but all-platform money totals return
`not_applicable/multiple_currencies`.

## `GET /ops/pending`

The route requires `dashboard.read`. Each category then checks its own existing
permission and scope:

| Response field | Source | Permission and scope |
| --- | --- | --- |
| `identityReview` | current pending identities | `platform_identities.read`, requested Bot |
| `identityConflict` | current conflicting identities | `platform_identities.read`, requested Bot |
| `platformDataReview` | unresolved P4 platform/date reviews | Brand-wide `platform_data.read` |
| `qualificationReview` | current entitlement revisions in review | `entitlements.read`, requested Bot |
| `growthReview` | current Growth evaluations in review | Brand-wide `growth.read` |
| `lowInventory` | not implemented in Batch 1 | `backend_pending` |

The endpoint returns `forbidden` for an unauthorized category rather than
exposing its count. It counts only current revisions and unresolved states;
historical revisions are not added again.

## Security and compatibility

The responses never include a platform UID, Telegram numeric identity, raw P4
evidence, Token, Cookie, Session, Authorization value, database connection or
other secret. No table, permission, migration or runtime grant is added. The
two Brand-wide P4 reads intentionally retain the stricter P4 authorization
boundary.
