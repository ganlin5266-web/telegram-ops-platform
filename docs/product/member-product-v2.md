# Telegram Member V2 — adopted product baseline

Status: Batch A development approved. Staging schema, cutover, enable and Production each require separate approval. Baseline main: 8cf583887e5f4e11e4e50440e303fa8f4c709871. No historical Growth backfill.

## Batch boundaries
A Member/Growth; B Benefits/Opportunity; C Content Publishing; D final Mini/Admin/Analytics integration. Each batch stops for acceptance. Batch A does not award Points, weekly rewards, game opportunities, or publish Telegram content. P1–P5B remain authoritative in their existing domains.

## Member and economics
Brand + verified Telegram numeric identity is one Member across Bots. Bot users and Points accounts remain separate. Other Brands never share Member data. Initial state LV1/Growth 0. Only upgrades, permanent cumulative integer Growth, protected existing levels after corrections or rule threshold changes. Keys level_1…level_5 remain stable. Staging thresholds 0/500/2000/6000/15000; names Starter/Active/Gold/Elite/Legend. No direct level adjustment.

Growth is not Points. Platform canonical deposit BRL thresholds 20/50/100/300/500/1000 yield 10/20/40/70/100/150; highest tier only. No bets. Other markets require independent currency-specific published rules. Raw scale, rounding, sentinel and currency interpretation are solely P4 responsibilities.

Check-in 5/day. Trusted task completions 10/20/30/50, task cap 50/day. Qualified referral 50, first five/day cap250, no default invitee reward. Global ordinary cap350. Fixed priority platform_daily > qualified_referral > member_task > daily_checkin, then authoritative occurrence time and stable business key. Reconciliation, not arrival order, determines final allocation. Partial allocations show actual granted amount. Admin adjustments are separately authorized, reason-required, outside ordinary caps; they do not masquerade as ordinary rewards.

Platform D→D+1 at Platform timezone; D+1 start instant maps into Brand member timezone cap date. User actions use Brand member timezone. Both source date and cap date remain traceable; corrections/catch-up retain the original cap date. Brand member timezone is explicitly configured in published Growth policy and cannot silently change.

NULL/missing/incomplete=pending; complete zero=not_applicable; real unresolved P4 conflict=review_required. No new award from unknown data. Previously credited attribution is retained pending review, not silently treated as zero. Other confirmed sources may proceed. Resolved authoritative input reconciles the original day. Corrections append deltas, never rewrite ledger. Negative final balance blocks and requires review. Account=sum ledger; source attribution=sum source ledger. No zero ledger entries.

Level and Growth policies have separate immutable versions. P5B staging tiers are not Member levels or Growth tiers. Existing users initialize without historical rewards. Identity changes cannot transfer past rewards to a new owner. Production values require 30–90 day simulation and separate approval.

## Deferred B/C/D requirements retained
Benefits: daily shared opportunities 1/2/3/4/5, same-day expiry; upgrade quota minus used, never regrant full quota. Weekly reward LV2–5, one claim per member/week regardless of version/upgrade, amount not Production-approved. Bonus0/0/5/10/15% only eligible point rewards, excluded refunds/corrections, integer floor, P5A sole Points writer. Ordinary point expiry90 days via approved P5A policy, campaigns fixed deadline, approved compensation may be permanent.
Content: text/image/video/caption/buttons, draft/copy/template/immediate/durable scheduling/history. Approved test targets only until explicit send approval. External uncertain delivery=delivery_unknown, never blind resend. Media validation, storage/worker cost gates, no bot token in frontend/logs. No extra paid infrastructure authorized.
Mini: Home/Member/Activities/Games/Me. Admin: Overview/Users/Member/Content/Activities/Points/Games/Data/Settings. zh-CN/en complete, other supported languages explicit fallback until translated. Unknown metrics remain unavailable, not zero. Period metrics distinguish SUM/DISTINCT/SNAPSHOT/RATE. WS remains future peripheral integration; no second source of truth.

## Gates
READY_FOR_MEMBER_SCHEMA_MIGRATION_APPROVAL → separately approved schema/grants with flag false.
READY_FOR_MEMBER_CUTOVER_APPROVAL → dry run, then approved idempotent initialization.
READY_FOR_MEMBER_GROWTH_ENABLE_APPROVAL → separately approved Staging enable.
Batch A final acceptance → stop. No automatic Batch B.
