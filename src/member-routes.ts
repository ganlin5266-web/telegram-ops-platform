import { resolveMappingSemantics } from "./entitlement-mapping.js";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { DomainError, one, type Database } from "./db.js";
import { authorize, type Principal } from "./auth.js";
import { authenticateMini, type MiniAppBinding } from "./mini-sessions.js";
import { dateInput } from "./entitlement-domain.js";
import {
  levelConfig,
  platformConfig,
  platformGrowth,
  validateConfig,
  versionInput,
} from "./member-domain.js";
import {
  memberSchema,
  memberGrowthEnabled,
  memberAuthorize,
  createMemberRule,
  publishMemberRule,
  dryRunMembers,
  adjustGrowth,
  miniMemberSummary,
  checkinGrowth,
} from "./member-growth.js";
const brand = z.object({ brandId: z.uuid() });
const page = z
  .object({
    after: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
const confirmKey = randomBytes(32);
function signature(payload: string) {
  return createHmac("sha256", confirmKey).update(payload).digest("hex");
}
const adjustment = z
  .object({
    delta: z.string().regex(/^-?[1-9]\d{0,8}$/),
    reason: z.string().trim().min(1).max(100),
    key: z.uuid(),
    confirmation: z.string().max(2000).optional(),
  })
  .strict();
function confirmationPayload(
  adminId: string,
  brandId: string,
  memberId: string,
  b: z.infer<typeof adjustment>,
  expires: number,
) {
  return JSON.stringify([
    adminId,
    brandId,
    memberId,
    b.delta,
    b.reason,
    b.key,
    expires,
  ]);
}
export function attachMembers(
  app: FastifyInstance,
  db: Database,
  auth: (r: FastifyRequest) => Promise<Principal>,
) {
  const base = "/v1/brands/:brandId/members";
  app.get(base + "/status", async (req) => {
    const { brandId } = brand.parse(req.params);
    await memberAuthorize(db, await auth(req), brandId, "members.read");
    return {
      schemaReady: await memberSchema(db),
      enabled: memberGrowthEnabled(),
      visibility: "STAGING_TEST_ONLY",
    };
  });
  app.get(base, async (req) => {
    const { brandId } = brand.parse(req.params);
    await memberAuthorize(db, await auth(req), brandId, "members.read");
    const q = page.parse(req.query);
    if (!(await memberSchema(db))) return { available: false, items: [] };
    const rows = (
      await db.query(
        `SELECT m.id,m.level,a.balance::text AS growth,m.initialized_at FROM members m JOIN growth_accounts a ON a.member_id=m.id WHERE m.brand_id=$1 AND ($2::uuid IS NULL OR m.id>$2) ORDER BY m.id LIMIT $3`,
        [brandId, q.after ?? null, q.limit + 1],
      )
    ).rows;
    return {
      available: true,
      items: rows.slice(0, q.limit),
      next: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
    };
  });
  app.get(base + "/cutover-preview", async (req) => {
    const { brandId } = brand.parse(req.params);
    await memberAuthorize(db, await auth(req), brandId, "growth.rules.manage");
    return {
      readonly: true,
      initialLevel: 1,
      initialGrowth: 0,
      ...(await dryRunMembers(db, brandId)),
    };
  });
  app.get(base + "/rules", async (req) => {
    const { brandId } = brand.parse(req.params);
    await memberAuthorize(db, await auth(req), brandId, "members.read");
    if (!(await memberSchema(db))) return { available: false, items: [] };
    return {
      available: true,
      items: (
        await db.query(
          "SELECT id,kind,platform_id,version,status,effective_from::text,effective_until::text,config,mapping_approval,published_at,published_by FROM member_rule_versions WHERE brand_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100",
          [brandId],
        )
      ).rows,
    };
  });
  app.get(base + "/rule-options", async (req) => {
    const { brandId } = brand.parse(req.params);
    await memberAuthorize(db, await auth(req), brandId, "growth.rules.manage");
    return {
      platforms: (
        await db.query(
          "SELECT id,display_name,currency,timezone FROM platforms WHERE brand_id=$1 AND status='active' ORDER BY display_name",
          [brandId],
        )
      ).rows,
      batches: (
        await db.query(
          "SELECT id,platform_id,business_date::text,status,mapping->>'adapterId' AS adapter,mapping->>'mappingVersion' AS version FROM platform_import_batches WHERE brand_id=$1 AND status IN ('active','ready') ORDER BY created_at DESC LIMIT 100",
          [brandId],
        )
      ).rows,
    };
  });
  app.post(base + "/rules/preview", async (req) => {
    const { brandId } = brand.parse(req.params),
      p = await auth(req);
    const v = versionInput.parse(req.body);
    await memberAuthorize(
      db,
      p,
      brandId,
      v.kind === "level" ? "member.levels.manage" : "growth.rules.manage",
    );
    const config = validateConfig(v.kind, v.config);
    let mappingApproval = null;
    if (v.kind === "platform") {
      const c = platformConfig.parse(config),
        platform = await one(
          db,
          "SELECT currency,timezone FROM platforms WHERE brand_id=$1 AND id=$2",
          [brandId, v.platformId],
        );
      if (platform.currency !== c.currency || platform.timezone !== c.timezone)
        throw new DomainError("growth_platform_config_mismatch", 409);
      mappingApproval = await resolveMappingSemantics(
        db,
        { brandId, botId: "" },
        v.platformId!,
        c.mappingBatchId,
        c.currency,
        c.timezone,
      );
    }

    return {
      readonly: true,
      mappingApproval,
      kind: v.kind,
      config,
      examples:
        v.kind === "platform"
          ? ["0", "19.99", "20", "50", "100", "300", "500", "1000"].map(
              (value) => ({
                value,
                growth: platformGrowth(
                  value,
                  platformConfig.parse(config).tiers,
                ),
              }),
            )
          : v.kind === "level"
            ? levelConfig.parse(config).levels
            : [],
      writes: 0,
    };
  });
  app.post(base + "/rules", async (req) =>
    createMemberRule(
      db,
      await auth(req),
      brand.parse(req.params).brandId,
      req.body,
      req.id,
    ),
  );
  app.post(base + "/rules/:id/publish", async (req) => {
    const s = brand.extend({ id: z.uuid() }).parse(req.params);
    return publishMemberRule(db, await auth(req), s.brandId, s.id, req.id);
  });
  app.get(base + "/analytics", async (req) => {
    const { brandId } = brand.parse(req.params);
    await memberAuthorize(db, await auth(req), brandId, "growth.read");
    const q = z
      .object({ from: dateInput, to: dateInput })
      .strict()
      .parse(req.query);
    if (q.to < q.from) throw new DomainError("invalid_request", 400);
    if (!(await memberSchema(db)) || !memberGrowthEnabled())
      return { available: false };
    const policy = (
      await db.query(
        `SELECT config->>'timezone' AS zone FROM member_rule_versions WHERE brand_id=$1 AND kind='growth' AND status='published' ORDER BY version DESC LIMIT 1`,
        [brandId],
      )
    ).rows[0];
    if (!policy) return { available: false };
    const totals = await one(
      db,
      `SELECT coalesce(sum(delta) FILTER(WHERE kind='grant'),0)::text AS issued,coalesce(sum(delta),0)::text AS net,count(DISTINCT member_id) FILTER(WHERE delta>0 AND kind<>'admin_adjustment')::int AS earners FROM growth_ledger WHERE brand_id=$1 AND business_date BETWEEN $2::date AND $3::date`,
      [brandId, q.from, q.to],
    );
    const end = "(($3::date+1)::timestamp AT TIME ZONE $4)";
    const distribution = (
      await db.query(
        `SELECT level,count(*)::int AS n FROM (SELECT DISTINCT ON(member_id) member_id,new_level AS level FROM member_level_history WHERE brand_id=$1 AND $2::date<=$3::date AND created_at<${end} ORDER BY member_id,created_at DESC,ordinal DESC) h GROUP BY level ORDER BY level`,
        [brandId, q.from, q.to, policy.zone],
      )
    ).rows;
    const upgrades = await one(
      db,
      `SELECT count(DISTINCT member_id)::int AS n FROM member_level_history WHERE brand_id=$1 AND previous_level IS NOT NULL AND new_level>previous_level AND created_at>=($2::date::timestamp AT TIME ZONE $4) AND created_at<${end}`,
      [brandId, q.from, q.to, policy.zone],
    );
    return {
      available: true,
      ...totals,
      members: distribution.reduce((n, r) => n + r.n, 0),
      distribution,
      upgrades: upgrades.n,
      timezone: policy.zone,
      aggregation: {
        members: "SNAPSHOT",
        distribution: "SNAPSHOT",
        issued: "SUM",
        net: "SUM",
        earners: "DISTINCT",
        upgrades: "DISTINCT",
      },
    };
  });
  app.get(base + "/:id/level-history", async (req) => {
    const s = brand.extend({ id: z.uuid() }).parse(req.params);
    await memberAuthorize(db, await auth(req), s.brandId, "growth.read");
    const q = z
      .object({
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .strict()
      .parse(req.query);
    const rows = (
      await db.query(
        "SELECT ordinal,previous_level,new_level,growth_balance::text,reason_code,created_at FROM member_level_history WHERE brand_id=$1 AND member_id=$2 AND ($3::int IS NULL OR ordinal<$3) ORDER BY ordinal DESC LIMIT $4",
        [s.brandId, s.id, q.before ?? null, q.limit + 1],
      )
    ).rows;
    return {
      items: rows.slice(0, q.limit),
      next: rows.length > q.limit ? rows[q.limit - 1]!.ordinal : null,
    };
  });
  app.get(base + "/:id", async (req) => {
    const s = brand.extend({ id: z.uuid() }).parse(req.params);
    await memberAuthorize(db, await auth(req), s.brandId, "growth.read");
    const q = page.parse(req.query);
    const m = await one(
      db,
      "SELECT m.id,m.level,a.balance::text AS growth FROM members m JOIN growth_accounts a ON a.member_id=m.id WHERE m.brand_id=$1 AND m.id=$2",
      [s.brandId, s.id],
    );
    const ledger = (
      await db.query(
        `SELECT id,delta::text,business_date::text,kind,reason_code,created_at FROM growth_ledger WHERE brand_id=$1 AND member_id=$2 AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM growth_ledger WHERE id=$3 AND member_id=$2)) ORDER BY created_at DESC,id DESC LIMIT $4`,
        [s.brandId, s.id, q.after ?? null, q.limit + 1],
      )
    ).rows;
    return {
      ...m,
      ledger: ledger.slice(0, q.limit),
      next: ledger.length > q.limit ? ledger[q.limit - 1]!.id : null,
      history: (
        await db.query(
          "SELECT ordinal,previous_level,new_level,growth_balance::text,reason_code,created_at FROM member_level_history WHERE brand_id=$1 AND member_id=$2 ORDER BY ordinal DESC LIMIT 50",
          [s.brandId, s.id],
        )
      ).rows,
      reconciliations: (
        await db.query(
          "SELECT id,business_date::text,allocation,total,created_at FROM growth_daily_reconciliations WHERE brand_id=$1 AND member_id=$2 ORDER BY created_at DESC,id DESC LIMIT 20",
          [s.brandId, s.id],
        )
      ).rows,
    };
  });
  app.post(base + "/:id/adjustment-preview", async (req) => {
    const s = brand.extend({ id: z.uuid() }).parse(req.params),
      p = await auth(req),
      b = adjustment.parse(req.body);
    await memberAuthorize(db, p, s.brandId, "growth.adjust");
    const payload = confirmationPayload(
      p.adminId,
      s.brandId,
      s.id,
      b,
      Date.now() + 300000,
    );
    return {
      requiresConfirmation: Math.abs(Number(b.delta)) >= 500,
      confirmation:
        Buffer.from(payload).toString("base64url") + "." + signature(payload),
    };
  });
  app.post(base + "/:id/adjustments", async (req) => {
    const s = brand.extend({ id: z.uuid() }).parse(req.params),
      p = await auth(req),
      b = adjustment.parse(req.body);
    if (Math.abs(Number(b.delta)) >= 500) {
      try {
        const [encoded, sig] = b.confirmation!.split("."),
          payload = Buffer.from(encoded!, "base64url").toString(),
          expires = JSON.parse(payload)[6];
        const expected = signature(payload);
        if (
          !sig ||
          sig.length !== expected.length ||
          !timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ||
          expires < Date.now() ||
          payload !==
            confirmationPayload(p.adminId, s.brandId, s.id, b, expires)
        )
          throw Error();
      } catch {
        throw new DomainError("growth_confirmation_required", 409);
      }
    }
    return adjustGrowth(
      db,
      p,
      s.brandId,
      s.id,
      b.delta,
      b.reason,
      b.key,
      req.id,
    );
  });
  // Bot-scoped readers get summary only, never other Bot economic provenance.
  app.get(
    "/v1/brands/:brandId/bots/:botId/users/:userId/member",
    async (req) => {
      const s = z
        .object({ brandId: z.uuid(), botId: z.uuid(), userId: z.uuid() })
        .parse(req.params);
      await authorize(db, await auth(req), s, "users.read");
      if (!(await memberSchema(db))) return { available: false };
      const row = (
        await db.query(
          "SELECT m.level,a.balance::text AS growth FROM member_user_links l JOIN members m ON m.id=l.member_id JOIN growth_accounts a ON a.member_id=m.id WHERE l.brand_id=$1 AND l.bot_id=$2 AND l.user_id=$3",
          [s.brandId, s.botId, s.userId],
        )
      ).rows[0];
      return row ? { available: true, ...row } : { available: false };
    },
  );
}
export function attachMiniMembers(
  app: FastifyInstance,
  db: Database,
  bindings: MiniAppBinding[],
) {
  const auth = (r: FastifyRequest) =>
    authenticateMini(db, r.headers.authorization, bindings, r.headers.origin);
  app.get("/member", async (req) => {
    z.object({}).strict().parse(req.query);
    return miniMemberSummary(db, await auth(req));
  });
  app.post("/member/checkin", async (req) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    return checkinGrowth(db, await auth(req), req.id);
  });
  app.get("/member/growth", async (req) => {
    const p = await auth(req),
      q = page.parse(req.query);
    if (!memberGrowthEnabled() || !(await memberSchema(db)))
      return { available: false, items: [] };
    const rows = (
      await db.query(
        `SELECT g.id,g.delta::text,g.kind,g.business_date::text,g.created_at FROM member_user_links l JOIN growth_ledger g ON g.member_id=l.member_id WHERE l.brand_id=$1 AND l.bot_id=$2 AND l.user_id=$3 AND ($4::uuid IS NULL OR (g.created_at,g.id)<(SELECT created_at,id FROM growth_ledger WHERE id=$4 AND member_id=l.member_id)) ORDER BY g.created_at DESC,g.id DESC LIMIT $5`,
        [p.brandId, p.botId, p.userId, q.after ?? null, q.limit + 1],
      )
    ).rows;
    return {
      available: true,
      items: rows.slice(0, q.limit),
      next: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
    };
  });
}
