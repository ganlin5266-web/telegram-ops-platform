import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authorize, type Principal } from "./auth.js";
import { one, type Database } from "./db.js";
import { maskUid } from "./platform-identities.js";
import {
  dateInput,
  ruleInput,
  decideEntitlement,
  amountInput,
} from "./entitlement-domain.js";
import {
  entitlementsEnabled,
  createEntitlementRule,
  changeEntitlementRule,
  scheduleEntitlements,
  runEntitlementTasks,
} from "./entitlements.js";
const scope = z.object({ brandId: z.uuid(), botId: z.uuid() });
export function attachEntitlements(
  app: FastifyInstance,
  db: Database,
  auth: (r: FastifyRequest) => Promise<Principal>,
) {
  const base = "/v1/brands/:brandId/bots/:botId/entitlements";
  app.get(base + "/platforms", async (req) => {
    const s = scope.parse(req.params);
    await authorize(db, await auth(req), s, "entitlements.read");
    return {
      items: (
        await db.query(
          "SELECT id,display_name,currency,timezone FROM platforms WHERE brand_id=$1 ORDER BY display_name,id",
          [s.brandId],
        )
      ).rows,
    };
  });
  app.get(base + "/mapping-batches", async (req) => {
    const s = scope.parse(req.params);
    await authorize(db, await auth(req), s, "entitlements.rules.manage");
    const q = z.object({ platformId: z.uuid() }).strict().parse(req.query);
    return {
      items: (
        await db.query(
          "SELECT id,business_date::text,status FROM platform_import_batches WHERE brand_id=$1 AND platform_id=$2 ORDER BY created_at DESC LIMIT 100",
          [s.brandId, q.platformId],
        )
      ).rows,
    };
  });
  app.get(base + "/rules", async (req) => {
    const s = scope.parse(req.params);
    await authorize(db, await auth(req), s, "entitlements.read");
    if (
      !(
        await one(
          db,
          "SELECT to_regclass('entitlement_rules') IS NOT NULL AS ready",
        )
      ).ready
    )
      return { schemaReady: false, enabled: false, items: [] };
    const rows = (
      await db.query(
        `SELECT r.id,r.name,r.platform_id,v.id AS version_id,v.version,v.status,v.metric,v.currency,v.operator,v.source_timezone,v.entitlement_timezone,v.cutoff_time,v.effective_from::text,v.effective_until::text,v.mapping_approval,coalesce(jsonb_agg(jsonb_build_object('key',t.tier_key,'name',t.display_name,'threshold',t.threshold::text) ORDER BY t.position) FILTER(WHERE t.id IS NOT NULL),'[]') AS tiers FROM entitlement_rules r LEFT JOIN entitlement_rule_versions v ON v.rule_id=r.id LEFT JOIN entitlement_rule_tiers t ON t.version_id=v.id WHERE r.brand_id=$1 AND r.bot_id=$2 GROUP BY r.id,v.id ORDER BY r.created_at DESC,v.version DESC LIMIT 100`,
        [s.brandId, s.botId],
      )
    ).rows;
    return {
      schemaReady: true,
      enabled: entitlementsEnabled(),
      visibility: "ADMIN_ONLY",
      items: rows,
    };
  });
  app.post(base + "/rules", async (req) =>
    createEntitlementRule(
      db,
      await auth(req),
      scope.parse(req.params),
      req.body,
      req.id,
    ),
  );
  app.post(base + "/rules/preview", async (req) => {
    const s = scope.parse(req.params);
    await authorize(db, await auth(req), s, "entitlements.rules.manage");
    const b = z
      .object({ rule: ruleInput, value: amountInput })
      .strict()
      .parse(req.body);
    return decideEntitlement({
      identityStatus: "verified",
      ruleAvailable: true,
      factPresent: true,
      completeness: "complete",
      metricAvailable: true,
      mappingCompatible: true,
      value: b.value,
      factCurrency: b.rule.currency,
      ruleCurrency: b.rule.currency,
      cutoffReached: false,
      tiers: b.rule.tiers,
    });
  });
  for (const action of ["publish", "retire"] as const)
    app.post(base + `/rules/:id/${action}`, async (req) => {
      const s = scope.extend({ id: z.uuid() }).parse(req.params);
      z.object({ confirm: z.literal(true) })
        .strict()
        .parse(req.body);
      return changeEntitlementRule(
        db,
        await auth(req),
        s,
        s.id,
        action,
        req.id,
      );
    });
  app.get(base + "/daily", async (req) => {
    const s = scope.parse(req.params),
      p = await auth(req);
    await authorize(db, p, s, "entitlements.read");
    const q = z
      .object({
        platformId: z.uuid(),
        date: dateInput,
        status: z
          .enum(["pending", "eligible", "ineligible", "review_required"])
          .optional(),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .strict()
      .parse(req.query);
    let sensitive = false;
    try {
      await authorize(db, p, s, "entitlements.explain_sensitive");
      sensitive = true;
    } catch {}
    const rows = (
      await db.query(
        `SELECT d.id,d.user_id,d.platform_id,d.entitlement_date::text,r.id AS revision_id,r.revision_number,r.status,r.reason_code,r.matched_tier,r.metric,r.source_value::text,r.daily_fact_revision_id,r.rule_version_id,r.calculated_at,i.platform_uid FROM daily_entitlements d JOIN daily_entitlement_revisions r ON r.id=d.current_revision_id LEFT JOIN platform_identities i ON i.id=r.platform_identity_id WHERE d.brand_id=$1 AND d.bot_id=$2 AND d.platform_id=$3 AND d.entitlement_date=$4 AND ($5::text IS NULL OR r.status=$5) ORDER BY d.id LIMIT 50 OFFSET $6`,
        [s.brandId, s.botId, q.platformId, q.date, q.status ?? null, q.offset],
      )
    ).rows;
    return {
      items: rows.map(({ platform_uid, source_value, ...r }) => ({
        ...r,
        uidMasked: platform_uid ? maskUid(platform_uid) : null,
        ...(sensitive ? { source_value } : {}),
      })),
      nextOffset: rows.length === 50 ? q.offset + 50 : null,
    };
  });
  app.get(base + "/daily/:id", async (req) => {
    const s = scope.extend({ id: z.uuid() }).parse(req.params),
      p = await auth(req);
    await authorize(db, p, s, "entitlements.read");
    const subject = await one(
      db,
      "SELECT *,entitlement_date::text FROM daily_entitlements WHERE brand_id=$1 AND bot_id=$2 AND id=$3",
      [s.brandId, s.botId, s.id],
    );
    let sensitive = false;
    try {
      await authorize(db, p, s, "entitlements.explain_sensitive");
      sensitive = true;
    } catch {}
    const rows = (
      await db.query(
        `SELECT r.*,r.source_value::text,r.source_business_date::text,r.entitlement_date::text,f.batch_id,f.evidence_id,b.mapping->>'adapterId' AS adapter_id,b.mapping->>'mappingVersion' AS mapping_version FROM daily_entitlement_revisions r LEFT JOIN platform_user_daily_fact_revisions f ON f.id=r.daily_fact_revision_id LEFT JOIN platform_import_batches b ON b.id=f.batch_id WHERE r.daily_entitlement_id=$1 ORDER BY revision_number DESC LIMIT 100`,
        [s.id],
      )
    ).rows;
    return {
      subject,
      revisions: rows.map(
        ({
          source_value,
          identity_snapshot,
          input_fingerprint,
          source_metric_semantics,
          result_snapshot,
          ...r
        }) => ({
          ...r,
          ...(sensitive
            ? {
                source_value,
                identity_snapshot,
                source_metric_semantics,
                result_snapshot,
              }
            : {}),
        }),
      ),
    };
  });
  app.get(base + "/sla", async (req) => {
    const s = scope.parse(req.params);
    await authorize(db, await auth(req), s, "entitlements.read");
    const q = z
      .object({ platformId: z.uuid(), date: dateInput })
      .strict()
      .parse(req.query);
    return {
      items: (
        await db.query(
          `SELECT r.status,r.reason_code,count(*)::int AS users,count(f.id) FILTER(WHERE f.resolved_at IS NULL)::int AS sla_open FROM daily_entitlements d JOIN daily_entitlement_revisions r ON r.id=d.current_revision_id LEFT JOIN entitlement_sla_findings f ON f.daily_entitlement_id=d.id WHERE d.brand_id=$1 AND d.bot_id=$2 AND d.platform_id=$3 AND d.entitlement_date=$4 GROUP BY r.status,r.reason_code`,
          [s.brandId, s.botId, q.platformId, q.date],
        )
      ).rows,
    };
  });
  app.get(base + "/tasks", async (req) => {
    const s = scope.parse(req.params);
    await authorize(db, await auth(req), s, "entitlements.read");
    return {
      items: (
        await db.query(
          "SELECT id,platform_id,user_id,entitlement_date::text,trigger_reason,status,attempts,next_attempt_at,last_error_code,outcome,completed_at FROM entitlement_evaluation_tasks WHERE brand_id=$1 AND bot_id=$2 ORDER BY created_at DESC LIMIT 100",
          [s.brandId, s.botId],
        )
      ).rows,
    };
  });
  app.post(base + "/recalculate", async (req) => {
    const s = scope.parse(req.params),
      p = await auth(req);
    await authorize(db, p, s, "entitlements.recalculate");
    const v = z
      .object({
        platformId: z.uuid(),
        date: dateInput,
        userId: z.uuid().optional(),
        reason: z.string().regex(/^[a-z][a-z_]{2,63}$/),
      })
      .strict()
      .parse(req.body);
    const result = await scheduleEntitlements(
      db,
      s,
      v.platformId,
      v.date,
      "manual_recalculate",
      req.id,
      v.userId,
      p.adminId,
      v.reason,
    );
    return result;
  });
  app.post(base + "/tasks/run", async (req) => {
    const s = scope.parse(req.params);
    await authorize(db, await auth(req), s, "entitlements.recalculate");
    const v = z
      .object({ limit: z.number().int().min(1).max(50).default(20) })
      .strict()
      .parse(req.body);
    return { items: await runEntitlementTasks(db, s, v.limit) };
  });
}
