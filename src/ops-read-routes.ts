import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authorize, type Principal } from "./auth.js";
import { type Database } from "./db.js";
import { dataAuthorize } from "./platform-data.js";
import { businessDate } from "./platform-data-input.js";
import {
  pendingSummary,
  platformDataStatus,
  privatePerformance,
} from "./ops-read.js";

const scope = z.object({ brandId: z.uuid(), botId: z.uuid() });
const none = z.object({}).strict();
const performanceQuery = z
  .object({
    period: z.enum(["day", "week", "month"]),
    date: z.string().refine(businessDate),
    platformId: z.uuid().optional(),
  })
  .strict();

export function attachOpsRead(
  app: FastifyInstance,
  db: Database,
  auth: (request: FastifyRequest) => Promise<Principal>,
) {
  const base = "/v1/brands/:brandId/bots/:botId/ops";
  app.get(base + "/platform-data-status", async (request, reply) => {
    none.parse(request.query);
    reply.header("Cache-Control", "no-store");
    const s = scope.parse(request.params),
      p = await auth(request);
    return db.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await tx.query("SET LOCAL statement_timeout='5s'");
      await dataAuthorize(tx, p, s, "platform_data.read");
      return platformDataStatus(tx, s);
    });
  });
  app.get(base + "/private-performance", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const s = scope.parse(request.params),
      query = performanceQuery.parse(request.query),
      p = await auth(request);
    return db.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await tx.query("SET LOCAL statement_timeout='5s'");
      await dataAuthorize(tx, p, s, "platform_data.read");
      return privatePerformance(tx, s, query);
    });
  });
  app.get(base + "/pending", async (request, reply) => {
    none.parse(request.query);
    reply.header("Cache-Control", "no-store");
    const s = scope.parse(request.params),
      p = await auth(request);
    return db.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await tx.query("SET LOCAL statement_timeout='5s'");
      await authorize(tx, p, s, "dashboard.read");
      return pendingSummary(tx, p, s);
    });
  });
}
