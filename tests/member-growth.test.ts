import { DomainError } from "../src/db.js";
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { postgres, one, type Database } from "../src/db.js";
import { migrate } from "../src/migrations.js";
import {
  DEFAULT_LEVELS,
  defaultGrowth,
  DEFAULT_TIERS,
  allocateDay,
  nextLevel,
  platformGrowth,
} from "../src/member-domain.js";
import {
  createMemberRule,
  publishMemberRule,
  initializeMember,
  recordGrowthEvaluation,
  reconcileGrowthDay,
  adjustGrowth,
  miniMemberSummary,
  checkinGrowth,
  dryRunMembers,
  memberAuthorize,
  confirmedGrowth,
} from "../src/member-growth.js";
import {
  createPlatform,
  submitIdentity,
  reviewIdentity,
} from "../src/platform-identities.js";
import { preflightImport, activateImport } from "../src/platform-data.js";
import {
  evaluatePlatformGrowth,
  scheduleGrowthTasks,
  runGrowthTasks,
} from "../src/member-growth.js";
import { readFile } from "node:fs/promises";
import { createApp } from "../src/app.js";
describe(
  "Member Growth PostgreSQL 17",
  { skip: !process.env.TEST_DATABASE_URL },
  () => {
    let db: ReturnType<typeof postgres>;
    const now = new Date("2026-10-02T15:00:00Z");
    before(async () => {
      if (!process.env.TEST_DATABASE_URL)
        throw Error(
          "Member integration requires isolated PostgreSQL 17 TEST_DATABASE_URL",
        );
      const testUrl = new URL(process.env.TEST_DATABASE_URL);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(testUrl.hostname))
        throw Error("Local disposable PostgreSQL only");
      db = postgres(process.env.TEST_DATABASE_URL);
      assert.equal(
        Math.floor(
          Number(
            (await one(db, "SHOW server_version_num")).server_version_num,
          ) / 10000,
        ),
        17,
      );
      await migrate(db);
      await migrate(db);
      process.env.MEMBER_GROWTH_ENABLED = "true";
    });
    after(async () => {
      delete process.env.MEMBER_GROWTH_ENABLED;
      await db?.close();
    });
    async function fixture() {
      const brand = await one(
        db,
        "INSERT INTO brands(name,slug,default_language) VALUES('MEMBER TEST',$1,'en') RETURNING id",
        [randomUUID()],
      );
      const bot = await one(
        db,
        "INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status) VALUES($1,'MEMBER TEST',$2,$2,$2,'en',ARRAY['en'],'active') RETURNING id",
        [brand.id, randomUUID()],
      );
      const admin = await one(
        db,
        "INSERT INTO admins(auth_subject,display_name) VALUES($1,'MEMBER TEST') RETURNING id",
        [randomUUID()],
      );
      await db.query(
        "INSERT INTO admin_roles(admin_id,role_id) SELECT $1,id FROM roles WHERE name='Super Admin'",
        [admin.id],
      );
      const u = await one(
        db,
        "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,12345) RETURNING id",
        [brand.id, bot.id],
      );
      const s = { brandId: brand.id, botId: bot.id, userId: u.id },
        p = { adminId: admin.id };
      const growth = await createMemberRule(
        db,
        p,
        brand.id,
        {
          kind: "growth",
          effectiveFrom: "2026-10-01",
          effectiveUntil: "2026-12-31",
          config: defaultGrowth("America/Sao_Paulo"),
        },
        "test",
      );
      await publishMemberRule(db, p, brand.id, growth.id, "test", now);
      const level = await createMemberRule(
        db,
        p,
        brand.id,
        {
          kind: "level",
          effectiveFrom: "2026-10-01",
          effectiveUntil: "2026-12-31",
          config: DEFAULT_LEVELS,
        },
        "test",
      );
      await publishMemberRule(db, p, brand.id, level.id, "test", now);
      const m = await db.transaction((tx) =>
        initializeMember(tx, s, new Date("2026-10-01T03:00:00Z")),
      );
      return { s, p, m, growth, level };
    }
    async function source(
      f: Awaited<ReturnType<typeof fixture>>,
      kind: any,
      key: string,
      n: number,
      rev = "1",
      status = "eligible",
    ) {
      return db.transaction((tx) =>
        recordGrowthEvaluation(
          tx,
          {
            brandId: f.s.brandId,
            memberId: f.m.id,
            kind,
            key,
            day: "2026-10-02",
            occurredAt: now,
            policyId: f.growth.id,
            ruleId: f.growth.id,
            status,
            reason: status,
            requested: n,
            evidence: { revision: rev },
          },
          "test",
          now,
        ),
      );
    }
    async function balance(f: any) {
      return (
        await one(
          db,
          "SELECT balance::text FROM growth_accounts WHERE member_id=$1",
          [f.m.id],
        )
      ).balance;
    }
    test("tier boundaries and highest only", () => {
      for (const [v, n] of [
        ["0", 0],
        ["19.99", 0],
        ["20", 10],
        ["49.99", 10],
        ["50", 20],
        ["99.99", 20],
        ["100", 40],
        ["299.99", 40],
        ["300", 70],
        ["499.99", 70],
        ["500", 100],
        ["999.99", 100],
        ["1000", 150],
        ["1000.01", 150],
      ] as const)
        assert.equal(platformGrowth(v, DEFAULT_TIERS), n);
    });
    test("level boundaries and grandfathering", () => {
      for (const [n, l] of [
        [0, 1],
        [499, 1],
        [500, 2],
        [1999, 2],
        [2000, 3],
        [5999, 3],
        [6000, 4],
        [14999, 4],
        [15000, 5],
        [15001, 5],
      ])
        assert.equal(nextLevel(BigInt(n!), 1, DEFAULT_LEVELS), l);
      assert.equal(nextLevel(100n, 3, DEFAULT_LEVELS), 3);
    });
    test("cap deterministic ordering independent of arrival", () => {
      const xs = [
        {
          id: "t",
          kind: "member_task" as const,
          requested: 50,
          occurredAt: "x",
          status: "eligible",
        },
        {
          id: "p",
          kind: "platform_daily" as const,
          requested: 150,
          occurredAt: "x",
          status: "eligible",
        },
        ...Array.from({ length: 5 }, (_, i) => ({
          id: "r" + i,
          kind: "qualified_referral" as const,
          requested: 50,
          occurredAt: "x",
          status: "eligible",
        })),
        {
          id: "c",
          kind: "daily_checkin" as const,
          requested: 5,
          occurredAt: "x",
          status: "eligible",
        },
      ];
      assert.deepEqual(allocateDay(xs), allocateDay(xs.reverse()));
      const a = allocateDay(xs);
      assert.equal(
        a.reduce((n, x) => n + x.granted, 0),
        350,
      );
      assert.equal(a.find((x) => x.id === "t")!.granted, 0);
    });
    test("cutover dry run and concurrent initialization creates one member and no point account", async () => {
      const f = await fixture();
      const before = await dryRunMembers(db, f.s.brandId);
      assert.equal(before.new_members, 0);
      await Promise.all(
        Array.from({ length: 5 }, () =>
          db.transaction((tx) => initializeMember(tx, f.s, now)),
        ),
      );
      assert.equal(
        (
          await one(
            db,
            "SELECT count(*)::int AS n FROM members WHERE brand_id=$1",
            [f.s.brandId],
          )
        ).n,
        1,
      );
      assert.equal(
        (
          await one(
            db,
            "SELECT count(*)::int AS n FROM point_accounts WHERE brand_id=$1",
            [f.s.brandId],
          )
        ).n,
        0,
      );
    });
    test("cross Bot same Telegram maps same Brand member; other Brand independent", async () => {
      const f = await fixture(),
        b = await one(
          db,
          "INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages) VALUES($1,'TEST',$2,$2,$2,'en',ARRAY['en']) RETURNING id",
          [f.s.brandId, randomUUID()],
        );
      const u = await one(
        db,
        "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,12345) RETURNING id",
        [f.s.brandId, b.id],
      );
      const m = await db.transaction((tx) =>
        initializeMember(
          tx,
          { brandId: f.s.brandId, botId: b.id, userId: u.id },
          now,
        ),
      );
      assert.equal(m.id, f.m.id);
      const other = await fixture();
      assert.notEqual(other.m.id, m.id);
    });
    test("late sources reconcile 455 to 350, source priorities and ledger account balance", async () => {
      const f = await fixture();
      await source(f, "daily_checkin", "c", 5);
      await source(f, "member_task", "t", 50);
      for (let i = 0; i < 5; i++)
        await source(f, "qualified_referral", "r" + i, 50);
      await source(f, "platform_daily", "p", 150);
      assert.equal(await balance(f), "350");
      const rows = (
        await db.query(
          "SELECT s.source_type,sum(l.delta)::text AS n FROM growth_sources s JOIN growth_ledger l ON l.source_id=s.id WHERE s.member_id=$1 GROUP BY s.source_type",
          [f.m.id],
        )
      ).rows;
      assert.equal(
        rows.find((x) => x.source_type === "qualified_referral")!.n,
        "200",
      );
      assert.equal(rows.find((x) => x.source_type === "member_task")!.n, "0");
    });
    test("correction upward downward same input and same band do not duplicate", async () => {
      const f = await fixture();
      await source(f, "platform_daily", "p", 40);
      await source(f, "platform_daily", "p", 100, "2");
      await source(f, "platform_daily", "p", 40, "3");
      await source(f, "platform_daily", "p", 40, "4");
      await source(f, "platform_daily", "p", 40, "4");
      assert.equal(await balance(f), "40");
      assert.equal(
        (
          await one(
            db,
            "SELECT count(*)::int AS n FROM growth_ledger WHERE member_id=$1",
            [f.m.id],
          )
        ).n,
        3,
      );
      await source(f, "platform_daily", "p", 100, "2");
      assert.equal(await balance(f), "40");
    });
    test("pending and review preserve history, resolution corrects; explicit zero no zero ledger", async () => {
      const f = await fixture();
      await source(f, "platform_daily", "p", 100);
      await source(f, "platform_daily", "p", 0, "2", "review_required");
      assert.equal(await balance(f), "100");
      await source(f, "platform_daily", "p", 0, "3", "pending");
      assert.equal(await balance(f), "100");
      await source(f, "platform_daily", "p", 0, "4", "not_applicable");
      assert.equal(await balance(f), "0");
      assert.equal(
        (
          await one(
            db,
            "SELECT count(*)::int AS n FROM growth_ledger WHERE delta=0",
          )
        ).n,
        0,
      );
    });
    test("concurrent duplicate checkin grants once", async () => {
      const f = await fixture();
      await Promise.all(
        Array.from({ length: 10 }, () => checkinGrowth(db, f.s, "test", now)),
      );
      assert.equal(await balance(f), "5");
      assert.equal(
        (
          await one(
            db,
            "SELECT count(*)::int AS n FROM growth_ledger WHERE member_id=$1",
            [f.m.id],
          )
        ).n,
        1,
      );
    });
    test("level upgrades atomic and negative correction preserves level", async () => {
      const f = await fixture();
      await adjustGrowth(
        db,
        f.p,
        f.s.brandId,
        f.m.id,
        "500",
        "test",
        randomUUID(),
        "test",
        now,
      );
      await adjustGrowth(
        db,
        f.p,
        f.s.brandId,
        f.m.id,
        "1500",
        "test",
        randomUUID(),
        "test",
        now,
      );
      await adjustGrowth(
        db,
        f.p,
        f.s.brandId,
        f.m.id,
        "-100",
        "test",
        randomUUID(),
        "test",
        now,
      );
      const m = await miniMemberSummary(db, f.s, now);
      assert.ok("level" in m);
      assert.equal(m.level, 3);
      assert.equal(m.growth, "1900");
      assert.equal(m.protected, true);
      assert.equal(m.progress, 0);
      await assert.rejects(
        adjustGrowth(
          db,
          f.p,
          f.s.brandId,
          f.m.id,
          "-2000",
          "test",
          randomUUID(),
          "test",
          now,
        ),
        /growth_insufficient_balance/,
      );
    });
    test("manual adjustment idempotency rejects changed payload", async () => {
      const f = await fixture(),
        key = randomUUID();
      await adjustGrowth(
        db,
        f.p,
        f.s.brandId,
        f.m.id,
        "100",
        "test",
        key,
        "test",
        now,
      );
      await adjustGrowth(
        db,
        f.p,
        f.s.brandId,
        f.m.id,
        "100",
        "test",
        key,
        "test",
        now,
      );
      await assert.rejects(
        adjustGrowth(
          db,
          f.p,
          f.s.brandId,
          f.m.id,
          "200",
          "test",
          key,
          "test",
          now,
        ),
        /growth_idempotency_conflict/,
      );
      assert.equal(await balance(f), "100");
    });
    test("published rules immutable and overlapping publication rejected", async () => {
      const f = await fixture();
      await assert.rejects(
        db.query("UPDATE member_rule_versions SET config='{}' WHERE id=$1", [
          f.growth.id,
        ]),
      );
      const r = await createMemberRule(
        db,
        f.p,
        f.s.brandId,
        {
          kind: "growth",
          effectiveFrom: "2026-10-01",
          effectiveUntil: "2026-12-31",
          config: defaultGrowth("America/Sao_Paulo"),
        },
        "test",
      );
      await assert.rejects(
        publishMemberRule(db, f.p, f.s.brandId, r.id, "test", now),
        /member_rule_overlap/,
      );
    });
    test("immutable ledger/history and FK scope protection", async () => {
      const f = await fixture(),
        o = await fixture();
      await source(f, "member_task", "t", 10);
      await assert.rejects(
        db.query("DELETE FROM growth_ledger WHERE member_id=$1", [f.m.id]),
      );
      await assert.rejects(
        db.query(
          "UPDATE member_level_history SET new_level=5 WHERE member_id=$1",
          [f.m.id],
        ),
      );
      await assert.rejects(
        db.query("UPDATE members SET level=0 WHERE id=$1", [f.m.id]),
      );
      await assert.rejects(
        db.query(
          "INSERT INTO member_user_links(brand_id,bot_id,user_id,member_id,telegram_user_id) VALUES($1,$2,$3,$4,12345)",
          [o.s.brandId, o.s.botId, o.s.userId, f.m.id],
        ),
      );
    });
    test("disabled feature blocks economy and does not invent Mini values", async () => {
      const f = await fixture();
      delete process.env.MEMBER_GROWTH_ENABLED;
      try {
        assert.deepEqual(await miniMemberSummary(db, f.s, now), {
          enabled: false,
          available: false,
        });
        await assert.rejects(
          checkinGrowth(db, f.s, "test", now),
          /member_growth_disabled/,
        );
      } finally {
        process.env.MEMBER_GROWTH_ENABLED = "true";
      }
    });
    test("Bot-scoped admin cannot read Brand-wide economic history", async () => {
      const f = await fixture(),
        a = await one(
          db,
          "INSERT INTO admins(auth_subject,display_name) VALUES($1,'scoped') RETURNING id",
          [randomUUID()],
        );
      await db.query(
        "INSERT INTO admin_roles(admin_id,role_id,brand_id,bot_id) SELECT $1,id,$2,$3 FROM roles WHERE name='Super Admin'",
        [a.id, f.s.brandId, f.s.botId],
      );
      await assert.rejects(
        memberAuthorize(db, { adminId: a.id }, f.s.brandId, "growth.read"),
        /forbidden/,
      );
    });
    test("member API auth and readonly preview; no unauthenticated growth", async () => {
      const f = await fixture();
      const app = createApp(
        db,
        () => "",
        async (h) => {
          if (h !== "Bearer test") throw new Error();
          return f.p;
        },
      );
      const r = await app.inject({
        method: "POST",
        url: `/v1/brands/${f.s.brandId}/members/rules/preview`,
        headers: { authorization: "Bearer test" },
        payload: {
          kind: "level",
          effectiveFrom: "2026-10-01",
          effectiveUntil: "2026-12-31",
          config: DEFAULT_LEVELS,
        },
      });
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().writes, 0);
      await app.close();
    });
    test("final account ledger equality and no negative balance", async () => {
      assert.equal(
        (
          await one(
            db,
            "SELECT count(*)::int AS n FROM growth_accounts a WHERE balance<>(SELECT coalesce(sum(delta),0) FROM growth_ledger l WHERE l.member_id=a.member_id) OR balance<0",
          )
        ).n,
        0,
      );
    });

    async function platformFixture() {
      const f = await fixture();
      const platform = await createPlatform(
        db,
        f.p,
        f.s,
        {
          code: "MEMBER_TEST",
          displayName: "STAGING SYNTHETIC",
          market: "BR",
          timezone: "America/Sao_Paulo",
          currency: "BRL",
          verificationMethod: "manual_admin",
          uidFormat: "alphanumeric",
          uidCase: "upper",
          uidMinLength: 3,
          uidMaxLength: 64,
        },
        "member-test",
      );
      const identity = await submitIdentity(
        db,
        { ...f.s, sessionId: randomUUID() } as any,
        platform.id,
        "SYNTHETIC01",
        randomUUID(),
        "member-test",
      );
      await reviewIdentity(
        db,
        f.p,
        f.s,
        identity.id,
        { action: "verify", evidenceReference: "CASE-MEMBER-TEST" },
        "member-test",
      );
      const upload = async (
        value: string,
        complete = "complete",
        replacement = false,
        activate = true,
      ) => {
        const pre: any = await preflightImport(
          db,
          f.p,
          f.s,
          {
            platformId: platform.id,
            businessDate: "2026-10-01",
            timezone: "America/Sao_Paulo",
            currency: "BRL",
            sourceType: "csv",
            filename: "STAGING-TEST.csv",
            fileBase64: Buffer.from(
              "uid,deposit\nSYNTHETIC01," + value,
            ).toString("base64"),
            mapping: { uid: "uid", deposit: "deposit" },
            coverage: { kind: "full", filter: "" },
            completeness: complete,
            replacement,
            reason: "STAGING TEST ONLY",
          },
          "member-test",
        );
        const id = pre.batchId ?? pre.id;
        if (activate)
          await activateImport(db, f.p, f.s, id, true, "member-test");
        return id;
      };
      const batch = await upload("100");
      const r = await createMemberRule(
        db,
        f.p,
        f.s.brandId,
        {
          kind: "platform",
          platformId: platform.id,
          effectiveFrom: "2026-10-02",
          effectiveUntil: "2026-12-31",
          config: {
            currency: "BRL",
            timezone: "America/Sao_Paulo",
            metric: "deposit_amount",
            tiers: DEFAULT_TIERS,
            mappingBatchId: batch,
          },
        },
        "test",
      );
      await publishMemberRule(db, f.p, f.s.brandId, r.id, "test", now);
      const target = {
        ...f.s,
        platformId: platform.id,
        sourceDate: "2026-10-01",
      };
      return { ...f, platform, upload, target };
    }
    test("real P4 canonical fact and revision feed independent Growth; conflict and resolution", async () => {
      const f = await platformFixture();
      await evaluatePlatformGrowth(db, f.target, "test", now);
      assert.equal(await balance(f), "40");
      await f.upload("600", "complete", true);
      await evaluatePlatformGrowth(db, f.target, "test", now);
      assert.equal(await balance(f), "100");
      await f.upload("50", "complete", true);
      await evaluatePlatformGrowth(db, f.target, "test", now);
      assert.equal(await balance(f), "20");
      const conflict = await f.upload("700", "complete", false, false);
      await evaluatePlatformGrowth(db, f.target, "test", now);
      const e = await one(
        db,
        "SELECT e.status FROM growth_sources s JOIN growth_evaluation_revisions e ON e.id=s.current_evaluation_id WHERE s.member_id=$1",
        [f.m.id],
      );
      assert.equal(e.status, "review_required");
      assert.equal(await balance(f), "20");
      await activateImport(db, f.p, f.s, conflict, true, "test");
      await evaluatePlatformGrowth(db, f.target, "test", now);
      assert.equal(await balance(f), "100");
      assert.equal(
        (
          await one(
            db,
            "SELECT count(*)::int AS n FROM daily_entitlements WHERE brand_id=$1",
            [f.s.brandId],
          )
        ).n,
        0,
      );
    });
    test("real P4 null and incomplete pending, explicit zero not applicable", async () => {
      const f = await platformFixture();
      await f.upload("", "complete", true);
      await evaluatePlatformGrowth(db, f.target, "test", now);
      let e = await one(
        db,
        "SELECT e.status FROM growth_sources s JOIN growth_evaluation_revisions e ON e.id=s.current_evaluation_id WHERE s.member_id=$1",
        [f.m.id],
      );
      assert.equal(e.status, "pending");
      await f.upload("0", "complete", true);
      await evaluatePlatformGrowth(db, f.target, "test", now);
      e = await one(
        db,
        "SELECT e.status FROM growth_sources s JOIN growth_evaluation_revisions e ON e.id=s.current_evaluation_id WHERE s.member_id=$1",
        [f.m.id],
      );
      assert.equal(e.status, "not_applicable");
      assert.equal(await balance(f), "0");
      await f.upload("101", "incomplete", true);
      await evaluatePlatformGrowth(db, f.target, "test", now);
      e = await one(
        db,
        "SELECT e.status FROM growth_sources s JOIN growth_evaluation_revisions e ON e.id=s.current_evaluation_id WHERE s.member_id=$1",
        [f.m.id],
      );
      assert.equal(e.status, "pending");
    });
    test("persisted task catch-up re-reads latest fact; duplicate scheduling and workers", async () => {
      const f = await platformFixture();
      await f.upload("600", "complete", true);
      await scheduleGrowthTasks(db, new Date("2026-10-03T15:00:00Z"));
      await scheduleGrowthTasks(db, new Date("2026-10-03T15:00:00Z"));
      await Promise.all([
        runGrowthTasks(db, 100, now),
        runGrowthTasks(db, 100, now),
      ]);
      assert.equal(await balance(f), "100");
      const rows = await db.query(
        "SELECT event_key,count(*) FROM growth_evaluation_tasks WHERE brand_id=$1 GROUP BY event_key HAVING count(*)>1",
        [f.s.brandId],
      );
      assert.equal(rows.rows.length, 0);
    });
    test("runtime grants permit independent Growth transactions and deny account/ledger/DDL mutation", async () => {
      // Dedicated test-only login: shared telegram_app may be absent, LOGIN or NOLOGIN.
      // Never change its password/attributes or depend on another suite's role setup.
      const sharedBefore = (await db.query(
        "SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname='telegram_app'",
      )).rows;
      const role = "member_rt_" + randomUUID().replaceAll("-", "");
      const runtimePassword = randomUUID();
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.username = role;
      url.password = runtimePassword;
      const runtime = postgres(url.toString());
      await db.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
      try {
        await db.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
        await db.query(
          (await readFile(new URL("../db/runtime-grants.sql", import.meta.url), "utf8"))
            .replaceAll("telegram_app", role),
        );
        const f = await fixture();
        assert.equal((await one(runtime, "SELECT current_user AS u")).u, role);
        assert.deepEqual(await one(runtime,
          "SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user"),
          {rolcanlogin:true,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false});
        await checkinGrowth(runtime, f.s, "runtime", now);
        assert.equal(await balance(f), "5");
        await assert.rejects(
          runtime.query(
            "UPDATE growth_accounts SET balance=999 WHERE member_id=$1",
            [f.m.id],
          ),
        );
        await assert.rejects(runtime.query("UPDATE growth_ledger SET delta=1"));
        await assert.rejects(runtime.query("DELETE FROM growth_ledger"));
        await assert.rejects(runtime.query("TRUNCATE growth_ledger"));
        await assert.rejects(
          runtime.query("CREATE TABLE runtime_forbidden(id int)"),
        );
        await assert.rejects(
          runtime.query("UPDATE point_accounts SET balance=1"),
        );
        await assert.rejects(runtime.query("UPDATE point_ledger SET delta=1"));
        await assert.rejects(
          runtime.query("UPDATE audit_logs SET note='changed'"),
        );
        const r = await createMemberRule(
          runtime,
          f.p,
          f.s.brandId,
          {
            kind: "level",
            effectiveFrom: "2027-01-01",
            effectiveUntil: "2027-12-31",
            config: DEFAULT_LEVELS,
          },
          "runtime",
        );
        await publishMemberRule(
          runtime,
          f.p,
          f.s.brandId,
          r.id,
          "runtime",
          now,
        );
      } finally {
        await runtime.close();
        await db.query(`DROP OWNED BY ${role}`);
        await db.query(`DROP ROLE ${role}`);
      }
      assert.deepEqual((await db.query(
        "SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname='telegram_app'",
      )).rows, sharedBefore);
      assert.equal((await one(db, "SELECT count(*)::int AS n FROM pg_roles WHERE rolname=$1", [role])).n, 0);
    });
    test("pending platform does not block confirmed daily checkin", async () => {
      const f = await fixture();
      await source(f, "platform_daily", "p", 0, "1", "pending");
      await checkinGrowth(db, f.s, "test", now);
      assert.equal(await balance(f), "5");
    });
    test("server analytics, adjustment confirmation and Mini authentication boundary", async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now });
      const f = await fixture();
      const api = createApp(
        db,
        () => "",
        async () => f.p,
      );
      const base = `/v1/brands/${f.s.brandId}/members`;
      const body = { delta: "500", reason: "TEST", key: randomUUID() };
      assert.equal(
        (
          await api.inject({
            method: "POST",
            url: base + "/" + f.m.id + "/adjustments",
            payload: body,
          })
        ).statusCode,
        409,
      );
      const preview = await api.inject({
        method: "POST",
        url: base + "/" + f.m.id + "/adjustment-preview",
        payload: body,
      });
      assert.equal(preview.statusCode, 200);
      const posted = await api.inject({
        method: "POST",
        url: base + "/" + f.m.id + "/adjustments",
        payload: { ...body, confirmation: preview.json().confirmation },
      });
      assert.equal(posted.statusCode, 200);
      await source(f, "member_task", "task", 20);
      const response = await api.inject(
        base + "/analytics?from=2026-10-01&to=2026-10-02",
      );
      assert.equal(response.statusCode, 200);
      const metric = response.json();
      assert.equal(metric.members, 1);
      assert.equal(metric.upgrades, 1);
      assert.equal(metric.issued, "20");
      assert.equal(metric.net, "520");
      assert.equal(metric.earners, 1);
      assert.deepEqual(metric.distribution, [{ level: 2, n: 1 }]);
      await api.close();
    });
    test("internal completion contracts enforce cap and no historical backfill", async () => {
      const f = await fixture();
      const verify = async () => ({
        kind: "member_task" as const,
        key: "test-task",
        at: now,
        growth: 50,
        evidenceId: randomUUID(),
      });
      const stableEvidence = randomUUID();
      await confirmedGrowth(
        db,
        f.s,
        async () => ({ ...(await verify()), evidenceId: stableEvidence }),
        "test",
        now,
      );
      await confirmedGrowth(
        db,
        f.s,
        async () => ({ ...(await verify()), evidenceId: stableEvidence }),
        "test",
        now,
      );
      assert.equal(await balance(f), "50");
      await assert.rejects(
        confirmedGrowth(
          db,
          f.s,
          async () => ({ ...(await verify()), growth: 51 }),
          "test",
          now,
        ),
        /growth_completion_invalid/,
      );
      await assert.rejects(
        confirmedGrowth(
          db,
          f.s,
          async () => ({
            ...(await verify()),
            at: new Date("2026-09-30T00:00:00Z"),
          }),
          "test",
          now,
        ),
      );
    });

    test("new Mini routes reject admin Cookie, fake Bearer and scope override; Admin rejects Mini bearer", async () => {
      const f = await fixture();
      const app = createApp(
        db,
        () => {
          throw Error("No secret access expected");
        },
        async (h) => {
          if (h !== "Bearer admin") throw new DomainError("unauthorized", 401);
          return f.p;
        },
        undefined,
        {
          bindings: [
            {
              appKey: "member-test",
              botId: f.s.botId,
              origin: "https://member.example",
              tokenSecretRef: "TEST_BOT_SECRET",
            },
          ],
        },
      );
      assert.equal(
        (
          await app.inject({
            url: "/v1/mini/member",
            headers: { cookie: "admin_session=fake" },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            url: "/v1/mini/member",
            headers: { authorization: "Bearer " + "a".repeat(64) },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (await app.inject({ url: "/v1/mini/member?userId=" + f.s.userId }))
          .statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/v1/mini/member/checkin",
            payload: {},
            headers: { origin: "https://wrong.example" },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/v1/mini/member/checkin",
            payload: {},
            headers: { origin: "https://member.example" },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            url: `/v1/brands/${f.s.brandId}/members`,
            headers: { authorization: "Bearer " + "a".repeat(64) },
          })
        ).statusCode,
        401,
      );
      assert.equal(await balance(f), "0");
      await app.close();
    });
  },
);
