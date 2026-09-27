import {
  DomainError,
  one,
  scopeParams,
  type Queryable,
  type Scope,
} from "./db.js";
import {
  lotsEnabled,
  hasLotCutover,
  lockManagedAccount,
  resolvePolicy,
  policyExpiry,
  pointAudit,
  assertReconciled,
} from "./point-lots.js";
export type PointEvent = Scope & {
  userId: string;
  delta: string;
  source: string;
  businessType: string;
  businessId: string;
  idempotencyKey: string;
  note?: string;
  policyVersionId?: string;
  refundLedgerId?: string;
  expireLotId?: string;
};
export async function postPoints(tx: Queryable, e: PointEvent) {
  if (process.env.POINT_WRITES_PAUSED === "true")
    throw new DomainError("point_writes_paused", 503);
  if (
    !/^-?[1-9]\d*$/.test(e.delta) ||
    BigInt(e.delta) > 9223372036854775807n ||
    BigInt(e.delta) < -9223372036854775808n
  )
    throw new DomainError("invalid_points", 400);
  await one(
    tx,
    "SELECT id FROM telegram_bots WHERE brand_id=$1 AND id=$2 FOR UPDATE",
    scopeParams(e),
  );
  const existing = (
    await tx.query(
      "SELECT * FROM point_ledger WHERE bot_id=$1 AND (idempotency_key=$2 OR (business_type=$3 AND business_id=$4))",
      [e.botId, e.idempotencyKey, e.businessType, e.businessId],
    )
  ).rows[0];
  if (existing) {
    if (
      existing.user_id !== e.userId ||
      String(existing.delta) !== e.delta ||
      existing.business_type !== e.businessType ||
      existing.business_id !== e.businessId ||
      existing.source !== e.source
    )
      throw new DomainError("idempotency_conflict");
    if (
      lotsEnabled() &&
      e.policyVersionId &&
      !(
        await tx.query(
          "SELECT id FROM point_lots WHERE positive_ledger_id=$1 AND policy_version_id=$2",
          [existing.id, e.policyVersionId],
        )
      ).rows.length
    )
      throw new DomainError("idempotency_conflict");
    return existing;
  }
  if (!lotsEnabled() && (await hasLotCutover(tx, e)))
    throw new DomainError("point_writes_paused", 503);
  await tx.query(
    "INSERT INTO point_accounts(brand_id,bot_id,user_id) VALUES($1,$2,$3) ON CONFLICT(bot_id,user_id) DO NOTHING",
    [...scopeParams(e), e.userId],
  );
  const account = await one(
    tx,
    "SELECT * FROM point_accounts WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3 FOR UPDATE",
    [...scopeParams(e), e.userId],
  );
  const managed = lotsEnabled();
  const at = new Date((await one(tx, "SELECT clock_timestamp() AS at")).at);
  const allocations: { lotId: string; amount: string; kind: string }[] = [];
  const grants: {
    amount: string;
    expires: string | null;
    policy: any;
    original?: string;
    legacy?: boolean;
  }[] = [];
  if (managed) {
    const lots = await lockManagedAccount(tx, e, account.id);
    if (BigInt(e.delta) < 0n) {
      let need = -BigInt(e.delta);
      if (e.expireLotId) {
        if (
          e.businessType !== "point_expired" ||
          e.businessId !== e.expireLotId
        )
          throw new DomainError("invalid_point_expiry");
        const lot = lots.find((l) => l.id === e.expireLotId);
        if (
          !lot ||
          !lot.expires_at ||
          new Date(lot.expires_at) > at ||
          BigInt(lot.remaining_amount) !== need
        )
          throw new DomainError("invalid_point_expiry");
        await one(tx, "SELECT id FROM point_lots WHERE id=$1 FOR UPDATE", [
          lot.id,
        ]);
        allocations.push({
          lotId: lot.id,
          amount: need.toString(),
          kind: "expire",
        });
        need = 0n;
      } else {
        for (const lot of lots) {
          if (!need) break;
          if (lot.expires_at && new Date(lot.expires_at) <= at) continue;
          await one(tx, "SELECT id FROM point_lots WHERE id=$1 FOR UPDATE", [
            lot.id,
          ]);
          const amount =
            BigInt(lot.remaining_amount) < need
              ? BigInt(lot.remaining_amount)
              : need;
          allocations.push({
            lotId: lot.id,
            amount: amount.toString(),
            kind: "consume",
          });
          need -= amount;
        }
      }
      if (need) throw new DomainError("insufficient_available_points");
    } else if (e.refundLedgerId) {
      const debit = await one(
        tx,
        "SELECT * FROM point_ledger WHERE id=$1 AND account_id=$2",
        [e.refundLedgerId, account.id],
      );
      if (BigInt(debit.delta) >= 0n || BigInt(e.delta) !== -BigInt(debit.delta))
        throw new DomainError("unsupported_partial_refund");
      if (
        e.businessType !== "redemption_refund" ||
        debit.business_type !== "redemption_debit" ||
        e.businessId !== debit.business_id
      )
        throw new DomainError("invalid_refund_reference");
      const original = (
        await tx.query(
          `SELECT a.id,a.amount,l.expires_at,l.policy_id,l.policy_version_id,l.policy_snapshot
    FROM point_lot_allocations a JOIN point_lots l ON l.id=a.lot_id WHERE a.negative_ledger_id=$1 AND a.kind='consume' ORDER BY a.id`,
          [debit.id],
        )
      ).rows;
      if (!original.length) {
        // A pre-cutover debit has no invented allocation. An explicit legacy refund policy is mandatory.
        const p = await resolvePolicy(
          tx,
          e,
          "legacy_refund",
          at,
          e.policyVersionId,
        );
        if (p.source !== "legacy_refund")
          throw new DomainError("legacy_refund_policy_required");
        grants.push({
          amount: e.delta,
          expires: policyExpiry(p, at),
          policy: p,
          legacy: true,
        });
      } else {
        if (
          original.reduce((n, a) => n + BigInt(a.amount), 0n) !==
          BigInt(e.delta)
        )
          throw new DomainError("point_reconciliation_mismatch");
        for (const a of original) {
          const days = a.policy_snapshot.refund_min_compensation_days;
          let expires: string | null = null;
          if (a.expires_at) {
            const old = new Date(a.expires_at).getTime();
            if (days == null && old <= at.getTime())
              throw new DomainError("refund_review_required");
            expires = new Date(
              days == null
                ? old
                : Math.max(old, at.getTime() + Number(days) * 86400000),
            ).toISOString();
          }
          grants.push({
            amount: String(a.amount),
            expires,
            policy: {
              ...a.policy_snapshot,
              policy_id: a.policy_id,
              id: a.policy_version_id,
            },
            original: a.id,
          });
        }
      }
    } else {
      const p = await resolvePolicy(tx, e, e.source, at, e.policyVersionId);
      grants.push({ amount: e.delta, expires: policyExpiry(p, at), policy: p });
    }
  }
  if (BigInt(account.balance) + BigInt(e.delta) < 0n)
    throw new DomainError("insufficient_points");
  const ledger = await one(
    tx,
    `INSERT INTO point_ledger(brand_id,bot_id,user_id,account_id,delta,balance_before,balance_after,source,business_type,business_id,idempotency_key,note)
 VALUES($1,$2,$3,$4,$5,0,0,$6,$7,$8,$9,$10) RETURNING *`,
    [
      ...scopeParams(e),
      e.userId,
      account.id,
      e.delta,
      e.source,
      e.businessType,
      e.businessId,
      e.idempotencyKey,
      e.note ?? "",
    ],
  );
  if (managed) {
    for (const g of grants)
      await tx.query(
        `INSERT INTO point_lots(brand_id,bot_id,user_id,account_id,source,source_reference,granted_amount,remaining_amount,granted_at,expires_at,policy_id,policy_version_id,policy_snapshot,positive_ledger_id,refund_allocation_id,lot_type)
   VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          ...scopeParams(e),
          e.userId,
          account.id,
          e.source,
          e.businessId,
          g.amount,
          at.toISOString(),
          g.expires,
          g.policy.policy_id ?? null,
          g.policy.id ?? null,
          JSON.stringify({
            mode: g.policy.mode ?? "permanent",
            rolling_days: g.policy.rolling_days ?? null,
            timezone: g.policy.timezone ?? "UTC",
            refund_min_compensation_days:
              g.policy.refund_min_compensation_days ?? null,
            legacy_refund: g.legacy ?? false,
          }),
          ledger.id,
          g.original ?? null,
          e.refundLedgerId ? "refund_compensation" : "normal_grant",
        ],
      );
    for (const a of allocations)
      await tx.query(
        "INSERT INTO point_lot_allocations(brand_id,bot_id,account_id,negative_ledger_id,lot_id,amount,kind) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [...scopeParams(e), account.id, ledger.id, a.lotId, a.amount, a.kind],
      );
    await assertReconciled(tx, account.id);
    await pointAudit(
      tx,
      e,
      e.expireLotId
        ? "point.expire"
        : e.refundLedgerId
          ? "point.refund"
          : BigInt(e.delta) > 0n
            ? "point.grant"
            : "point.consume",
      ledger.id,
      {
        delta: e.delta,
        businessType: e.businessType,
        businessId: e.businessId,
      },
    );
  }
  return ledger;
}
