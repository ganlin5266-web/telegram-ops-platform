# Batch 1｜Backend Implementation & Review Handover

## Delivery scope

Baseline: `fc9036dc113e0d2e4605c586b194ea4f39773236`.

Implemented only these read-only routes:

1. `GET /v1/brands/:brandId/bots/:botId/ops/platform-data-status`
2. `GET /v1/brands/:brandId/bots/:botId/ops/private-performance`
3. `GET /v1/brands/:brandId/bots/:botId/ops/pending`

`/ops/market` remains covered by the existing Brand/Bot/Platform APIs.
`/ops/scale` remains covered by `/members/analytics`. Batch 2, Benefits, games,
redemption-code inventory and content publishing were not implemented.

The complete response and status contract is in
[`docs/ops-read-api.md`](../ops-read-api.md).

## Implementation

- `src/ops-read.ts` contains the readonly query and aggregation service.
- `src/ops-read-routes.ts` contains validation, authentication, authorization,
  repeatable-read readonly transactions, timeouts and HTTP routes.
- `src/app.ts` registers the routes in the existing Fastify application.
- `tests/ops-read.test.ts` covers the Batch 1 contract on PGlite and PostgreSQL
  17.
- `tests/member-growth.test.ts` only stabilizes its existing PG17 P4/Growth
  fixture: its identity timestamp comes from the real database clock, so fixed
  October 1 dates began failing after October 1. The fixture now derives only
  those P4 dates from the database-era clock. Production Member/Growth code and
  behavior are unchanged.

No migration, schema, permission, runtime grant, environment setting, frontend
file or deployment configuration changed.

## Data rules implemented

- P4 current fact revisions and active batches are authoritative for values.
- The fact's first verified immutable identity snapshot is authoritative for
  historical Member attribution. A later revoke/rebind or current fact revision
  does not transfer or erase earlier performance.
- Depositor count uses canonical `deposit > 0` and deduplicates by Member over
  the selected range. The all-platform total performs a second Member dedupe.
- Money uses exact six-decimal integer units and returns decimal strings.
- Net deposit is deposit minus withdrawal. Gift, first deposit and source net
  are excluded.
- Platform business dates are queried directly. Week and month counts are not
  sums of daily unique counts.
- Incomplete, unknown, conflicting, rejected, missing, open-period and invalid
  data fail closed with null values.
- Different currencies are never converted or combined.
- Pending counts use current identity state or current revision pointers and
  preserve independent permission results.

## Authorization

- Platform status and private performance require existing Brand-wide
  `platform_data.read`; a Bot-only grant cannot expose Brand facts.
- Pending requires `dashboard.read`, then evaluates each category with the
  existing permission and correct Bot/Brand scope.
- Unauthorized categories return `forbidden`, a confirmed empty category
  returns `ok/0`, inventory returns `backend_pending`, and query failures remain
  API errors.
- Existing authentication, Origin/CSRF, error handling and no-secret response
  behavior are reused.

## Database decision

Migration required: **no**.

The existing P3 identity revisions, P4 batches/facts/current revision pointers,
Member links, P5-B entitlement current revisions and Growth current evaluations
contain the required data. Inventory has no current contract, so it is reported
as `backend_pending` instead of adding a placeholder table or fake zero.

## Lovable integration

Lovable should:

1. call the three routes with the selected Brand/Bot scope;
2. send `period`, `date` and optional `platformId` only to private performance;
3. render the metric `status` before reading `value`;
4. display money strings without JavaScript floating-point conversion;
5. keep currencies separated when `multiple_currencies` is returned;
6. distinguish `forbidden`, `backend_pending`, `data_incomplete`, API failure
   and real `ok/0`;
7. avoid building Expected Business Date/SLA or inventory UI as working data in
   Batch 1.

No Lovable bridge repository was changed in this delivery.

## Validation and evidence

The final exact commands and counts are recorded in
[`BATCH1_TEST_EVIDENCE.md`](./BATCH1_TEST_EVIDENCE.md). The delivery uses local
branch `codex/batch1-backend-ops`; its final commit SHA and exported patch path
are reported in the completion message and the post-commit delivery manifest.

## Remaining boundaries

- Expected Business Date, expected update time and SLA cutoff configuration are
  intentionally not implemented.
- Redemption-code inventory remains `backend_pending`.
- No FX conversion exists; cross-currency money totals remain unavailable.
- The endpoints report current database truth. They do not infer missing source
  values or downgrade an upstream/query failure to zero.
- No Staging or Production database/deployment verification is part of this
  local implementation delivery.
