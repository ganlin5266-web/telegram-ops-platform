import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Principal } from "./auth.js";
import { authorize } from "./auth.js";
import { one, scopeParams, type Database } from "./db.js";
import {
  createPolicy,
  publishPolicy,
  pointSummary,
  reconcileAccount,
  lotsEnabled,
  normalizePolicy,
} from "./point-lots.js";
const scope = z.object({ brandId: z.uuid(), botId: z.uuid() });
export function attachPointExpiry(
  app: FastifyInstance,
  db: Database,
  auth: (r: FastifyRequest) => Promise<Principal>,
) {
  const base = "/v1/brands/:brandId/bots/:botId/point-expiry";
  app.get(`${base}/policies`, async (req) => {
    const s = scope.parse(req.params),
      p = await auth(req);
    await authorize(db, p, s, "points.expiry.read");
    const present = await one(
      db,
      "SELECT to_regclass('point_expiry_policies') IS NOT NULL AS ready",
    );
    if (!present.ready)
      return { schemaReady: false, enabled: false, items: [] };
    return {
      schemaReady: true,
      enabled: lotsEnabled(),
      items: (
        await db.query(
          `SELECT p.id,p.name,p.source,COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.version DESC) FILTER(WHERE v.id IS NOT NULL),'[]') AS versions FROM point_expiry_policies p LEFT JOIN point_expiry_policy_versions v ON v.policy_id=p.id WHERE p.brand_id=$1 AND p.bot_id=$2 GROUP BY p.id ORDER BY p.created_at DESC LIMIT 100`,
          scopeParams(s),
        )
      ).rows,
    };
  });
  app.post(`${base}/policies/preview`, async (req) => {
    const s = scope.parse(req.params),
      p = await auth(req);
    await authorize(db, p, s, "points.expiry.manage");
    return {
      policy: await normalizePolicy(db, req.body),
      existingLotsUnchanged: true,
    };
  });
  app.post(`${base}/policies`, async (req) => {
    const s = scope.parse(req.params),
      p = await auth(req);
    return db.transaction(async (tx) => {
      await authorize(tx, p, s, "points.expiry.manage");
      return createPolicy(tx, s, p.adminId, req.body, req.id);
    });
  });
  app.post(`${base}/policies/:versionId/publish`, async (req) => {
    const s = scope.extend({ versionId: z.uuid() }).parse(req.params),
      p = await auth(req);
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    return db.transaction(async (tx) => {
      await authorize(tx, p, s, "points.expiry.manage");
      return publishPolicy(tx, s, p.adminId, s.versionId, req.id);
    });
  });
  app.get(`${base}/lots`, async (req) => {
    const s = scope.parse(req.params),
      p = await auth(req);
    await authorize(db, p, s, "points.expiry.read");
    const q = z
      .object({
        userId: z.uuid().optional(),
        accountId: z.uuid().optional(),
        source: z.string().max(80).optional(),
        status: z.enum(["available", "depleted", "expired"]).optional(),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
        expiresBefore: z.iso.datetime({ offset: true }).optional(),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .strict()
      .parse(req.query);
    const status = `CASE WHEN expires_at<=statement_timestamp() THEN 'expired' WHEN remaining_amount=0 THEN 'depleted' ELSE 'available' END`;
    return {
      items: (
        await db.query(
          `SELECT id,user_id,account_id,source,granted_amount::text,remaining_amount::text,granted_at,expires_at,lot_type,COALESCE(policy_snapshot->>'timezone','UTC') AS timezone,${status} AS status FROM point_lots WHERE brand_id=$1 AND bot_id=$2
   AND ($3::uuid IS NULL OR user_id=$3) AND ($4::uuid IS NULL OR account_id=$4) AND ($5::text IS NULL OR source=$5) AND ($6::text IS NULL OR ${status}=$6)
   AND ($7::timestamptz IS NULL OR granted_at>=$7) AND ($8::timestamptz IS NULL OR granted_at<$8) AND ($9::timestamptz IS NULL OR expires_at<=$9)
   ORDER BY granted_at DESC,id DESC LIMIT 50 OFFSET $10`,
          [
            ...scopeParams(s),
            q.userId ?? null,
            q.accountId ?? null,
            q.source ?? null,
            q.status ?? null,
            q.from ?? null,
            q.to ?? null,
            q.expiresBefore ?? null,
            q.offset,
          ],
        )
      ).rows,
    };
  });
  app.get(`${base}/lots/:lotId`, async (req) => {
    const s = scope.extend({ lotId: z.uuid() }).parse(req.params),
      p = await auth(req);
    await authorize(db, p, s, "points.expiry.read");
    const lot = await one(
      db,
      "SELECT *,granted_amount::text,remaining_amount::text FROM point_lots WHERE brand_id=$1 AND bot_id=$2 AND id=$3",
      [...scopeParams(s), s.lotId],
    );
    const allocations = (
      await db.query(
        "SELECT *,amount::text FROM point_lot_allocations WHERE lot_id=$1 ORDER BY created_at,id",
        [lot.id],
      )
    ).rows;
    const refunds = (
      await db.query(
        "SELECT id,positive_ledger_id,refund_allocation_id,granted_amount::text,expires_at FROM point_lots WHERE refund_allocation_id=ANY($1::uuid[])",
        [allocations.map((a) => a.id)],
      )
    ).rows;
    const ledger = lot.positive_ledger_id
      ? (
          await db.query(
            "SELECT id,delta::text,business_type,business_id,created_at FROM point_ledger WHERE id=$1",
            [lot.positive_ledger_id],
          )
        ).rows[0]
      : null;
    const audit = (
      await db.query(
        `SELECT id,action,admin_id,created_at,request_id FROM audit_logs WHERE brand_id=$1 AND bot_id=$2 AND object_type='point_expiry' AND object_id=ANY($3::text[]) ORDER BY created_at,id`,
        [
          ...scopeParams(s),
          [
            lot.opening_id,
            lot.positive_ledger_id,
            lot.policy_version_id,
            ...allocations.map((a) => a.negative_ledger_id),
            ...refunds.map((r) => r.positive_ledger_id),
          ].filter(Boolean),
        ],
      )
    ).rows;
    return {
      lot,
      allocations,
      refunds,
      ledger,
      audit,
      summary: await pointSummary(db, { ...s, userId: lot.user_id }),
      reconciliation: lotsEnabled()
        ? await reconcileAccount(db, lot.account_id)
        : { consistent: null, status: "not_enabled" },
    };
  });
  app.get(`${base}/accounts/:userId`, async (req) => {
    const s = scope.extend({ userId: z.uuid() }).parse(req.params),
      p = await auth(req);
    await authorize(db, p, s, "points.expiry.read");
    await one(
      db,
      "SELECT id FROM telegram_users WHERE brand_id=$1 AND bot_id=$2 AND id=$3",
      [...scopeParams(s), s.userId],
    );
    const a = (
      await db.query(
        "SELECT id FROM point_accounts WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3",
        [...scopeParams(s), s.userId],
      )
    ).rows[0];
    return {
      summary: await pointSummary(db, s),
      reconciliation:
        a && lotsEnabled()
          ? await reconcileAccount(db, a.id)
          : { consistent: null, status: "not_enabled_or_no_account" },
    };
  });
}
