import { createHash, randomUUID } from "node:crypto";
import {
  DomainError,
  one,
  scopeParams,
  type Database,
  type Queryable,
  type Scope,
} from "./db.js";
import { postPoints } from "./points.js";
import { assertReconciled, lotsEnabled, pointAudit } from "./point-lots.js";
export async function legacyPreflight(tx: Queryable, s: Scope) {
  const row = await one(
    tx,
    `SELECT count(*)::int AS accounts,count(*) FILTER(WHERE balance>0)::int AS positive_accounts,
 COALESCE(sum(balance),0)::text AS balance,
 count(*) FILTER(WHERE balance<>(SELECT COALESCE(sum(delta),0) FROM point_ledger l WHERE l.account_id=a.id))::int AS mismatches
 FROM point_accounts a WHERE brand_id=$1 AND bot_id=$2`,
    scopeParams(s),
  );
  const ledger = await one(
    tx,
    "SELECT count(*)::int AS count,COALESCE(sum(delta),0)::text AS total FROM point_ledger WHERE brand_id=$1 AND bot_id=$2",
    scopeParams(s),
  );
  const orders = await one(
    tx,
    `SELECT count(*)::int AS unfinished,count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM point_ledger l WHERE l.brand_id=r.brand_id AND l.bot_id=r.bot_id AND l.user_id=r.user_id AND l.business_type='redemption_debit' AND l.business_id=r.id::text AND l.delta=-r.points_cost))::int AS unclassified
 FROM redemptions r WHERE brand_id=$1 AND bot_id=$2 AND status IN ('pending','processing')`,
    scopeParams(s),
  );
  return {
    accounts: Number(row.accounts),
    positiveAccounts: Number(row.positive_accounts),
    balance: String(row.balance),
    mismatches: Number(row.mismatches),
    ledgerCount: ledger.count,
    ledgerSum: ledger.total,
    unfinished: orders.unfinished,
    unclassified: orders.unclassified,
    ready:
      row.mismatches === 0 &&
      row.balance === ledger.total &&
      orders.unclassified === 0,
  };
}
// Owner-only maintenance primitive. Never called from API/startup/seed. CLI approval is separate.
export async function cutoverBot(tx: Queryable, s: Scope) {
  const owner = await one(
    tx,
    "SELECT pg_get_userbyid(relowner)=current_user AS owner FROM pg_class WHERE oid='point_lot_openings'::regclass",
  );
  if (!owner.owner) throw new DomainError("maintenance_owner_required");
  await one(
    tx,
    "SELECT id FROM telegram_bots WHERE brand_id=$1 AND id=$2 FOR UPDATE",
    scopeParams(s),
  );
  const done =
    (
      await tx.query(
        "SELECT bot_id FROM point_lot_cutovers WHERE brand_id=$1 AND bot_id=$2",
        scopeParams(s),
      )
    ).rows.length > 0;
  const accounts = (
    await tx.query(
      "SELECT * FROM point_accounts WHERE brand_id=$1 AND bot_id=$2 ORDER BY id FOR UPDATE",
      scopeParams(s),
    )
  ).rows;
  if (done) {
    for (const a of accounts) await assertReconciled(tx, a.id);
    return { status: "already_cut_over", openings: 0 };
  }
  const pre = await legacyPreflight(tx, s);
  if (!pre.ready) throw new DomainError("legacy_preflight_mismatch");
  let openings = 0;
  for (const a of accounts) {
    const entries = (
      await tx.query(
        "SELECT id,delta::text,created_at FROM point_ledger WHERE account_id=$1 ORDER BY created_at,id",
        [a.id],
      )
    ).rows;
    if (BigInt(a.balance) === 0n) continue;
    const opening = await one(
      tx,
      `INSERT INTO point_lot_openings(account_id,balance_snapshot,ledger_count,ledger_watermark,ledger_fingerprint) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [
        a.id,
        String(a.balance),
        entries.length,
        entries.at(-1)?.id ?? null,
        createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
      ],
    );
    await tx.query(
      `INSERT INTO point_lots(brand_id,bot_id,user_id,account_id,source,source_reference,granted_amount,remaining_amount,policy_snapshot,opening_id,lot_type) VALUES($1,$2,$3,$4,'legacy_opening',$5::text,$6,$6,'{"mode":"permanent","legacy":true}',$5::uuid,'legacy_opening')`,
      [...scopeParams(s), a.user_id, a.id, opening.id, String(a.balance)],
    );
    await pointAudit(tx, s, "legacy_opening.create", opening.id, {
      accountId: a.id,
      amount: String(a.balance),
    });
    openings++;
  }
  await tx.query(
    "INSERT INTO point_lot_cutovers(brand_id,bot_id,evidence) VALUES($1,$2,$3)",
    [...scopeParams(s), JSON.stringify(pre)],
  );
  for (const a of accounts) await assertReconciled(tx, a.id);
  return { status: "cut_over", openings };
}
// Bounded, resumable scan. Due lots themselves are the durable queue; no in-memory cursor.
export async function expirePointsBatch(db: Database, limit = 50) {
  if (!lotsEnabled()) throw new DomainError("point_lots_disabled");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new DomainError("invalid_batch_size", 400);
  const jobId = randomUUID();
  const due = (
    await db.query(
      `SELECT id,brand_id,bot_id,account_id,user_id FROM point_lots
 WHERE remaining_amount>0 AND expires_at<=statement_timestamp() ORDER BY expires_at,id LIMIT $1`,
      [limit],
    )
  ).rows;
  let expired = 0;
  for (const ref of due) {
    await db.transaction(async (tx) => {
      await one(
        tx,
        "SELECT id FROM telegram_bots WHERE brand_id=$1 AND id=$2 FOR UPDATE",
        [ref.brand_id, ref.bot_id],
      );
      await one(tx, "SELECT id FROM point_accounts WHERE id=$1 FOR UPDATE", [
        ref.account_id,
      ]);
      const lot = await one(
        tx,
        "SELECT * FROM point_lots WHERE id=$1 FOR UPDATE",
        [ref.id],
      );
      const at = await one(tx, "SELECT clock_timestamp() AS at");
      if (
        BigInt(lot.remaining_amount) === 0n ||
        new Date(lot.expires_at) > new Date(at.at)
      )
        return;
      await postPoints(tx, {
        brandId: lot.brand_id,
        botId: lot.bot_id,
        userId: lot.user_id,
        delta: (-BigInt(lot.remaining_amount)).toString(),
        source: "expiry",
        businessType: "point_expired",
        businessId: lot.id,
        idempotencyKey: `expiry:${lot.id}`,
        expireLotId: lot.id,
        note: `expiry job ${jobId}`,
      });
      expired++;
    });
  }
  return { jobId, examined: due.length, expired };
}
