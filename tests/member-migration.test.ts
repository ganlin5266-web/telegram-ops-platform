import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { postgres, one } from "../src/db.js";
import { migrate } from "../src/migrations.js";
import { postPoints } from "../src/points.js";
test(
  "013 upgrades populated 012 atomically, preserves old rows and leaves new tables empty",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
    const name = "member_upgrade_" + randomUUID().replaceAll("-", "");
    const admin = postgres(url.toString());
    await admin.query(`CREATE DATABASE ${name}`);
    url.pathname = "/" + name;
    const db = postgres(url.toString());
    try {
      await db.transaction(async (tx) => {
        await tx.query(
          "CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
        );
        for (const file of (await readdir("db/migrations"))
          .filter((n) => n.endsWith(".sql") && n < "013")
          .sort()) {
          const sql = await readFile("db/migrations/" + file, "utf8");
          await tx.query(sql);
          await tx.query(
            "INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",
            [file, createHash("sha256").update(sql).digest("hex")],
          );
        }
      });
      const b = await one(
        db,
        "INSERT INTO brands(name,slug,default_language) VALUES('UPGRADE TEST',$1,'en') RETURNING id",
        [randomUUID()],
      );
      const bot = await one(
        db,
        "INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages) VALUES($1,'UPGRADE TEST',$2,$2,$2,'en',ARRAY['en']) RETURNING id",
        [b.id, randomUUID()],
      );
      const u = await one(
        db,
        "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,999999) RETURNING id",
        [b.id, bot.id],
      );
      await db.transaction((tx) =>
        postPoints(tx, {
          brandId: b.id,
          botId: bot.id,
          userId: u.id,
          delta: "1380",
          source: "admin",
          businessType: "manual_adjustment",
          businessId: randomUUID(),
          idempotencyKey: randomUUID(),
        }),
      );
      const old = [
        "brands",
        "telegram_bots",
        "telegram_users",
        "admins",
        "admin_credentials",
        "admin_roles",
        "audit_logs",
        "point_accounts",
        "point_ledger",
        "point_lots",
        "point_lot_allocations",
        "referrals",
        "redemptions",
        "redemption_codes",
        "platforms",
        "platform_identities",
        "platform_user_daily_facts",
        "daily_entitlements",
      ];
      const snapshot = async () => {
        const out: Record<string, unknown> = {};
        for (const t of old)
          out[t] = await one(
            db,
            `SELECT count(*)::int AS n,md5(coalesce(string_agg(to_jsonb(t)::text,',' ORDER BY to_jsonb(t)::text),'')) AS fingerprint FROM ${t} t`,
          );
        return out;
      };
      const before = await snapshot();
      await migrate(db);
      await migrate(db);
      assert.deepEqual(await snapshot(), before);
      const tables = [
        "members",
        "member_user_links",
        "growth_accounts",
        "growth_sources",
        "growth_evaluation_revisions",
        "growth_daily_reconciliations",
        "growth_ledger",
        "member_level_history",
        "member_rule_versions",
        "growth_evaluation_tasks",
      ];
      for (const t of tables)
        assert.equal(
          (await one(db, `SELECT count(*)::int AS n FROM ${t}`)).n,
          0,
        );
      assert.equal(
        (await one(db, "SELECT count(*)::int AS n FROM schema_migrations")).n,
        13,
      );
    } finally {
      await db.close();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.close();
    }
  },
);
