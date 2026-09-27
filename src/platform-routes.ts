import {miniDataStatus} from './platform-data.js';
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DomainError, one, type Database } from "./db.js";
import { authorize, type Principal } from "./auth.js";
import { authenticateMini, type MiniAppBinding } from "./mini-sessions.js";
import { requireRecoveryProtection } from "./mini-recovery.js";
import {
  createPlatform,
  authorizePlatformBrand,
  submitIdentity,
  reviewIdentity,
  safeIdentity,
} from "./platform-identities.js";
import { binding, encodeCursor, decodeCursor } from "./query-cursor.js";
const none = z.object({}).strict(),
  scope = z.object({ brandId: z.uuid(), botId: z.uuid() });
const paging = z
  .object({
    cursor: z.string().max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    status: z
      .enum(["pending", "verified", "rejected", "conflict", "revoked"])
      .optional(),
  })
  .strict();
async function identityList(
  db: Database,
  brandId: string,
  botId: string,
  userId: string | null,
  query: unknown,
) {
  const q = paging.parse(query),
    ctx = binding([
      "platform-identities",
      brandId,
      botId,
      userId ?? "admin",
      q.status ?? "all",
    ]);
  const c = q.cursor ? decodeCursor(q.cursor, ctx) : undefined;
  const rows = (
    await db.query(
      `SELECT i.*,p.display_name FROM platform_identities i JOIN platforms p ON (p.brand_id,p.id)=(i.brand_id,i.platform_id)
 WHERE i.brand_id=$1 AND i.bot_id=$2 AND ($3::uuid IS NULL OR i.user_id=$3) AND ($4::text IS NULL OR i.status=$4)
 AND ($5::timestamptz IS NULL OR (i.submitted_at,i.id)<($5::timestamptz,$6::uuid)) ORDER BY i.submitted_at DESC,i.id DESC LIMIT $7`,
      [
        brandId,
        botId,
        userId,
        q.status ?? null,
        c?.value ?? null,
        c?.id ?? null,
        q.limit + 1,
      ],
    )
  ).rows;
  const items = rows.slice(0, q.limit),
    last = items.at(-1);
  return {
    items: items.map((r) => safeIdentity(r, userId === null)),
    nextCursor:
      rows.length > q.limit && last
        ? encodeCursor(ctx, last.id, new Date(last.submitted_at).toISOString())
        : null,
  };
}
export function attachMiniPlatforms(
  app: FastifyInstance,
  db: Database,
  bindings: MiniAppBinding[],
) {
  const auth = (req: FastifyRequest) =>
    authenticateMini(
      db,
      req.headers.authorization,
      bindings,
      req.headers.origin,
    );
  app.get("/platform-data-status", async (req,reply) => { none.parse(req.query); reply.header("Cache-Control","no-store"); return miniDataStatus(db,await auth(req)); });
  app.get("/platforms", async (req) => {
    none.parse(req.query);
    const p = await auth(req);
    // Current own identity is returned separately from history pagination so an old
    // verified record cannot disappear behind later rejected attempts.
    const rows = (
      await db.query(
        `SELECT p.id,p.display_name,p.code,p.status,p.verification_method,p.uid_format,p.uid_min_length,p.uid_max_length,
   (SELECT row_to_json(x) FROM (SELECT i.* FROM platform_identities i WHERE i.brand_id=p.brand_id AND i.platform_id=p.id AND i.bot_id=$2 AND i.user_id=$3 ORDER BY (i.status IN ('pending','verified')) DESC,i.submitted_at DESC,i.id DESC LIMIT 1) x) AS identity
   FROM platforms p WHERE p.brand_id=$1 ORDER BY p.display_name,p.id`,
        [p.brandId, p.botId, p.userId],
      )
    ).rows;
    return {
      items: rows.map((r) => ({
        ...r,
        identity: r.identity
          ? safeIdentity({ ...r.identity, display_name: r.display_name })
          : null,
      })),
    };
  });
  app.get("/platform-identities", async (req) => {
    const p = await auth(req);
    return identityList(db, p.brandId, p.botId, p.userId, req.query);
  });
  app.post("/platform-identities", { bodyLimit: 2048 }, async (req) => {
    none.parse(req.query);
    requireRecoveryProtection(req.headers);
    const p = await auth(req);
    const body = z
      .object({ platformId: z.uuid(), uid: z.string().min(1).max(128) })
      .strict()
      .parse(req.body);
    return submitIdentity(
      db,
      p,
      body.platformId,
      body.uid,
      z.uuid().parse(req.headers["idempotency-key"]),
      req.id,
    );
  });
}
export function attachAdminPlatforms(
  app: FastifyInstance,
  db: Database,
  auth: (req: FastifyRequest) => Promise<Principal>,
) {
  const base = "/v1/brands/:brandId/bots/:botId";
  app.get(base + "/platforms", async (req) => {
    none.parse(req.query);
    const s = scope.parse(req.params),
      p = await auth(req);
    await authorize(db, p, s, "platforms.read");
    return {
      items: (
        await db.query(
          "SELECT * FROM platforms WHERE brand_id=$1 ORDER BY display_name,id",
          [s.brandId],
        )
      ).rows,
    };
  });
  app.post(base + "/platforms", async (req) => {
    none.parse(req.query);
    return createPlatform(
      db,
      await auth(req),
      scope.parse(req.params),
      req.body,
      req.id,
    );
  });
  app.post(base + "/platforms/:platformId/status", async (req) => {
    none.parse(req.query);
    const s = scope.extend({ platformId: z.uuid() }).parse(req.params),
      p = await auth(req),
      v = z
        .object({ status: z.enum(["active", "disabled"]) })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      await authorizePlatformBrand(tx, p, s);
      const before = await one(
        tx,
        "SELECT * FROM platforms WHERE brand_id=$1 AND id=$2 FOR UPDATE",
        [s.brandId, s.platformId],
      );
      if (before.status === v.status) return { ok: true };
      await tx.query(
        "UPDATE platforms SET status=$3,updated_at=now() WHERE brand_id=$1 AND id=$2",
        [s.brandId, s.platformId, v.status],
      );
      await tx.query(
        "INSERT INTO audit_logs(admin_id,brand_id,action,object_type,object_id,request_id,after_data) VALUES($1,$2,'platform.status','platform',$3,$4,$5)",
        [p.adminId, s.brandId, s.platformId, req.id, JSON.stringify(v)],
      );
      return { ok: true };
    });
  });
  app.get(base + "/platform-identities", async (req) => {
    const s = scope.parse(req.params),
      p = await auth(req);
    await authorize(db, p, s, "platform_identities.read");
    const { userId, ...query } = paging.extend({ userId: z.uuid().optional() }).parse(req.query);
    return identityList(db, s.brandId, s.botId, userId ?? null, query);
  });
  app.get(base + "/platform-identities/:identityId", async (req) => {
    none.parse(req.query);
    const s = scope.extend({ identityId: z.uuid() }).parse(req.params),
      p = await auth(req);
    await authorize(db, p, s, "platform_identities.verify");
    const r = await one(
      db,
      "SELECT i.*,p.display_name FROM platform_identities i JOIN platforms p ON (p.brand_id,p.id)=(i.brand_id,i.platform_id) WHERE i.brand_id=$1 AND i.bot_id=$2 AND i.id=$3",
      [s.brandId, s.botId, s.identityId],
    );
    // Full UID only in explicit permission-protected detail; never list/error/audit.
    return {
      ...safeIdentity(r, true),
      uid: r.platform_uid,
      evidenceReference: r.evidence_reference,
    };
  });
  app.post(base + "/platform-identities/:identityId/review", async (req) => {
    none.parse(req.query);
    const s = scope.extend({ identityId: z.uuid() }).parse(req.params);
    return reviewIdentity(
      db,
      await auth(req),
      s,
      s.identityId,
      req.body,
      req.id,
    );
  });
}
