import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database } from "./db.js";
import { authenticateMini, type MiniAppBinding } from "./mini-sessions.js";
import { requireRecoveryProtection } from "./mini-recovery.js";
import type { RedemptionCodeVault } from "./redemption-vault.js";
import {
  claimRedemptionCode,
  createFixedRedemption,
  recoverRedemptionCode,
  redemptionCatalogue,
} from "./redemption-flow.js";

const none = z.object({}).strict();
const id = z.object({ id: z.uuid() });
const createBody = z.object({ ruleId: z.uuid() }).strict();

export function attachMiniRedemptions(
  app: FastifyInstance,
  db: Database,
  bindings: MiniAppBinding[],
  vault?: RedemptionCodeVault,
) {
  const auth = (req: FastifyRequest) =>
    authenticateMini(
      db,
      req.headers.authorization,
      bindings,
      req.headers.origin,
    );
  app.get("/redemption-tiers", async (req) => {
    const q = z
      .object({ platformId: z.uuid().optional() })
      .strict()
      .parse(req.query);
    return redemptionCatalogue(db, await auth(req), q.platformId);
  });
  app.post("/redemption-orders", async (req) => {
    none.parse(req.query);
    requireRecoveryProtection(req.headers);
    const p = await auth(req),
      body = createBody.parse(req.body);
    const key = z.uuid().parse(req.headers["idempotency-key"]);
    return createFixedRedemption(db, p, body.ruleId, key, req.id);
  });
  app.post("/redemption-orders/:id/claim", async (req) => {
    none.parse(req.query);
    none.parse(req.body);
    requireRecoveryProtection(req.headers);
    const p = await auth(req);
    return claimRedemptionCode(db, vault, p, id.parse(req.params).id);
  });
  app.get("/redemption-orders/:id/code", async (req) => {
    none.parse(req.query);
    return recoverRedemptionCode(
      db,
      vault,
      await auth(req),
      id.parse(req.params).id,
    );
  });
}
