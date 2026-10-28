import {
  DomainError,
  one,
  type Database,
  type Queryable,
  type Scope,
} from "./db.js";
import { pointSummary } from "./point-lots.js";
import { postPoints } from "./points.js";
import type { MiniPrincipal } from "./mini-sessions.js";
import type { Principal } from "./auth.js";
import { authorize } from "./auth.js";
import type { RedemptionCodeVault } from "./redemption-vault.js";

export async function redemptionCatalogue(
  db: Database,
  p: MiniPrincipal,
  platformId?: string,
) {
  let balance: string | null = null;
  try {
    balance = (await pointSummary(db, p)).availableBalance;
  } catch (error) {
    if (
      !(
        error instanceof DomainError &&
        error.code === "point_lot_cutover_required"
      ) ||
      (
        await db.query(
          "SELECT id FROM point_accounts WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3",
          [p.brandId, p.botId, p.userId],
        )
      ).rows.length
    )
      throw error;
  }
  const member = (
    await db.query(
      "SELECT member_id FROM member_user_links WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3",
      [p.brandId, p.botId, p.userId],
    )
  ).rows[0];
  const rows = (
    await db.query(
      `SELECT r.id,r.platform_id,r.tier_key,r.name,r.points_cost::text,r.face_value::text,r.face_currency,
    r.mode,r.requires_deposit,r.conditions,r.daily_count_limit,r.daily_points_limit::text,
    pl.display_name,pl.timezone,pl.redemption_url,(now() AT TIME ZONE pl.timezone)::date::text AS business_date,
    (SELECT count(*)::int FROM redemption_codes c WHERE c.brand_id=r.brand_id AND c.bot_id=r.bot_id AND c.platform_id=r.platform_id AND c.rule_id=r.id
      AND c.status='available' AND (c.expires_at IS NULL OR c.expires_at>now())) AS available,
    (SELECT count(*)::int FROM redemptions o WHERE o.brand_id=r.brand_id AND o.platform_id=r.platform_id AND o.member_id=$3
      AND o.business_date=(now() AT TIME ZONE pl.timezone)::date AND o.status<>'refunded') AS used_today,
    (SELECT coalesce(sum(o.points_cost),0)::text FROM redemptions o WHERE o.brand_id=r.brand_id AND o.platform_id=r.platform_id AND o.member_id=$3
      AND o.business_date=(now() AT TIME ZONE pl.timezone)::date AND o.status<>'refunded') AS points_used_today
   FROM redemption_rules r JOIN platforms pl ON (pl.brand_id,pl.id)=(r.brand_id,r.platform_id)
   WHERE r.brand_id=$1 AND r.bot_id=$2 AND r.status='published' AND r.enabled AND pl.status='active'
    AND ($4::uuid IS NULL OR r.platform_id=$4)
    AND r.effective_from<=(now() AT TIME ZONE pl.timezone)::date
    AND (r.effective_until IS NULL OR r.effective_until>=(now() AT TIME ZONE pl.timezone)::date)
   ORDER BY pl.display_name,r.points_cost,r.id`,
      [p.brandId, p.botId, member?.member_id ?? null, platformId ?? null],
    )
  ).rows;
  return {
    items: rows.map((data: any) => {
      const {
        mode,
        requires_deposit,
        conditions,
        daily_count_limit,
        daily_points_limit,
        used_today,
        points_used_today,
        ...row
      } = data;
      const unsupported =
        mode !== "fixed" ||
        requires_deposit ||
        daily_count_limit !== 1 ||
        daily_points_limit !== "300" ||
        BigInt(row.points_cost) > 300n ||
        Object.keys(conditions).length > 0;
      const gap =
        balance === null
          ? null
          : BigInt(row.points_cost) > BigInt(balance)
            ? String(BigInt(row.points_cost) - BigInt(balance))
            : "0";
      const unavailableReason = unsupported
        ? "redemption_rule_unsupported"
        : !member
          ? "member_unavailable"
          : balance === null
            ? "account_unavailable"
            : used_today >= 1 ||
                BigInt(points_used_today) + BigInt(row.points_cost) > 300n
              ? "daily_redemption_limit"
              : row.available === 0
                ? "inventory_empty"
                : gap !== "0"
                  ? "insufficient_points"
                  : null;
      return {
        ...row,
        balance,
        pointsGap: gap,
        canRedeem: unavailableReason === null,
        unavailableReason,
        usedToday: used_today,
        pointsUsedToday: points_used_today,
        dailyCountLimit: 1,
        dailyPointsLimit: "300",
        memberAvailable: !!member,
        accountAvailable: balance !== null,
      };
    }),
  };
}

export async function createFixedRedemption(
  db: Database,
  p: MiniPrincipal,
  ruleId: string,
  key: string,
  requestId: string,
) {
  return db.transaction(async (tx) => {
    const previous = (
      await tx.query(
        `SELECT id,user_id,rule_id,status,points_cost::text,
   platform_id FROM redemptions WHERE brand_id=$1 AND bot_id=$2 AND idempotency_key=$3`,
        [p.brandId, p.botId, key],
      )
    ).rows[0];
    if (previous) {
      if (previous.user_id !== p.userId || previous.rule_id !== ruleId)
        throw new DomainError("idempotency_conflict");
      return previous;
    }
    const rule = await one(
      tx,
      `SELECT r.*,p.timezone,p.status AS platform_status,
   (now() AT TIME ZONE p.timezone)::date::text AS business_date
   FROM redemption_rules r JOIN platforms p ON (p.brand_id,p.id)=(r.brand_id,r.platform_id)
   WHERE r.brand_id=$1 AND r.bot_id=$2 AND r.id=$3 FOR UPDATE OF r,p`,
      [p.brandId, p.botId, ruleId],
    );
    if (
      rule.platform_id === null ||
      rule.status !== "published" ||
      !rule.enabled ||
      rule.platform_status !== "active"
    )
      throw new DomainError("redemption_rule_unavailable");
    if (
      rule.effective_from > rule.business_date ||
      (rule.effective_until && rule.effective_until < rule.business_date)
    )
      throw new DomainError("redemption_rule_inactive");
    if (
      rule.mode !== "fixed" ||
      rule.requires_deposit ||
      rule.daily_count_limit !== 1 ||
      String(rule.daily_points_limit) !== "300" ||
      Number(rule.points_cost) > 300 ||
      Object.keys(rule.conditions).length
    )
      throw new DomainError("redemption_rule_unsupported");
    const member = await one(
      tx,
      `SELECT m.id FROM member_user_links l
   JOIN members m ON (m.brand_id,m.id)=(l.brand_id,l.member_id)
   WHERE l.brand_id=$1 AND l.bot_id=$2 AND l.user_id=$3 FOR UPDATE OF m`,
      [p.brandId, p.botId, p.userId],
    );
    // The Member lock serializes same-user requests across Bots. Re-read the
    // key after the lock so a concurrent replay returns its original order.
    const replay = (
      await tx.query(
        `SELECT id,user_id,rule_id,status,points_cost::text,
   platform_id FROM redemptions WHERE brand_id=$1 AND bot_id=$2 AND idempotency_key=$3`,
        [p.brandId, p.botId, key],
      )
    ).rows[0];
    if (replay) {
      if (replay.user_id !== p.userId || replay.rule_id !== ruleId)
        throw new DomainError("idempotency_conflict");
      return replay;
    }
    const active = (
      await tx.query(
        `SELECT id FROM redemptions
   WHERE brand_id=$1 AND platform_id=$2 AND member_id=$3 AND business_date=$4
    AND status<>'refunded' LIMIT 1`,
        [p.brandId, rule.platform_id, member.id, rule.business_date],
      )
    ).rows[0];
    if (active) throw new DomainError("daily_redemption_limit");
    const code = (
      await tx.query(
        `SELECT id FROM redemption_codes
   WHERE brand_id=$1 AND bot_id=$2 AND platform_id=$3 AND rule_id=$4
    AND status='available' AND (expires_at IS NULL OR expires_at>now())
   ORDER BY expires_at ASC NULLS LAST,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
        [p.brandId, p.botId, rule.platform_id, rule.id],
      )
    ).rows[0];
    if (!code) throw new DomainError("inventory_empty");
    const snapshot = {
      ruleId: rule.id,
      platformId: rule.platform_id,
      tierKey: rule.tier_key,
      version: rule.version,
      pointsCost: String(rule.points_cost),
      faceValue: String(rule.face_value),
      faceCurrency: rule.face_currency,
      businessDate: rule.business_date,
      timezone: rule.timezone,
    };
    const order = await one(
      tx,
      `INSERT INTO redemptions(
   brand_id,bot_id,user_id,rule_id,points_cost,idempotency_key,status,rule_snapshot,
   platform_id,member_id,business_date,code_assigned_at
  ) VALUES($1,$2,$3,$4,$5,$6,'code_assigned',$7,$8,$9,$10,now())
   RETURNING id,user_id,rule_id,status,points_cost::text,platform_id,business_date::text`,
      [
        p.brandId,
        p.botId,
        p.userId,
        rule.id,
        String(rule.points_cost),
        key,
        JSON.stringify(snapshot),
        rule.platform_id,
        member.id,
        rule.business_date,
      ],
    );
    await postPoints(tx, {
      brandId: p.brandId,
      botId: p.botId,
      userId: p.userId,
      delta: `-${rule.points_cost}`,
      source: "redemption",
      businessType: "redemption_debit",
      businessId: order.id,
      idempotencyKey: `redeem:${order.id}`,
    });
    await tx.query(
      `UPDATE redemption_codes SET redemption_id=$1,status='assigned',assigned_at=now()
   WHERE id=$2`,
      [order.id, code.id],
    );
    await tx.query(
      `INSERT INTO audit_logs(brand_id,bot_id,action,object_type,object_id,
   request_id,after_data) VALUES($1,$2,'redemption.created','redemption',$3,$4,$5)`,
      [
        p.brandId,
        p.botId,
        order.id,
        requestId,
        JSON.stringify({
          platformId: rule.platform_id,
          tierKey: rule.tier_key,
          pointsCost: String(rule.points_cost),
          businessDate: rule.business_date,
        }),
      ],
    );
    return order;
  });
}

async function ownCode(
  tx: Queryable,
  p: MiniPrincipal,
  id: string,
  lock: boolean,
) {
  return one(
    tx,
    `SELECT r.id,r.status,r.points_cost::text,r.platform_id,r.business_date::text,
  r.code_claimed_at,c.id AS code_id,c.status AS code_status,c.code_ciphertext,
  c.code_iv,c.code_auth_tag,c.code_key_version,c.code_fingerprint,
  p.redemption_url,rr.tier_key,rr.face_value::text,rr.face_currency
 FROM redemptions r JOIN redemption_codes c ON c.redemption_id=r.id
 JOIN platforms p ON (p.brand_id,p.id)=(r.brand_id,r.platform_id)
 JOIN redemption_rules rr ON rr.id=r.rule_id
 WHERE r.brand_id=$1 AND r.bot_id=$2 AND r.user_id=$3 AND r.id=$4
 ${lock ? "FOR UPDATE OF r,c" : ""}`,
    [p.brandId, p.botId, p.userId, id],
  );
}

function revealed(row: any, vault: RedemptionCodeVault) {
  if (
    !["code_assigned", "code_claimed", "review_required"].includes(row.status)
  )
    throw new DomainError("redemption_code_unavailable");
  return {
    id: row.id,
    status: row.status,
    code: vault.decrypt(row, row.platform_id),
    pointsCost: row.points_cost,
    platformId: row.platform_id,
    tierKey: row.tier_key,
    faceValue: row.face_value,
    faceCurrency: row.face_currency,
    redemptionUrl: row.redemption_url,
    businessDate: row.business_date,
    claimedAt: row.code_claimed_at
      ? new Date(row.code_claimed_at).toISOString()
      : null,
  };
}

export async function claimRedemptionCode(
  db: Database,
  vault: RedemptionCodeVault | undefined,
  p: MiniPrincipal,
  id: string,
) {
  if (!vault) throw new DomainError("redemption_vault_unavailable", 503);
  return db.transaction(async (tx) => {
    const row = await ownCode(tx, p, id, true);
    if (row.status === "code_assigned") {
      await tx.query(
        `UPDATE redemptions SET status='code_claimed',code_claimed_at=now(),
    updated_at=now() WHERE id=$1`,
        [id],
      );
      await tx.query(
        `UPDATE redemption_codes SET status='used',claimed_at=now()
    WHERE id=$1 AND status='assigned'`,
        [row.code_id],
      );
      row.status = "code_claimed";
      row.code_claimed_at = new Date();
      row.code_status = "used";
    }
    return revealed(row, vault);
  });
}

export async function recoverRedemptionCode(
  db: Database,
  vault: RedemptionCodeVault | undefined,
  p: MiniPrincipal,
  id: string,
) {
  if (!vault) throw new DomainError("redemption_vault_unavailable", 503);
  return revealed(await ownCode(db, p, id, false), vault);
}

export async function listAdminRedemptions(
  db: Database,
  p: Principal,
  s: Scope,
) {
  await authorize(db, p, s, "redemptions.read");
  return {
    items: (
      await db.query(
        `SELECT r.id,r.platform_id,r.member_id,r.points_cost::text,
  r.status,r.business_date::text,r.review_reason,r.created_at,r.updated_at,
  rr.tier_key,rr.face_value::text,rr.face_currency
 FROM redemptions r JOIN redemption_rules rr ON rr.id=r.rule_id
 WHERE r.brand_id=$1 AND r.bot_id=$2 AND r.platform_id IS NOT NULL
 ORDER BY r.created_at DESC,r.id DESC LIMIT 100`,
        [s.brandId, s.botId],
      )
    ).rows,
  };
}

export async function reviewRedemption(
  db: Database,
  p: Principal,
  s: Scope,
  id: string,
  action: "mark_review" | "refund",
  reason: string,
  requestId: string,
) {
  return db.transaction(async (tx) => {
    await authorize(tx, p, s, "redemptions.review");
    const order = await one(
      tx,
      `SELECT * FROM redemptions
   WHERE brand_id=$1 AND bot_id=$2 AND id=$3 AND platform_id IS NOT NULL FOR UPDATE`,
      [s.brandId, s.botId, id],
    );
    if (action === "mark_review") {
      if (order.status === "review_required")
        return { id, status: order.status };
      if (!["code_assigned", "code_claimed"].includes(order.status))
        throw new DomainError("invalid_order_state");
      await tx.query(
        `UPDATE redemptions SET status='review_required',review_reason=$2,
    reviewed_by=$3,reviewed_at=now(),updated_at=now() WHERE id=$1`,
        [id, reason, p.adminId],
      );
    } else {
      if (order.status === "refunded") return { id, status: order.status };
      if (
        order.status !== "review_required" ||
        reason !== "confirmed_internal_failure"
      )
        throw new DomainError("refund_not_confirmed");
      const debit = await one(
        tx,
        `SELECT id FROM point_ledger WHERE brand_id=$1 AND bot_id=$2
    AND user_id=$3 AND business_type='redemption_debit' AND business_id=$4`,
        [s.brandId, s.botId, order.user_id, id],
      );
      await postPoints(tx, {
        brandId: s.brandId,
        botId: s.botId,
        userId: order.user_id,
        delta: String(order.points_cost),
        source: "redemption",
        businessType: "redemption_refund",
        businessId: id,
        idempotencyKey: `refund:${id}`,
        refundLedgerId: debit.id,
        note: "confirmed_internal_failure",
      });
      await tx.query(
        `UPDATE redemptions SET status='refunded',review_reason=$2,
    refunded_at=now(),reviewed_by=$3,reviewed_at=now(),updated_at=now() WHERE id=$1`,
        [id, reason, p.adminId],
      );
    }
    const status = action === "refund" ? "refunded" : "review_required";
    await tx.query(
      `INSERT INTO audit_logs(admin_id,brand_id,bot_id,action,object_type,
   object_id,request_id,after_data) VALUES($1,$2,$3,$4,'redemption',$5,$6,$7)`,
      [
        p.adminId,
        s.brandId,
        s.botId,
        `redemption.${action}`,
        id,
        requestId,
        JSON.stringify({ status, reason }),
      ],
    );
    return { id, status };
  });
}
