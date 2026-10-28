# P0 Mini read contracts

Baseline: `46958f2bc1956d41dad338b8bfe3f1e1f79dd85c`. No migration, grants, environment variables or new write primitive. Paths below retain `/v1/mini` and existing Mini session/Origin authentication.

## Platform selection

`GET /home`, `GET /referrals`, `GET /redemption-tiers` accept optional UUID `platformId`. Home/referrals default to the first active platform in the authenticated Brand ordered by display name then ID. Foreign/disabled selections are 404. Catalogue without a selection includes all active Brand platforms with published tiers belonging to the current Bot; a foreign selection yields no items. Never accept caller Brand/Bot/User overrides. Referral cursors bind the selected platform as well as Brand/Bot/User.

## Home

Existing `profile`, `points`, `member`, `invitedCount`, `redemptionCount`, `activities`, `referral` remain. Add:

- `platforms`: `{id,displayName,timezone,businessDate}[]`; `currentPlatform`: selected item or null.
- `identity.status`: `unbound|pending|verified|rejected|conflict|revoked`; no raw UID.
- `primaryAction`: `{kind,platformId,orderId?,ruleId?}`. Priority: `view_code` (unclaimed assigned order), `redeem` (currently executable tier), `bind_uid` (only unbound with a platform), `view_identity` (pending), `checkin`, `invite` (available and below cap), `view_records`. Order/tier recommendations are scoped to selected platform. Rejected/conflict states remain visible without presenting repeated binding as the primary action.
- `recommendedRedemption`: executable tier first, then a stocked tier, then first tier; null if none. All comparisons and balance gaps are server-side BigInt strings.
- `recentOrders`: up to five own selected-platform `{id,platform_id,status,points_cost,created_at}`, assigned first. No code content or encrypted payload.

Home contains one primary action; the client must not recompute monetary eligibility or substitute missing values with zero. Read-model results are advisory and may change concurrently; existing write APIs revalidate balances, inventory, eligibility and limits atomically. Home uses SELECT-only queries without row locks; multiple statements are not a promised atomic snapshot.

## Member / check-in

`GET /member` and home `member` are now genuinely read-only. They do not initialize Members/accounts/history or update persisted levels. The existing explicit check-in POST retains initialization and normal Growth reconciliation.

New fields:

- `todayCheckedIn`: current member-business-day check-in source exists.
- `actualGrowthEarned`: Decimal integer string of net ledger deltas for that day's `daily_checkin` sources, including corrections; null if rules/feature unavailable.
- `businessTimezone`, `businessDate`, `nextAvailableAt` ISO timestamp. Next availability is now when available, otherwise next local midnight.
- `checkinReward`: string from current published Growth rule (existing validated rule enforces 5); this is the nominal rule, not an unconditional amount paid.
- `checkinStatus`: `available|checked_in|cap_reached|unavailable`; `canCheckin` boolean.

The displayed member level is the persisted level, not recalculated by GET. A member not yet initialized can have `available:false,canCheckin:true` if valid Growth/Level rules permit the explicit action; no invented level/balance is returned. Feature/rule unavailability gives null monetary details and disabled action. A checked-in day corrected down because of higher-priority sources displays actual net Growth and cap status. Points remain separate.

## Referral

Home `referral` adds `platformId,businessDate,businessTimezone,rewardedToday,pendingCount,capExceededCount,dailyCap,activity,rewardEligible,rewardAvailability` and retains share URL, qualified totals and earned Points.

- `qualifiedToday` and `rewardedToday` use the existing Member + Platform + local-day counter. They can differ: six qualified invitations, five rewarded invitations, ten 50/20 Ledger events.
- `qualifiedTotal`, `pointsEarned` and records are scoped to the authenticated Bot/user/selected platform. `pointsEarned` sums granted rewards actually credited to this user (both reward roles if applicable).
- `pendingCount` / `capExceededCount` count current displayed records, not historic evidence rows. Current identity/evidence exceptions take precedence over historic granted status.
- `activity`: `{inviterPoints,inviteePoints,inviteeEnabled}` or null; only one active published rule yields an activity. The 20 Points line is shown only if enabled.
- `rewardAvailability`: `available|disabled|out_of_scope|no_activity|member_required`.
- `rewardEligible` means the current user passes the configured reward user/scope gate, an activity exists, and the current Bot user already has the Member link required by the automatic reward hook. An uninitialized user receives `member_required`; sharing remains enabled and an explicit check-in can perform normal initialization. It is conditional participation, **not a guarantee of reward or approval of a future invitee**. Existing write paths must still validate both participants, verified UID, permanent deduplication and daily cap. No allowlist identifiers are exposed.

`GET /referrals` adds `displayStatus: pending|rewarded|cap_exceeded|review_required` per item, using selected-platform latest identity/evidence and actual granted events. Existing fields remain for compatibility. No invitee identity, UID or sensitive evidence is returned. Sharing remains available even when reward gates are off.

## Redemption catalogue

Existing tier snake_case fields remain. New per-tier fields:

- `balance:string|null`, `pointsGap:string|null`, `canRedeem:boolean`.
- `memberAvailable`, `accountAvailable`.
- `usedToday:number`, `pointsUsedToday:string`, `dailyCountLimit:1`, `dailyPointsLimit:"300"`.
- `timezone`, `business_date`.
- `unavailableReason:null|redemption_rule_unsupported|member_unavailable|account_unavailable|daily_redemption_limit|inventory_empty|insufficient_points`.

Available balance uses existing Point Lots expiry-aware summary. Unknown/missing account is null, not zero. Limits use Brand + Member + Platform + platform-local date across Bots; Points and stock remain Bot scoped. All non-refunded orders continue occupying the daily limit, including review/unknown outcomes. Only confirmed refund restores capacity. Internal rule conditions are removed from the public result. Query failures propagate safely instead of producing fake zero results.

Creation, claim and same-code recovery paths are unchanged. Code assignment/claim is not platform redemption or payout confirmation. No deposit, turnover or external redemption checks were added.

## Verification

`tests/p0-mini-experience.test.ts` runs with PGlite or isolated PG17 via `TEST_DATABASE_URL`; PG17 requires localhost and version 17. It covers SELECT-only HTTP home, actual READ ONLY transaction, check-in ledger/correction/local-day recovery, exact large balances, quota/refund state, cross-Bot member quota, platform isolation, action priority and six-qualified/five-rewarded semantics. Existing Mini/auth/referral/redemption regressions remain part of final integration.
