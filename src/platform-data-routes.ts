import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { one, type Database } from "./db.js";
import type { Principal } from "./auth.js";
import {
  dataAuthorize,
  preflightImport,
  activateImport,
  maskUid,
  canonicalUid,
} from "./platform-data.js";
import { businessDate } from "./platform-data-input.js";
const scope = z.object({ brandId: z.uuid(), botId: z.uuid() });
const filters = z
  .object({
    platformId: z.uuid(),
    businessDate: z.string().refine(businessDate).optional(),
    status: z
      .enum(["ready", "active", "superseded", "review_required", "rejected"])
      .optional(),
    completeness: z
      .enum(["complete", "incomplete", "unknown", "conflicting"])
      .optional(),
    uid: z.string().max(128).optional(),
    linked: z.enum(["yes", "no"]).optional(),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();
const none = z.object({}).strict();
export function attachPlatformData(
  app: FastifyInstance,
  db: Database,
  auth: (req: FastifyRequest) => Promise<Principal>,
) {
  const base = "/v1/brands/:brandId/bots/:botId/platform-data";
  app.post(base + "/preflight", { bodyLimit: 3000000 }, async (req) => {
    none.parse(req.query);
    return preflightImport(
      db,
      await auth(req),
      scope.parse(req.params),
      req.body,
      req.id,
    );
  });
  app.post(base + "/batches/:id/activate", async (req) => {
    none.parse(req.query);
    const s = scope.extend({ id: z.uuid() }).parse(req.params);
    const v = z
      .object({ approveChanges: z.boolean().default(false) })
      .strict()
      .parse(req.body);
    return activateImport(
      db,
      await auth(req),
      s,
      s.id,
      v.approveChanges,
      req.id,
    );
  });
  app.get(base + "/batches", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const s = scope.parse(req.params),
      q = filters.parse(req.query);
    await dataAuthorize(db, await auth(req), s, "platform_data.read");
    const items = (
      await db.query(
        `SELECT id,platform_id,business_date::text,timezone,currency,source_type,original_filename,file_digest,completeness,status,row_count,accepted_rows,rejected_rows,warning_rows,created_at,activated_at FROM platform_import_batches WHERE brand_id=$1 AND platform_id=$2 AND ($3::date IS NULL OR business_date=$3) AND ($4::text IS NULL OR status=$4) AND ($5::text IS NULL OR completeness=$5) ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET $6`,
        [
          s.brandId,
          q.platformId,
          q.businessDate ?? null,
          q.status ?? null,
          q.completeness ?? null,
          q.offset,
        ],
      )
    ).rows;
    const freshness = q.businessDate
      ? (
          await db.query(
            "SELECT EXISTS(SELECT 1 FROM platform_import_batches WHERE brand_id=$1 AND platform_id=$2 AND business_date=$3 AND status='active' AND completeness='complete' AND coverage->>'kind'='full') AS complete_active",
            [s.brandId, q.platformId, q.businessDate],
          )
        ).rows[0]
      : null;
    return {
      items,
      freshness,
      nextOffset: items.length === 50 ? q.offset + 50 : null,
    };
  });
  app.get(base + "/batches/:id", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    none.parse(req.query);
    const s = scope.extend({ id: z.uuid() }).parse(req.params);
    await dataAuthorize(db, await auth(req), s, "platform_data.read");
    const batch = await one(
      db,
      "SELECT *,business_date::text AS business_date FROM platform_import_batches WHERE brand_id=$1 AND id=$2",
      [s.brandId, s.id],
    );
    const rows = (
      await db.query(
        "SELECT e.id,e.row_number,e.normalized,e.issues,e.expected_revision_id,r.normalized AS previous_values FROM platform_import_evidence e LEFT JOIN platform_user_daily_fact_revisions r ON r.id=e.expected_revision_id WHERE e.brand_id=$1 AND e.batch_id=$2 ORDER BY e.row_number",
        [s.brandId, s.id],
      )
    ).rows;
    return {
      batch,
      rows: rows.map((r) => {
        const { uid, login_account, ...values } = r.normalized;
        const {
          uid: oldUid,
          login_account: oldLogin,
          ...oldValues
        } = r.previous_values ?? {};
        return {
          id: r.id,
          rowNumber: r.row_number,
          uidMasked: uid ? maskUid(uid) : null,
          values,
          previousValues: r.previous_values ? oldValues : null,
          issues: r.issues,
          expectedRevisionId: r.expected_revision_id,
        };
      }),
    };
  });
  app.get(base + "/batches/:id/evidence/:evidenceId", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    none.parse(req.query);
    const s = scope
      .extend({ id: z.uuid(), evidenceId: z.uuid() })
      .parse(req.params);
    const p = await auth(req);
    await dataAuthorize(db, p, s, "platform_data.import");
    return one(
      db,
      "SELECT id,row_number,row_digest,raw_values FROM platform_import_evidence WHERE brand_id=$1 AND batch_id=$2 AND id=$3",
      [s.brandId, s.id, s.evidenceId],
    );
  });
  app.get(base + "/facts", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const s = scope.parse(req.params),
      q = filters.parse(req.query);
    await dataAuthorize(db, await auth(req), s, "platform_data.read");
    const platform = await one(
      db,
      "SELECT * FROM platforms WHERE brand_id=$1 AND id=$2",
      [s.brandId, q.platformId],
    );
    const items = (
      await db.query(
        `SELECT f.id,f.business_date::text,a.platform_uid,r.id AS revision_id,r.data_version,r.batch_id,r.identity_id,r.deposit::text,r.withdrawal::text,r.source_net::text,r.bet::text,r.payout::text,r.game_profit::text,b.completeness FROM platform_user_daily_facts f JOIN platform_accounts a ON a.id=f.account_id JOIN platform_user_daily_fact_revisions r ON r.id=f.current_revision_id JOIN platform_import_batches b ON b.id=r.batch_id WHERE f.brand_id=$1 AND f.platform_id=$2 AND ($3::date IS NULL OR f.business_date=$3) AND ($4::text IS NULL OR a.platform_uid=$4) AND ($5::text IS NULL OR b.completeness=$5) AND ($6::text IS NULL OR ($6='yes')=(r.identity_id IS NOT NULL)) ORDER BY f.business_date DESC,f.id LIMIT 50 OFFSET $7`,
        [
          s.brandId,
          q.platformId,
          q.businessDate ?? null,
          q.uid ? canonicalUid(q.uid, platform) : null,
          q.completeness ?? null,
          q.linked ?? null,
          q.offset,
        ],
      )
    ).rows;
    return {
      items: items.map(({ platform_uid, ...r }) => ({
        ...r,
        uidMasked: maskUid(platform_uid),
      })),
      nextOffset: items.length === 50 ? q.offset + 50 : null,
    };
  });
  app.get(base + "/facts/:id", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    none.parse(req.query);
    const s = scope.extend({ id: z.uuid() }).parse(req.params);
    await dataAuthorize(db, await auth(req), s, "platform_data.read");
    const fact = await one(
      db,
      "SELECT id,platform_id,account_id,business_date::text,current_revision_id FROM platform_user_daily_facts WHERE brand_id=$1 AND id=$2",
      [s.brandId, s.id],
    );
    const revisions = (
      await db.query(
        "SELECT id,data_version,supersedes,batch_id,evidence_id,identity_id,reason,imported_at,normalized FROM platform_user_daily_fact_revisions WHERE brand_id=$1 AND fact_id=$2 ORDER BY data_version DESC",
        [s.brandId, s.id],
      )
    ).rows;
    return {
      fact,
      revisions: revisions.map(({ normalized, ...r }) => {
        const { uid, login_account, ...values } = normalized;
        return {
          ...r,
          uidMasked: maskUid(uid),
          values,
          current: r.id === fact.current_revision_id,
        };
      }),
    };
  });
}
