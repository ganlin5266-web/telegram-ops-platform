# Batch 3 scoped referral reward Staging plan

This is a preparation document only. It does not authorize a Render change,
Staging write, Points award, inventory import, or deployment.

## Release gate

- Deploy the reviewed commit with `BATCH2A_REFERRAL_REWARDS_ENABLED=false`.
- Configure `BATCH2A_REFERRAL_REWARDS_ALLOWLIST_JSON` as a server-only JSON
  array of exact `brandId` / `botId` / `platformId` tuples. Missing, empty,
  malformed, duplicate, incomplete, or non-matching configuration disables all
  referral reward writes.
- Reconfirm the selected Staging IDs immediately before configuration. The
  previously approved candidate scope was:
  - Brand: `db28eeb8-cc2f-411d-bebb-06eed19198a7`
  - Bot: `991f1b96-4e4a-4455-879e-9af51e48564a`
  - Platform: `8816f907-5767-47e0-a119-a74d52e39db7`
- Keep the master flag off until a separate controlled-write approval. Enabling
  an allowlist alone cannot award Points and does not scan or enqueue history.
- No migration or runtime grant is required by this change.

## Synthetic test accounts

Use aliases in evidence and keep Telegram/UID values out of reports:

- `test_inviter`: existing or newly approved Staging-only member with a Points
  account and Point Lots enabled.
- `test_invitee_1` through `test_invitee_6`: Staging-only identities for the
  five rewarded referrals and one retained `cap_exceeded` referral.
- `test_cross_bot_invitee`: Staging-only identity on the other Bot, reusing the
  already rewarded platform UID only through the approved revoke/rebind flow;
  expected result is manual review and zero additional Points.
- `test_out_of_scope_invitee`: a Staging-only identity outside the exact tuple;
  expected result is disabled and zero reward evidence/counter/Ledger writes.

The test campaign uses the frozen 50/20 Points rule with invitee reward enabled.
All test identities, referrals, and members must be confirmed synthetic before
the master flag is enabled.

## Synthetic redemption inventory

- Use one Staging-only fixed redemption tier costing no more than 300 Points.
- Generate codes at import time; do not store plaintext values in Git, this
  document, logs, or evidence exports.
- Prepare separate codes for success, safe re-read/retry, concurrency, expired,
  and unavailable-inventory cases. Never use production or operator inventory.
- Import and redemption are separate controlled Staging writes and require
  explicit approval after the reward-only checks pass.

## Acceptance and shutdown

1. Snapshot Points account, Ledger, Lots, Growth, reward events, counters, and
   inventory counts.
2. With the master flag off, verify sharing/binding works and all reward writes
   remain zero.
3. After separate approval, enable only the exact candidate tuple and exercise
   50/20, five-per-day, sixth `cap_exceeded`, duplicate, concurrency, cross-Bot,
   and out-of-scope cases.
4. Confirm account = Ledger = Lots, Growth unchanged, and no historical rewards.
5. Turn the master flag off, verify a new eligible referral produces no reward,
   and leave it off after acceptance.
