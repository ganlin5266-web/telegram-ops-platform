import { DomainError, one, type Database } from "./db.js";
import type { MiniPrincipal } from "./mini-sessions.js";
import {
  referralRewardsEnabled,
  referralRewardUserScopeEnabled,
} from "./referral-rewards.js";

export async function miniPlatforms(
  db: Database,
  p: MiniPrincipal,
  selected?: string,
) {
  const platforms = (
    await db.query(
      `SELECT id,display_name AS "displayName",timezone,
  (now() AT TIME ZONE timezone)::date::text AS "businessDate"
  FROM platforms WHERE brand_id=$1 AND status='active' ORDER BY display_name,id`,
      [p.brandId],
    )
  ).rows;
  const currentPlatform = selected
    ? platforms.find((x) => x.id === selected)
    : platforms[0];
  if (selected && !currentPlatform) throw new DomainError("not_found", 404);
  return { platforms, currentPlatform: currentPlatform ?? null };
}

/** Latest identity takes precedence over a historic reward; no private UID is returned. */
export const referralRecordSql = `SELECT r.id,r.bound_at AS created_at,r.status,r.reward_status,
 CASE WHEN r.status='invalid' OR i.status IN ('conflict','rejected','revoked') OR e.status IN ('conflict','revoked','invalid','manual_review') THEN 'review_required'
 WHEN EXISTS(SELECT 1 FROM referral_reward_events ev WHERE ev.brand_id=r.brand_id AND ev.platform_id=$4 AND ev.referral_id=r.id AND ev.reward_role='inviter' AND ev.status='granted') THEN 'rewarded'
 WHEN e.status='cap_exceeded' THEN 'cap_exceeded' ELSE 'pending' END AS "displayStatus"
 FROM referrals r
 LEFT JOIN LATERAL(SELECT q.status FROM referral_qualification_evidence q WHERE q.brand_id=r.brand_id AND q.bot_id=r.bot_id AND q.referral_id=r.id AND q.platform_id=$4 ORDER BY q.created_at DESC,q.id DESC LIMIT 1)e ON true
 LEFT JOIN LATERAL(SELECT pi.status FROM platform_identities pi WHERE pi.brand_id=r.brand_id AND pi.bot_id=r.bot_id AND pi.user_id=r.invitee_id AND pi.platform_id=$4 ORDER BY pi.created_at DESC,pi.id DESC LIMIT 1)i ON true
 WHERE r.brand_id=$1 AND r.bot_id=$2 AND r.inviter_id=$3`;

export async function miniReferralSummary(
  db: Database,
  p: MiniPrincipal,
  platform: any,
  shareUrl: string | null,
) {
  const empty = {
    platformId: null,
    businessDate: null,
    businessTimezone: null,
    qualifiedToday: "0",
    qualifiedTotal: "0",
    rewardedToday: "0",
    pendingCount: "0",
    capExceededCount: "0",
    pointsEarned: "0",
    dailyCap: 5,
    activity: null,
    rewardEligible: false,
    rewardAvailability: "no_activity",
    shareUrl,
  };
  if (!platform) return empty;
  const rows = (
    await db.query(
      `SELECT inviter_points::text,invitee_points::text,invitee_enabled FROM referral_reward_rule_versions WHERE brand_id=$1 AND platform_id=$2 AND status='published'
  AND effective_from<=$3::date AND (effective_until IS NULL OR effective_until>=$3::date)`,
      [p.brandId, platform.id, platform.businessDate],
    )
  ).rows;
  const rule = rows.length === 1 ? rows[0] : null;
  const stats = await one(
    db,
    `SELECT
  EXISTS(SELECT 1 FROM member_user_links WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3) AS member_available,
  (SELECT coalesce(sum(points),0)::text FROM referral_reward_events WHERE brand_id=$1 AND bot_id=$2 AND recipient_user_id=$3 AND platform_id=$4 AND status='granted') AS earned,
  (SELECT count(DISTINCT q.referral_id)::text FROM referral_qualification_evidence q JOIN referrals r ON (r.brand_id,r.bot_id,r.id)=(q.brand_id,q.bot_id,q.referral_id)
   WHERE r.brand_id=$1 AND r.bot_id=$2 AND r.inviter_id=$3 AND q.platform_id=$4 AND q.status IN ('verified','cap_exceeded')) AS qualified,
  (SELECT count(*)::text FROM (${referralRecordSql}) rr WHERE "displayStatus"='pending') AS pending,
  (SELECT count(*)::text FROM (${referralRecordSql}) rr WHERE "displayStatus"='cap_exceeded') AS exceeded`,
    [p.brandId, p.botId, p.userId, platform.id],
  );
  const counter = (
    await db.query(
      `SELECT c.qualified_count,c.rewarded_count FROM member_user_links l JOIN referral_reward_daily_counters c ON (c.brand_id,c.inviter_member_id)=(l.brand_id,l.member_id)
  WHERE l.brand_id=$1 AND l.bot_id=$2 AND l.user_id=$3 AND c.platform_id=$4 AND c.business_date=$5`,
      [p.brandId, p.botId, p.userId, platform.id, platform.businessDate],
    )
  ).rows[0];
  const eligible = referralRewardUserScopeEnabled(
    { brandId: p.brandId, botId: p.botId, platformId: platform.id },
    p.userId,
  );
  return {
    ...empty,
    platformId: platform.id,
    businessDate: platform.businessDate,
    businessTimezone: platform.timezone,
    qualifiedToday: String(counter?.qualified_count ?? 0),
    qualifiedTotal: stats.qualified,
    rewardedToday: String(counter?.rewarded_count ?? 0),
    pendingCount: stats.pending,
    capExceededCount: stats.exceeded,
    pointsEarned: stats.earned,
    activity: rule
      ? {
          inviterPoints: rule.inviter_points,
          inviteePoints: rule.invitee_points,
          inviteeEnabled: rule.invitee_enabled,
        }
      : null,
    rewardEligible: !!rule && eligible && stats.member_available,
    rewardAvailability: !referralRewardsEnabled()
      ? "disabled"
      : !eligible
        ? "out_of_scope"
        : !rule
          ? "no_activity"
          : !stats.member_available
            ? "member_required"
            : "available",
  };
}

export function miniPrimaryAction(input: {
  platformId: string | null;
  orders: any[];
  tiers: any[];
  identity: string;
  member: any;
  referral: any;
}) {
  const { platformId, orders, tiers, identity, member, referral } = input;
  const assigned = orders.find((x) => x.status === "code_assigned");
  if (assigned)
    return {
      kind: "view_code",
      platformId: assigned.platform_id,
      orderId: assigned.id,
    };
  const tier = tiers.find((x) => x.canRedeem);
  if (tier) return { kind: "redeem", platformId, ruleId: tier.id };
  if (platformId && identity === "unbound")
    return { kind: "bind_uid", platformId };
  if (platformId && identity === "pending")
    return { kind: "view_identity", platformId };
  if (member.canCheckin) return { kind: "checkin", platformId };
  if (referral.rewardEligible && BigInt(referral.rewardedToday) < 5n)
    return { kind: "invite", platformId };
  return { kind: "view_records", platformId };
}
