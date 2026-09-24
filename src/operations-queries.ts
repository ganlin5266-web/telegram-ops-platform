import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authorize, type Principal } from "./auth.js";
import {
  DomainError,
  one,
  scopeParams,
  type Database,
  type Queryable,
  type Scope,
} from "./db.js";
import { resolveLanguage } from "./language.js";
import { binding, decodeCursor, encodeCursor } from "./query-cursor.js";
const scopeSchema = z.object({
  brandId: z.uuid(),
  botId: z.uuid(),
  userId: z.uuid().optional(),
});
const text = z.string().trim().min(1).max(100);
const timestamp = z.iso.datetime({ offset: true });
const paging = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: z.string().min(1).max(2048).optional(),
};
const userFilters = z
  .object({
    q: text.optional(),
    status: z.enum(["active", "blocked", "disabled"]).optional(),
    language: text.optional(),
    languageField: z.enum(["telegram", "preferred"]).default("telegram"),
    startedFrom: timestamp.optional(),
    startedTo: timestamp.optional(),
    interactionFrom: timestamp.optional(),
    interactionTo: timestamp.optional(),
  })
  .strict();
const userQuery = userFilters.extend({
  ...paging,
  sort: z.enum(["id", "first_started_at", "last_interaction_at"]).default("id"),
  order: z.enum(["asc", "desc"]).default("asc"),
});
const ledgerQuery = z
  .object({
    ...paging,
    direction: z.enum(["credit", "debit"]).optional(),
    source: text.optional(),
    businessType: text.optional(),
    from: timestamp.optional(),
    to: timestamp.optional(),
  })
  .strict();
const referralQuery = z
  .object({
    ...paging,
    status: z.enum(["bound", "qualified", "invalid"]).optional(),
    rewardStatus: z.enum(["pending", "rewarded", "ineligible"]).optional(),
    inviter: text.optional(),
    invitee: text.optional(),
    from: timestamp.optional(),
    to: timestamp.optional(),
  })
  .strict();
const auditQuery = z
  .object({
    ...paging,
    adminId: z.uuid().optional(),
    action: text.optional(),
    objectType: text.optional(),
    objectId: text.optional(),
    from: timestamp.optional(),
    to: timestamp.optional(),
  })
  .strict();
type UserFilters = z.infer<typeof userFilters>;
class Conditions {
  values: unknown[];
  parts: string[];
  constructor(s: Scope, alias: string) {
    this.values = scopeParams(s);
    this.parts = [`${alias}.brand_id=$1`, `${alias}.bot_id=$2`];
  }
  parameter(value: unknown) {
    this.values.push(value);
    return `$${this.values.length}`;
  }
  add(sql: string) {
    this.parts.push(sql);
  }
  get sql() {
    return this.parts.join(" AND ");
  }
}
function dates(c: Conditions, column: string, from?: string, to?: string) {
  if (from && to && Date.parse(from) >= Date.parse(to))
    throw new DomainError("invalid_date_range", 400);
  if (from) c.add(`${column}>=${c.parameter(from)}::timestamptz`);
  if (to) c.add(`${column}<${c.parameter(to)}::timestamptz`);
}
function search(c: Conditions, alias: string, value?: string) {
  if (!value) return;
  const normalized = value.replace(/^@/, "").toLowerCase();
  if (!normalized) throw new DomainError("invalid_request", 400);
  const pattern = c.parameter(normalized.replace(/[\\%_]/g, "\\$&") + "%");
  const parts = ["username", "first_name", "last_name"].map(
    (field) => `lower(${alias}.${field}) LIKE ${pattern}`,
  );
  if (
    /^[1-9]\d{0,18}$/.test(normalized) &&
    BigInt(normalized) <= 9223372036854775807n
  )
    parts.push(`${alias}.telegram_user_id=${c.parameter(normalized)}::bigint`);
  c.add(`(${parts.join(" OR ")})`);
}
function usersWhere(s: Scope, q: UserFilters) {
  const c = new Conditions(s, "u");
  search(c, "u", q.q);
  if (q.status) c.add(`u.status=${c.parameter(q.status)}`);
  if (q.language)
    c.add(
      `lower(u.${q.languageField === "preferred" ? "preferred_language" : "telegram_language_code"})=${c.parameter(q.language.toLowerCase())}`,
    );
  dates(c, "u.first_started_at", q.startedFrom, q.startedTo);
  dates(c, "u.last_interaction_at", q.interactionFrom, q.interactionTo);
  return c;
}
const userFields =
  "u.id,u.telegram_user_id::text,u.username,u.first_name,u.last_name,u.telegram_language_code,u.preferred_language,u.first_started_at,u.last_interaction_at,u.status";
function context(
  kind: string,
  s: Scope,
  q: Record<string, unknown>,
  userId?: string,
) {
  const { after, limit, ...filters } = q;
  return binding({ kind, ...s, userId, filters });
}
async function page(
  tx: Queryable,
  c: Conditions,
  config: {
    select: string;
    from: string;
    column: string;
    id: string;
    order: "asc" | "desc";
    limit: number;
    after?: string;
    context: string;
  },
) {
  const { column, id, order, limit, after } = config;
  const compare = order === "asc" ? ">" : "<";
  if (after) {
    const cursor = decodeCursor(after, config.context);
    const key = c.parameter(cursor.id);
    if (column === id) {
      c.add(`${id}${compare}${key}::uuid`);
    } else if (cursor.value === null) {
      c.add(`(${column} IS NULL AND ${id}${compare}${key}::uuid)`);
    } else {
      const value = c.parameter(cursor.value);
      c.add(
        `(${column}${compare}${value}::timestamptz OR (${column}=${value}::timestamptz AND ${id}${compare}${key}::uuid) OR ${column} IS NULL)`,
      );
    }
  }
  const rows = (
    await tx.query(
      `SELECT ${config.select},${column}::text AS _cursor_value FROM ${config.from} WHERE ${c.sql} ORDER BY ${column} ${order} NULLS LAST${column === id ? "" : `,${id} ${order}`} LIMIT ${c.parameter(limit + 1)}`,
      c.values,
    )
  ).rows;
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeCursor(config.context, last.id, last._cursor_value)
      : null;
  return { items: items.map(({ _cursor_value, ...row }) => row), nextCursor };
}
async function summary(tx: Queryable, s: Scope, userId: string) {
  return one(
    tx,
    `SELECT COALESCE((SELECT balance::text FROM point_accounts WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3),'0') AS balance,COALESCE(SUM(delta) FILTER(WHERE delta>0),0)::text AS "totalEarned",COALESCE(-SUM(delta) FILTER(WHERE delta<0),0)::text AS "totalSpent" FROM point_ledger WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3`,
    [...scopeParams(s), userId],
  );
}
function publicUser(row: Record<string, any>, prefix: string) {
  return {
    id: row[`${prefix}_id`],
    telegramUserId: row[`${prefix}_telegram_id`],
    username: row[`${prefix}_username`],
    firstName: row[`${prefix}_first_name`],
    lastName: row[`${prefix}_last_name`],
  };
}
async function referrals(
  tx: Queryable,
  s: Scope,
  q: z.infer<typeof referralQuery>,
  userId?: string,
) {
  const c = new Conditions(s, "r");
  if (userId) c.add(`r.inviter_id=${c.parameter(userId)}::uuid`);
  if (q.status) c.add(`r.status=${c.parameter(q.status)}`);
  if (q.rewardStatus) c.add(`r.reward_status=${c.parameter(q.rewardStatus)}`);
  dates(c, "r.bound_at", q.from, q.to);
  for (const role of ["inviter", "invitee"] as const)
    if (q[role]) {
      search(c, role, q[role]);
      const condition = c.parts.pop();
      c.add(
        `EXISTS(SELECT 1 FROM telegram_users ${role} WHERE (${role}.brand_id,${role}.bot_id,${role}.id)=(r.brand_id,r.bot_id,r.${role}_id) AND ${condition})`,
      );
    }
  // Fetch participant projections only for the bounded page, not via a large joined sort.
  const participant = (role: string) =>
    `(SELECT json_build_object('id',u.id,'telegramUserId',u.telegram_user_id::text,'username',u.username,'firstName',u.first_name,'lastName',u.last_name) FROM telegram_users u WHERE (u.brand_id,u.bot_id,u.id)=(r.brand_id,r.bot_id,r.${role}_id)) AS ${role}`;
  return page(tx, c, {
    select: `r.id,r.bound_at AS "boundAt",r.status,r.reward_status AS "rewardStatus",${participant("inviter")},${participant("invitee")}`,
    from: "referrals r",
    column: "r.bound_at",
    id: "r.id",
    order: "desc",
    limit: q.limit,
    after: q.after,
    context: context("referrals", s, q, userId),
  });
}
export function attachOperationsQueries(
  app: FastifyInstance,
  db: Database,
  authenticate: (r: FastifyRequest) => Promise<Principal>,
) {
  const base = "/v1/brands/:brandId/bots/:botId";
  const register = (
    path: string,
    permission: string,
    handler: (
      tx: Queryable,
      s: Scope & { userId?: string },
      request: FastifyRequest,
    ) => Promise<unknown>,
  ) =>
    app.get(base + path, async (request) => {
      const s = scopeSchema.parse(request.params),
        principal = await authenticate(request);
      return db.transaction(async (tx) => {
        await tx.query("SET LOCAL statement_timeout='5s'");
        await authorize(tx, principal, s, permission);
        if (s.userId)
          await one(
            tx,
            "SELECT id FROM telegram_users WHERE brand_id=$1 AND bot_id=$2 AND id=$3",
            [...scopeParams(s), s.userId],
          );
        return handler(tx, s, request);
      });
    });
  register("/users", "users.read", async (tx, s, r) => {
    const q = userQuery.parse(r.query);
    return page(tx, usersWhere(s, q), {
      select: userFields,
      from: "telegram_users u",
      column: `u.${q.sort}`,
      id: "u.id",
      order: q.order,
      limit: q.limit,
      ...(q.after ? { after: q.after } : {}),
      context: context("users", s, q),
    });
  });
  register("/users/count", "users.read", async (tx, s, r) => {
    const q = userFilters.parse(r.query),
      c = usersWhere(s, q);
    return one(
      tx,
      `SELECT COUNT(*)::text AS total FROM telegram_users u WHERE ${c.sql}`,
      c.values,
    );
  });
  register("/users/:userId", "users.read", async (tx, s) => {
    const u = await one(
      tx,
      `SELECT ${userFields},u.created_at,u.updated_at FROM telegram_users u WHERE u.brand_id=$1 AND u.bot_id=$2 AND u.id=$3`,
      [...scopeParams(s), s.userId],
    );
    const bot = await one(
      tx,
      "SELECT default_language,supported_languages FROM telegram_bots WHERE brand_id=$1 AND id=$2",
      scopeParams(s),
    );
    const brand = await one(
      tx,
      "SELECT default_language FROM brands WHERE id=$1",
      [s.brandId],
    );
    return {
      ...u,
      resolved_language: resolveLanguage(u, bot as any, brand as any),
      language_note:
        "Resolved preference; individual templates may use their documented fallback.",
    };
  });
  register("/users/:userId/points/summary", "users.read", async (tx, s) =>
    summary(tx, s, s.userId!),
  );
  register("/users/:userId/point-ledger", "users.read", async (tx, s, r) => {
    const q = ledgerQuery.parse(r.query),
      c = new Conditions(s, "l");
    c.add(`l.user_id=${c.parameter(s.userId)}::uuid`);
    for (const [param, column] of [
      ["direction", "direction"],
      ["source", "source"],
      ["businessType", "business_type"],
    ] as const)
      if (q[param]) c.add(`l.${column}=${c.parameter(q[param])}`);
    dates(c, "l.created_at", q.from, q.to);
    return page(tx, c, {
      select:
        "l.id,l.delta::text,l.balance_before::text,l.balance_after::text,l.direction,l.source,l.business_type,l.business_id,l.note,l.created_at",
      from: "point_ledger l",
      column: "l.created_at",
      id: "l.id",
      order: "desc",
      limit: q.limit,
      after: q.after,
      context: context("ledger", s, q, s.userId),
    });
  });
  register("/referrals", "users.read", async (tx, s, r) =>
    referrals(tx, s, referralQuery.parse(r.query)),
  );
  register("/users/:userId/referrals", "users.read", async (tx, s, r) => {
    const q = referralQuery.parse(r.query);
    const incoming = (
      await tx.query(
        `SELECT r.id,r.bound_at,r.status,r.reward_status,u.id AS inviter_id,u.telegram_user_id::text AS inviter_telegram_id,u.username AS inviter_username,u.first_name AS inviter_first_name,u.last_name AS inviter_last_name FROM referrals r JOIN telegram_users u ON (u.brand_id,u.bot_id,u.id)=(r.brand_id,r.bot_id,r.inviter_id) WHERE r.brand_id=$1 AND r.bot_id=$2 AND r.invitee_id=$3`,
        [...scopeParams(s), s.userId],
      )
    ).rows[0];
    const count = await one(
      tx,
      'SELECT COUNT(*)::text AS "invitedCount" FROM referrals WHERE brand_id=$1 AND bot_id=$2 AND inviter_id=$3',
      [...scopeParams(s), s.userId],
    );
    return {
      invitedBy: incoming
        ? {
            id: incoming.id,
            boundAt: incoming.bound_at,
            status: incoming.status,
            rewardStatus: incoming.reward_status,
            inviter: publicUser(incoming, "inviter"),
          }
        : null,
      ...count,
      ...(await referrals(tx, s, q, s.userId)),
    };
  });
  register("/audit-logs", "audit.read", async (tx, s, r) => {
    const q = auditQuery.parse(r.query),
      c = new Conditions(s, "a");
    for (const [param, column] of [
      ["adminId", "admin_id"],
      ["action", "action"],
      ["objectType", "object_type"],
      ["objectId", "object_id"],
    ] as const)
      if (q[param]) c.add(`a.${column}=${c.parameter(q[param])}`);
    dates(c, "a.created_at", q.from, q.to);
    // Allowlist projection: never read raw before/after, note, IP, request_id or auth object identifiers.
    const result = await page(tx, c, {
      select:
        "a.id,a.created_at,a.admin_id,ad.display_name AS admin_name,CASE WHEN a.action='points.adjust' THEN a.action ELSE 'other' END AS action,CASE WHEN a.object_type='point_ledger' THEN a.object_type ELSE 'other' END AS object_type,CASE WHEN a.object_type='point_ledger' AND a.object_id ~ '^[0-9a-fA-F-]{36}$' THEN a.object_id ELSE NULL END AS object_id,CASE WHEN a.action='points.adjust' THEN 'committed' ELSE 'recorded' END AS result",
      from: "audit_logs a LEFT JOIN admins ad ON ad.id=a.admin_id",
      column: "a.created_at",
      id: "a.id",
      order: "desc",
      limit: q.limit,
      after: q.after,
      context: context("audit", s, q),
    });
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        summary:
          item.action === "points.adjust"
            ? "积分调整事务已提交"
            : "操作已记录；详情未公开",
      })),
    };
  });
}
