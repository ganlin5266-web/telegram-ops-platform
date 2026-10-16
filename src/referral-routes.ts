import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authorize, type Principal } from "./auth.js";
import { one, type Database } from "./db.js";
import { authorizeBrand, changeReferralRule, createReferralRule, evaluateReferralReward, reviewReferralReward } from "./referral-rewards.js";

const scope = z.object({ brandId: z.uuid(), botId: z.uuid() });
const brand = z.object({ brandId: z.uuid() });

export function attachReferralRewards(
  app: FastifyInstance,
  db: Database,
  auth: (r: FastifyRequest) => Promise<Principal>,
) {
  app.get("/v1/brands/:brandId/referral-rules", async req => {
    const { brandId } = brand.parse(req.params), p = await auth(req);
    await authorizeBrand(db, p, brandId, "referrals.read");
    const rows = (await db.query(
      `SELECT id,platform_id,campaign_key,version,status,effective_from::text,effective_until::text,
              inviter_points,invitee_points,invitee_enabled,created_at,published_at,disabled_at
         FROM referral_reward_rule_versions WHERE brand_id=$1 ORDER BY platform_id,version DESC`, [brandId])).rows;
    return { items: rows };
  });
  app.post("/v1/brands/:brandId/referral-rules", async req => {
    const { brandId } = brand.parse(req.params);
    return createReferralRule(db, await auth(req), brandId, req.body, req.id);
  });
  app.post("/v1/brands/:brandId/referral-rules/:id/publish", async req => {
    const s = brand.extend({ id: z.uuid() }).parse(req.params);
    return changeReferralRule(db, await auth(req), s.brandId, s.id, "publish", req.id);
  });
  app.post("/v1/brands/:brandId/referral-rules/:id/disable", async req => {
    const s = brand.extend({ id: z.uuid() }).parse(req.params);
    return changeReferralRule(db, await auth(req), s.brandId, s.id, "disable", req.id);
  });
  app.post("/v1/brands/:brandId/bots/:botId/referrals/:referralId/evaluate", async req => {
    const s = scope.extend({ referralId: z.uuid() }).parse(req.params);
    return evaluateReferralReward(db, await auth(req), s, s.referralId, req.id);
  });
  app.get("/v1/brands/:brandId/bots/:botId/referrals/rewards", async req => {
    const s = scope.parse(req.params), p = await auth(req);
    await authorize(db, p, s, "referrals.read");
    const rows = (await db.query(
      `SELECT e.id,e.referral_id,e.reward_role,e.points,e.status,e.created_at,
              q.status AS evidence_status,q.business_date::text
         FROM referral_reward_events e JOIN referral_qualification_evidence q ON q.id=e.evidence_id
        WHERE e.brand_id=$1 AND e.bot_id=$2 ORDER BY e.created_at DESC,e.id DESC LIMIT 100`, [s.brandId,s.botId])).rows;
    return { items: rows };
  });
  app.get("/v1/brands/:brandId/bots/:botId/referrals/:referralId/reward", async req => {
    const s = scope.extend({ referralId: z.uuid() }).parse(req.params), p = await auth(req);
    await authorize(db, p, s, "referrals.read");
    const referral = await one(db, "SELECT id,status,reward_status FROM referrals WHERE brand_id=$1 AND bot_id=$2 AND id=$3", [s.brandId,s.botId,s.referralId]);
    const evidence = (await db.query("SELECT id,status,business_date::text,created_at FROM referral_qualification_evidence WHERE brand_id=$1 AND bot_id=$2 AND referral_id=$3 ORDER BY created_at DESC", [s.brandId,s.botId,s.referralId])).rows;
    const events = (await db.query("SELECT id,reward_role,points,status,created_at FROM referral_reward_events WHERE brand_id=$1 AND bot_id=$2 AND referral_id=$3 ORDER BY created_at", [s.brandId,s.botId,s.referralId])).rows;
    return { referral, evidence, events };
  });
  app.post("/v1/brands/:brandId/bots/:botId/referrals/:referralId/review", async req => {
    const s = scope.extend({ referralId: z.uuid() }).parse(req.params);
    return reviewReferralReward(db, await auth(req), s, s.referralId, req.body, req.id);
  });
}
