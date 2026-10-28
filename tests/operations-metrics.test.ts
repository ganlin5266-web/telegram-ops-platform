import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import Fastify from "fastify";
import { z } from "zod";
import {
  DomainError,
  one,
  postgres,
  type Database,
  type Queryable,
} from "../src/db.js";
import { migrate } from "../src/migrations.js";
import {
  attachOperationsMetrics,
  operationsMetrics,
} from "../src/operations-metrics.js";
import { createPlatform, submitIdentity } from "../src/platform-identities.js";

let db: Database, close: () => Promise<void>;
const adapt = (p: any): Queryable => ({
  query: async (sql, params) =>
    params === undefined
      ? ((await p.exec(sql)).at(-1) ?? { rows: [] })
      : p.query(sql, params),
});
before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    const p = postgres(process.env.TEST_DATABASE_URL);
    db = p;
    close = p.close;
  } else {
    const p = new PGlite();
    db = {
      ...adapt(p),
      transaction: (fn) => p.transaction((tx) => fn(adapt(tx))),
    };
    close = () => p.close();
  }
  await migrate(db);
});
after(async () => close());
const digest = () => createHash("sha256").update(randomUUID()).digest("hex");
async function fixture(permissions?: string[], brandId?: string) {
  const brand = brandId
    ? { id: brandId }
    : await one(
        db,
        "INSERT INTO brands(name,slug,default_language) VALUES('Metrics synthetic',$1,'en') RETURNING id",
        [randomUUID()],
      );
  const bot = await one(
    db,
    "INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages) VALUES($1,'Metrics synthetic',$2,$3,$4,'en',ARRAY['en']) RETURNING id",
    [brand.id, randomUUID(), randomUUID(), randomUUID()],
  );
  const admin = await one(
    db,
    "INSERT INTO admins(auth_subject,display_name) VALUES($1,'Metrics synthetic') RETURNING id",
    [randomUUID()],
  );
  if (permissions) {
    const role = await one(
      db,
      "INSERT INTO roles(name) VALUES($1) RETURNING id",
      [randomUUID()],
    );
    await db.query(
      "INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE name=ANY($2::text[])",
      [role.id, permissions],
    );
    await db.query(
      "INSERT INTO admin_roles(admin_id,role_id,brand_id,bot_id) VALUES($1,$2,$3,$4)",
      [admin.id, role.id, brand.id, bot.id],
    );
  } else
    await db.query(
      "INSERT INTO admin_roles(admin_id,role_id) SELECT $1,id FROM roles WHERE name='Super Admin'",
      [admin.id],
    );
  const s = { brandId: brand.id, botId: bot.id },
    p = { adminId: admin.id };
  const user = await one(
    db,
    "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,1) RETURNING id",
    [brand.id, bot.id],
  );
  return { s, p, user };
}
async function metrics(f: Awaited<ReturnType<typeof fixture>>) {
  return db.transaction((tx) => operationsMetrics(tx, f.p, f.s));
}
const get = (r: Awaited<ReturnType<typeof operationsMetrics>>, key: string) =>
  r.metrics.find((m) => m.key === key)!;
async function authEvent(
  f: Awaited<ReturnType<typeof fixture>>,
  age = "0 days",
) {
  const exchange = await one(
    db,
    `INSERT INTO mini_auth_exchanges(brand_id,bot_id,payload_digest,auth_date,accepted_at,valid_until)
    VALUES($1,$2,$3,now()-$4::interval,now()-$4::interval,now()+interval '1 day') RETURNING id`,
    [f.s.brandId, f.s.botId, digest(), age],
  );
  await db.query(
    `INSERT INTO mini_sessions(brand_id,bot_id,user_id,app_key,exchange_id,token_hash,expires_at)
    VALUES($1,$2,$3,'synthetic',$4,$5,now()+interval '1 day')`,
    [f.s.brandId, f.s.botId, f.user.id, exchange.id, digest()],
  );
}
async function identityEvent(
  f: Awaited<ReturnType<typeof fixture>>,
  action = "identity.verify",
  age = "0 days",
) {
  await db.query(
    "INSERT INTO audit_logs(brand_id,bot_id,action,object_type,object_id,created_at) VALUES($1,$2,$3,'platform_identity',$4,now()-$5::interval)",
    [f.s.brandId, f.s.botId, action, randomUUID(), age],
  );
}

test("seven-day metrics: real empty data is zero; unattributable Bot check-ins remain pending", async () => {
  const r = await metrics(await fixture());
  assert.equal(r.window.days, 7);
  assert.equal(r.window.timezone, "UTC");
  assert.equal(
    Date.parse(r.window.end) - Date.parse(r.window.start),
    7 * 86400000,
  );
  assert.equal(r.notAFunnel, true);
  assert.equal(r.metrics.length, 7);
  for (const m of r.metrics)
    assert.deepEqual(
      [m.status, m.value],
      m.key === "checkins" ? ["pending_collection", null] : ["ok", "0"],
    );
});
test("Mini metric deduplicates successful exchanges; expired sessions still count; old exchanges and foreign scope do not", async () => {
  const f = await fixture(),
    sibling = await fixture(undefined, f.s.brandId),
    foreign = await fixture();
  await authEvent(f);
  await authEvent(f);
  await authEvent(f, "8 days");
  await authEvent(sibling);
  await authEvent(foreign);
  await db.query(
    "UPDATE mini_sessions SET revoked_at=now(),revoke_reason='logout' WHERE brand_id=$1 AND bot_id=$2",
    [f.s.brandId, f.s.botId],
  );
  const r = await metrics(f);
  assert.equal(get(r, "mini_participants").value, "1");
  assert.match(get(r, "mini_participants").definition, /Not page views/);
});
test("historical UID verification counts immutable audit events and survives later revocation", async () => {
  const f = await fixture(),
    other = await fixture(undefined, f.s.brandId);
  await identityEvent(f);
  await identityEvent(f, "identity.revoke");
  await identityEvent(f, "identity.verify", "8 days");
  await identityEvent(other);
  assert.equal(get(await metrics(f), "uid_verified").value, "1");
});
test("per-metric permissions never turn forbidden into zero or expose invitation/redemption amounts to users.read", async () => {
  const f = await fixture(["dashboard.read", "users.read"]);
  await authEvent(f);
  await identityEvent(f);
  const r = await metrics(f);
  assert.equal(get(r, "mini_participants").value, "1");
  for (const key of [
    "uid_verified",
    "checkins",
    "qualified_invites",
    "reward_points",
    "redemptions_created",
    "codes_claimed",
  ])
    assert.deepEqual(
      [get(r, key).status, get(r, key).value],
      ["forbidden", null],
    );
});
test("Bot-scoped permission cannot inspect sibling Bot or other Brand; dashboard permission is required", async () => {
  const f = await fixture(["dashboard.read", "users.read"]),
    sibling = await fixture(undefined, f.s.brandId),
    other = await fixture();
  for (const s of [sibling.s, other.s])
    await assert.rejects(
      db.transaction((tx) => operationsMetrics(tx, f.p, s)),
      (e: any) => e.code === "forbidden",
    );
  const noDashboard = await fixture(["users.read"]);
  await assert.rejects(
    metrics(noDashboard),
    (e: any) => e.code === "forbidden",
  );
});
test("qualified invitations use platform/referral pairs, include cap-exceeded, and never count both reward recipients as two invitations", async () => {
  const f = await fixture();
  const platform = await createPlatform(
    db,
    f.p,
    f.s,
    {
      code: "MET" + randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase(),
      displayName: "Metrics synthetic",
      market: "BR",
      timezone: "America/Sao_Paulo",
      currency: "BRL",
      verificationMethod: "manual_admin",
      uidFormat: "alphanumeric",
      uidCase: "upper",
      uidMinLength: 1,
      uidMaxLength: 64,
    },
    "metrics",
  );
  const rule = await one(
    db,
    "INSERT INTO referral_reward_rule_versions(brand_id,platform_id,campaign_key,version,effective_from,created_by) VALUES($1,$2,'synthetic',1,current_date,$3) RETURNING id",
    [f.s.brandId, platform.id, f.p.adminId],
  );
  for (let i = 2; i <= 3; i++) {
    const u = await one(
      db,
      "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,$3) RETURNING id",
      [f.s.brandId, f.s.botId, i],
    );
    const referral = await one(
      db,
      "INSERT INTO referrals(brand_id,bot_id,inviter_id,invitee_id,start_parameter) VALUES($1,$2,$3,$4,'synthetic') RETURNING id",
      [f.s.brandId, f.s.botId, f.user.id, u.id],
    );
    const identity = await submitIdentity(
      db,
      {
        ...f.s,
        userId: u.id,
        sessionId: randomUUID(),
        appKey: "synthetic",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
      platform.id,
      "SYNTH" + i,
      randomUUID(),
      "metrics",
    );
    const uid = digest();
    const evidence = await one(
      db,
      `INSERT INTO referral_qualification_evidence(brand_id,platform_id,bot_id,referral_id,invitee_user_id,platform_identity_id,verified_uid_fingerprint,rule_version_id,campaign_version,business_date,status,evidence_fingerprint,request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'synthetic',current_date,$9,$10,'metrics') RETURNING id`,
      [
        f.s.brandId,
        platform.id,
        f.s.botId,
        referral.id,
        u.id,
        identity.id,
        uid,
        rule.id,
        i === 2 ? "verified" : "cap_exceeded",
        digest(),
      ],
    );
    if (i === 2)
      for (const [role, recipient, points] of [
        ["inviter", f.user.id, 50],
        ["invitee", u.id, 20],
      ])
        await db.query(
          `INSERT INTO referral_reward_events(brand_id,platform_id,bot_id,referral_id,evidence_id,rule_version_id,verified_uid_fingerprint,reward_role,recipient_user_id,points,status,idempotency_key,request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'granted',$11,'metrics')`,
          [
            f.s.brandId,
            platform.id,
            f.s.botId,
            referral.id,
            evidence.id,
            rule.id,
            uid,
            role,
            recipient,
            points,
            randomUUID(),
          ],
        );
  }
  const r = await metrics(f);
  assert.equal(get(r, "qualified_invites").value, "2");
  assert.equal(get(r, "reward_points").value, "70");
  const rewardsOnly = await fixture(["dashboard.read", "referrals.read"]);
  assert.equal(
    get(await metrics(rewardsOnly), "reward_points").status,
    "forbidden",
  );
});
test("creation and first claim are separate event windows, with no code or personal data in output", async () => {
  const f = await fixture();
  const rule = await one(
    db,
    "INSERT INTO redemption_rules(brand_id,bot_id,name,mode,points_cost,exchange_rate) VALUES($1,$2,'Synthetic','fixed',100,1) RETURNING id",
    [f.s.brandId, f.s.botId],
  );
  for (const age of ["0 days", "8 days"])
    await db.query(
      `INSERT INTO redemptions(brand_id,bot_id,user_id,rule_id,points_cost,idempotency_key,rule_snapshot,created_at,code_claimed_at,status)
    VALUES($1,$2,$3,$4,100,$5,'{}',now()-$6::interval,now(),'code_claimed')`,
      [f.s.brandId, f.s.botId, f.user.id, rule.id, randomUUID(), age],
    );
  const r = await metrics(f);
  assert.equal(get(r, "redemptions_created").value, "1");
  assert.equal(get(r, "codes_claimed").value, "2");
  assert.ok(!JSON.stringify(r).includes(f.user.id));
  assert.ok(!JSON.stringify(r).includes("code_ciphertext"));
});
test("aggregate strings retain exact integers beyond JavaScript safe range; database failure propagates", async () => {
  const f = await fixture();
  const large: Queryable = {
    query: async (sql, params) =>
      sql.includes("sum(points)")
        ? { rows: [{ value: "900719925474099300" }] as any }
        : db.query(sql, params),
  };
  assert.equal(
    get(await operationsMetrics(large, f.p, f.s), "reward_points").value,
    "900719925474099300",
  );
  const failing: Queryable = {
    query: async (sql, params) => {
      if (sql.includes("mini_sessions"))
        throw new Error("database unavailable");
      return db.query(sql, params);
    },
  };
  await assert.rejects(
    operationsMetrics(failing, f.p, f.s),
    /database unavailable/,
  );
});
test("route rejects unsupported query and uses read-only transaction, no-store and standard errors", async () => {
  const f = await fixture();
  const statements: string[] = [];
  const tracked: Database = {
    ...db,
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          query: async (sql, p) => {
            statements.push(sql);
            return tx.query(sql, p);
          },
        }),
      ),
  };
  const app = Fastify();
  app.setErrorHandler((e, req, reply) =>
    reply
      .code(
        e instanceof z.ZodError
          ? 400
          : e instanceof DomainError
            ? e.status
            : 500,
      )
      .send({
        error:
          e instanceof z.ZodError
            ? "invalid_request"
            : e instanceof DomainError
              ? e.code
              : "internal_error",
        requestId: req.id,
      }),
  );
  attachOperationsMetrics(app, tracked, async () => f.p);
  const url = `/v1/brands/${f.s.brandId}/bots/${f.s.botId}/operations/metrics`;
  const r = await app.inject({ url: url + "?days=7" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.ok(
    statements.includes(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    ),
  );
  assert.equal((await app.inject({ url: url + "?days=8" })).statusCode, 400);
  assert.equal(
    (await app.inject({ url: url + "?platformId=" + randomUUID() })).statusCode,
    400,
  );
  await app.close();
  const failing = Fastify();
  failing.setErrorHandler((_e, req, reply) =>
    reply.code(500).send({ error: "internal_error", requestId: req.id }),
  );
  attachOperationsMetrics(
    failing,
    {
      ...db,
      transaction: () => Promise.reject(new Error("SECRET_DATABASE_DETAIL")),
    },
    async () => f.p,
  );
  const failed = await failing.inject({ url });
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.json().error, "internal_error");
  assert.ok(!failed.body.includes("SECRET_DATABASE_DETAIL"));
  assert.ok(!failed.body.includes("metrics"));
  await failing.close();
});

test("UTC range preserves microseconds and includes start while excluding end", async () => {
  const f = await fixture();
  const end = "2026-11-02T12:00:00.123456Z";
  const instants = [
    "2026-10-26T12:00:00.123455Z", // before start: excluded
    "2026-10-26T12:00:00.123456Z", // exact start: included
    "2026-11-02T12:00:00.123455Z", // one microsecond before end: included
    end, // exact end: excluded
  ];
  for (const instant of instants)
    await db.query(
      "INSERT INTO audit_logs(brand_id,bot_id,action,object_type,object_id,created_at) VALUES($1,$2,'identity.verify','platform_identity',$3,$4::timestamptz)",
      [f.s.brandId, f.s.botId, randomUUID(), instant],
    );
  await db.transaction(async (tx) => {
    await tx.query("SET LOCAL TIME ZONE 'America/New_York'");
    // Freeze only the DB clock expression; execute the real PostgreSQL formatting,
    // interval arithmetic, predicates and aggregates (including a DST transition).
    const fixedClock: Queryable = {
      query: (sql, params) =>
        tx.query(
          sql.includes("AS window_end")
            ? sql.replaceAll(
                "transaction_timestamp()",
                "'2026-11-02T12:00:00.123456Z'::timestamptz",
              )
            : sql,
          params,
        ),
    };
    const r = await operationsMetrics(fixedClock, f.p, f.s);
    assert.equal(r.window.start, "2026-10-26T12:00:00.123456Z");
    assert.equal(r.window.end, end);
    assert.equal(get(r, "uid_verified").value, "2");
  });
});
