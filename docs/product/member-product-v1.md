# TG member product foundation V1

## Scope and reuse

Baseline: 595e8a67bba3a3a9fdcba2cf4ab3b76540f5fa5d, migrations 001–012.
No migration, credential, feature flag, Auth, Mini Recovery, Points write service, daily qualification service, or business rule changes.

Mini navigation: Home / Member / Activities / Games / Me. Points, invitation and redemption histories remain secondary screens; platform binding stays under Me. Member/Growth/Benefits are explicitly unavailable until approved. No invented level, progress percentage, threshold, reward, or game chance.

Admin navigation: Overview / Users / Member / Activities / Points / Games / Data / Settings. Existing P3 review, P4 import, P5-A expiry policy and P5-B qualification components retain their own service and permission boundaries. Advanced audit/technical navigation is folded under Settings; per-user audit is explicitly still Bot-scoped.

User360 displays existing profile, Points summary, records and referrals, adds masked per-user platform identities, and leaves unsupported membership/activity/game information unavailable. List balances remain on-demand rather than N+1 requests. Full UID review remains limited to the existing P3 permission-gated review route; this change does not expose it.

## Data centre and Metric Registry

`web/src/product/metrics.ts` is the registry. Daily, Monday-start weekly and calendar-month requests use half-open server aggregate ranges in the configured Bot/Brand timezone. Calendar conversion covers DST; invalid dates do not produce requests.

Available: current Bot user count and current Points balance (explicitly REALTIME, never claimed as historical period-end), new users by first start, Points credits including refunds, debits including expiry/adjustments, referral relations, period-distinct inviters, redemption requests and linked redemption refunds.

Unavailable: reliable historic active-user facts, end-period binding/member snapshots, Growth, level changes, activity/game events, true consumption/expiry classification aggregations, invitation conversion and platform deposit aggregation. These show “待接入”, not zero. Deposit remains canonical P4 data; no scaling or rounding is introduced here.

Platform/country controls are a framework: existing endpoints only aggregate Bot scope. A specific platform/country selection suppresses Bot totals and explicitly shows unavailable attribution. Country describes platform market, not inferred personal nationality. No client downloads details to aggregate them. The full source/aggregation/day/week/month/dedup/unit/platform contract is in the expandable metric table. Rates require recomputing numerator/denominator; DISTINCT requires whole-period uniqueness; historical SNAPSHOT requires period-end evidence.

## Read-only API delta

Existing admin `GET /v1/brands/:brandId/bots/:botId/platform-identities` accepts an optional UUID `userId`. It reuses the existing authorization and parameterized Brand/Bot/User query, pagination and masked serializer. The Mini route still rejects extra query fields. No grants or schema changes.

## Design and localization

Ink/forest + warm neutral surfaces; clearer card/number hierarchy, responsive grids, consistent rounded controls, folded rules/advanced details. Mini text uses existing typed translation keys: zh-CN/en complete for new presentation, pt-BR/es-MX/fil retain explicit English fallback. Admin remains zh-CN, with new reusable product vocabulary/message keys centralized for future translation.

## Deferred product contracts

Member Level, Growth and Benefits have no formal policy. Points remain P5-A's sole ledger. P5-B daily qualifications are retained as an operational capability and are not relabeled as formal member levels.

Future WS must consume or synchronize our authoritative identity/member/Points model with explicit ownership/idempotency contracts. No second member, Growth or Points source of truth; no WS integration is implemented.

Next approval defines formal levels, Growth sources, Points sources, tier benefits, game chances and activity rules before implementation. No P5-C/P6 development.

## Evidence boundaries

UI-only synthetic browser checks prove rendering/navigation, not fresh Telegram-user acceptance or new business writes. Existing stage acceptance remains the baseline. Local checks do not re-run PG17/PGlite; the repository's unchanged CI workflow still runs its established checks on push.
