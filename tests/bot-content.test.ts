import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { one, postgres, type Database, type Queryable } from "../src/db.js";
import { migrate } from "../src/migrations.js";
import { createApp } from "../src/app.js";
import { handleUpdate } from "../src/telegram.js";
import {
  defaultBotContent,
  botContentSchema,
  previewBotContent,
  botCommandReply,
} from "../src/bot-content.js";
let db: Database, close: () => Promise<void>;
before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    const u = new URL(process.env.TEST_DATABASE_URL);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
    const pg = postgres(u.toString());
    db = pg;
    close = pg.close;
    assert.equal(
      Math.floor(
        Number((await one(db, "SHOW server_version_num")).server_version_num) /
          10000,
      ),
      17,
    );
  } else {
    const pg = new PGlite();
    const adapt = (x: any): Queryable => ({
      query: async (sql, params) =>
        params === undefined
          ? ((await x.exec(sql)).at(-1) ?? { rows: [] })
          : x.query(sql, params),
    });
    db = {
      ...adapt(pg),
      transaction: (fn) => pg.transaction((tx) => fn(adapt(tx))),
    };
    close = () => pg.close();
  }
  await migrate(db);
});
after(async () => close());
async function fixture(binding = true) {
  const brand = await one(
    db,
    "INSERT INTO brands(name,slug,default_language) VALUES('Content Test',$1,'en') RETURNING id",
    [randomUUID()],
  );
  const bot = await one(
    db,
    "INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,status,default_language,supported_languages) VALUES($1,'Test',$2,$3,$4,'active','en',ARRAY['en','zh-CN','pt-BR','es-MX','fil']) RETURNING *",
    [
      brand.id,
      `content_${randomUUID().replaceAll("-", "")}`,
      `TOKEN_${randomUUID()}`,
      `SECRET_${randomUUID()}`,
    ],
  );
  const admin = await one(
    db,
    "INSERT INTO admins(auth_subject,display_name) VALUES($1,'Test') RETURNING id",
    [`${randomUUID()}@test.invalid`],
  );
  await db.query(
    "INSERT INTO admin_roles(admin_id,role_id,brand_id,bot_id) SELECT $1,id,$2,$3 FROM roles WHERE name='Operator'",
    [admin.id, brand.id, bot.id],
  );
  const config = {
    bindings: [
      {
        appKey: "test",
        botId: bot.id,
        origin: "https://mini.example.com",
        tokenSecretRef: "TOKEN_TEST",
      },
    ],
  };
  const app = createApp(
    db,
    () => "test-secret",
    async () => ({ adminId: admin.id }),
    undefined,
    binding ? config : undefined,
  );
  const path = `/v1/brands/${brand.id}/bots/${bot.id}/operations/content`;
  const post = (suffix: string, payload: unknown) =>
    app.inject({ method: "POST", url: path + suffix, payload: payload as any });
  const publish = async () => {
    assert.equal(
      (await post("/draft", { config: defaultBotContent, expectedVersion: 0 }))
        .statusCode,
      200,
    );
    assert.equal(
      (await post("/publish", { expectedVersion: 1 })).statusCode,
      200,
    );
  };
  const update = (
    id: number,
    user: number,
    text = "/start",
    chat: any = { id: user, type: "private" },
    language_code = "en",
  ) =>
    handleUpdate(
      db,
      bot.id,
      "test-secret",
      {
        update_id: id,
        message: { from: { id: user, language_code }, text, chat },
      },
      () => "test-secret",
      config,
    );
  return { brand, bot, admin, config, app, path, post, publish, update };
}
test("five-language strict config, safe support links and preview never claim delivery", () => {
  for (const language of ["zh-CN", "en", "pt-BR", "es-MX", "fil"] as const) {
    const p = previewBotContent(
      defaultBotContent,
      language,
      "new",
      "https://mini.example.com/mini.html",
    );
    assert.equal(p.deliveryConfirmed, false);
    assert.equal(p.buttons.length, 2);
    assert.ok(p.text.length > 20);
    assert.equal(
      p.buttons[1]?.web_app?.url,
      "https://mini.example.com/mini.html?view=invite",
    );
  }
  for (const supportUrl of [
    "http://t.me/support",
    "https://evil.test/support",
    "https://t.me/support?token=secret",
    "https://user:pass@t.me/support",
    "https://t.me/+invite",
    "https://t.me/support/extra",
  ])
    assert.equal(
      botContentSchema.safeParse({ ...defaultBotContent, supportUrl }).success,
      false,
    );
  assert.equal(
    botContentSchema.safeParse({
      ...defaultBotContent,
      supportUrl: "https://t.me/support_team",
    }).success,
    true,
  );
  assert.equal(
    botContentSchema.safeParse({
      ...defaultBotContent,
      locales: { en: defaultBotContent.locales.en },
    }).success,
    false,
  );
});
test("draft, preview, publish and disable are scoped, versioned and audited without sending", async () => {
  const f = await fixture();
  try {
    const initial = (await f.app.inject(f.path)).json();
    assert.equal(initial.enabled, false);
    assert.equal(initial.draftVersion, 0);
    assert.equal(initial.miniUrl, "https://mini.example.com/mini.html");
    const preview = await f.post("/preview", {
      config: defaultBotContent,
      language: "pt-BR",
      audience: "new",
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().deliveryConfirmed, false);
    await f.publish();
    const state = (await f.app.inject(f.path)).json();
    assert.equal(state.publishedVersion, 1);
    assert.equal(state.enabled, true);
    assert.equal(
      (
        await f.post("/draft", {
          config: defaultBotContent,
          expectedVersion: 0,
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await f.post("/disable", { expectedVersion: 0 })).statusCode,
      409,
    );
    assert.equal(
      (await f.post("/disable", { expectedVersion: 1 })).json().enabled,
      false,
    );
    const audit = (
      await db.query(
        "SELECT action,after_data FROM audit_logs WHERE bot_id=$1",
        [f.bot.id],
      )
    ).rows;
    assert.equal(audit.length, 3);
    assert.ok(
      audit.every(
        (a) =>
          !JSON.stringify(a).includes(defaultBotContent.locales.en.newUser),
      ),
    );
    assert.equal(
      Number(
        (
          await one(
            db,
            "SELECT count(*) AS n FROM telegram_updates WHERE bot_id=$1",
            [f.bot.id],
          )
        ).n,
      ),
      0,
    );
  } finally {
    await f.app.close();
  }
});
test("concurrent draft saves cannot silently overwrite; missing trusted Mini binding cannot publish", async () => {
  const f = await fixture(false);
  try {
    const results = await Promise.all([
      f.post("/draft", { config: defaultBotContent, expectedVersion: 0 }),
      f.post("/draft", { config: defaultBotContent, expectedVersion: 0 }),
    ]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    const r = await f.post("/publish", { expectedVersion: 1 });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error, "bot_content_mini_unavailable");
  } finally {
    await f.app.close();
  }
});
test("permission and cross-brand checks precede content access or publish", async () => {
  const a = await fixture(),
    b = await fixture();
  try {
    const forbidden = await a.app.inject(b.path);
    assert.equal(forbidden.statusCode, 403);
    assert.equal(
      (
        await a.app.inject({
          method: "POST",
          url: b.path + "/draft",
          payload: { config: defaultBotContent, expectedVersion: 0 },
        })
      ).statusCode,
      403,
    );
    const wrong = a.path.replace(a.brand.id, b.brand.id);
    assert.equal((await a.app.inject(wrong)).statusCode, 404);
    await db.query("DELETE FROM admin_roles WHERE admin_id=$1", [a.admin.id]);
    assert.equal((await a.app.inject(a.path)).statusCode, 403);
    assert.equal(
      (
        await a.post("/preview", {
          config: defaultBotContent,
          language: "en",
          audience: "new",
        })
      ).statusCode,
      403,
    );
  } finally {
    await a.app.close();
    await b.app.close();
  }
});
test("private start sends new/returning five-language content once; disabled content stops responses", async () => {
  const f = await fixture();
  try {
    await f.publish();
    let id = 1;
    for (const [language, locale] of [
      ["zh", "zh-CN"],
      ["en", "en"],
      ["pt", "pt-BR"],
      ["es", "es-MX"],
      ["tl", "fil"],
    ] as const) {
      const user = 9000 + id;
      const first = await f.update(id++, user, "/start", undefined, language);
      assert.equal(
        "text" in first && first.text,
        defaultBotContent.locales[locale].newUser,
      );
      const second = await f.update(id++, user, "/start", undefined, language);
      assert.equal(
        "text" in second && second.text,
        defaultBotContent.locales[locale].returningUser,
      );
    }
    const repeat = await f.update(1, 9001);
    assert.equal(repeat.duplicate, true);
    assert.equal("method" in repeat, false);
    assert.equal(
      (await f.post("/disable", { expectedVersion: 1 })).statusCode,
      200,
    );
    assert.equal("method" in (await f.update(id++, 9999)), false);
  } finally {
    await f.app.close();
  }
});
test("wrong Bot command, group and forged private chat cannot receive welcome", async () => {
  const f = await fixture();
  try {
    await f.publish();
    assert.equal(
      "method" in (await f.update(1, 100, "/start@otherbot")),
      false,
    );
    assert.equal(
      "method" in
        (await f.update(2, 100, "/start", { id: -77, type: "group" })),
      false,
    );
    assert.equal(
      "method" in
        (await f.update(3, 100, "/start", { id: 101, type: "private" })),
      false,
    );
    await assert.rejects(
      () =>
        handleUpdate(
          db,
          f.bot.id,
          "wrong",
          { update_id: 4 },
          () => "test-secret",
          f.config,
        ),
      /unauthorized/,
    );
  } finally {
    await f.app.close();
  }
});
test("invite/help use trusted links; existing ref binding unchanged and no rewards or other Bot writes", async () => {
  const f = await fixture(),
    b = await fixture();
  try {
    const c = { ...defaultBotContent, supportUrl: "https://t.me/test_support" };
    await f.post("/draft", { config: c, expectedVersion: 0 });
    await f.post("/publish", { expectedVersion: 1 });
    await f.update(1, 100);
    const inviter = await one(
      db,
      "SELECT referral_code,id FROM telegram_users WHERE bot_id=$1 AND telegram_user_id=100",
      [f.bot.id],
    );
    await f.update(2, 101, `/start ref_${inviter.referral_code}`);
    await f.update(3, 101, `/start ref_${inviter.referral_code}`);
    assert.equal(
      Number(
        (
          await one(db, "SELECT count(*) AS n FROM referrals WHERE bot_id=$1", [
            f.bot.id,
          ])
        ).n,
      ),
      1,
    );
    const inv = await f.update(4, 100, "/invite");
    assert.equal(
      "reply_markup" in inv &&
        inv.reply_markup.inline_keyboard[0]?.[0]?.web_app?.url,
      "https://mini.example.com/mini.html?view=invite",
    );
    const help = await f.update(5, 100, "/help");
    assert.equal(
      "reply_markup" in help && help.reply_markup.inline_keyboard[0]?.[0]?.url,
      "https://t.me/test_support",
    );
    assert.equal("method" in (await b.update(1, 100)), false);
    for (const table of [
      "point_ledger",
      "point_lots",
      "growth_ledger",
      "referral_reward_events",
    ])
      assert.equal(
        Number(
          (
            await one(
              db,
              `SELECT count(*) AS n FROM ${table} WHERE brand_id=$1`,
              [f.brand.id],
            )
          ).n,
        ),
        0,
      );
  } finally {
    await f.app.close();
    await b.app.close();
  }
});
test("missing content read permission fails closed, genuine database errors propagate", async () => {
  const input = {
    chatId: 1,
    text: "/start",
    username: "contenttestbot",
    botLanguage: "en",
    isNew: true,
  };
  const s = { brandId: randomUUID(), botId: randomUUID() };
  const config = {
    bindings: [
      {
        appKey: "test",
        botId: s.botId,
        origin: "https://mini.example.com",
        tokenSecretRef: "TOKEN_TEST",
      },
    ],
  };
  let calls = 0;
  const limited: Queryable = {
    query: async () => {
      calls++;
      return { rows: [{ readable: false }] as any };
    },
  };
  assert.equal(await botCommandReply(limited, s, input, config), undefined);
  assert.equal(calls, 1);
  const broken: Queryable = {
    query: async () => {
      throw new Error("database unavailable");
    },
  };
  await assert.rejects(
    () => botCommandReply(broken, s, input, config),
    /database unavailable/,
  );
});
test("minimal runtime column grants support publishing but not scope/id changes or deletion", async () => {
  const f = await fixture();
  const role = `bot_content_test_${randomUUID().replaceAll("-", "")}`;
  await db.query(`CREATE ROLE ${role} NOLOGIN`);
  try {
    await db.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await db.query(
      `GRANT SELECT ON telegram_bots,admins,admin_roles,roles,role_permissions,permissions,message_templates TO ${role}`,
    );
    await db.query(`GRANT UPDATE(id) ON telegram_bots TO ${role}`);
    await db.query(`GRANT INSERT ON audit_logs TO ${role}`);
    const scoped: Database = {
      query: (sql, params) =>
        db.transaction(async (tx) => {
          await tx.query(`SET LOCAL ROLE ${role}`);
          return tx.query(sql, params);
        }),
      transaction: (fn) =>
        db.transaction(async (tx) => {
          await tx.query(`SET LOCAL ROLE ${role}`);
          return fn(tx);
        }),
    };
    const runtime = createApp(
      scoped,
      () => "test-secret",
      async () => ({ adminId: f.admin.id }),
      undefined,
      f.config,
    );
    try {
      const save = () =>
        runtime.inject({
          method: "POST",
          url: f.path + "/draft",
          payload: { config: defaultBotContent, expectedVersion: 0 },
        });
      const denied = await save();
      assert.equal(denied.statusCode, 503);
      assert.equal(denied.json().error, "bot_content_storage_unavailable");
      await db.query(
        `GRANT INSERT(brand_id,bot_id,template_key,language,body,enabled,version),UPDATE(body,enabled,version,updated_at) ON message_templates TO ${role}`,
      );
      assert.equal((await save()).statusCode, 200);
      assert.equal(
        (
          await runtime.inject({
            method: "POST",
            url: f.path + "/publish",
            payload: { expectedVersion: 1 },
          })
        ).statusCode,
        200,
      );
      for (const sql of [
        "UPDATE message_templates SET bot_id=bot_id",
        "UPDATE message_templates SET id=id",
        "DELETE FROM message_templates",
        "TRUNCATE message_templates",
      ])
        await assert.rejects(() => scoped.query(sql), /permission denied/);
      assert.equal(
        (
          await runtime.inject({
            method: "POST",
            url: f.path + "/disable",
            payload: { expectedVersion: 1 },
          })
        ).statusCode,
        200,
      );
    } finally {
      await runtime.close();
    }
  } finally {
    await db.query(`DROP OWNED BY ${role}`);
    await db.query(`DROP ROLE ${role}`);
    await f.app.close();
  }
});
test("actual webhook route returns a Telegram method without logging delivery success or repeating it", async () => {
  const f = await fixture();
  try {
    await f.publish();
    const send = (id: number) =>
      f.app.inject({
        method: "POST",
        url: `/webhooks/telegram/${f.bot.id}`,
        headers: { "x-telegram-bot-api-secret-token": "test-secret" },
        payload: {
          update_id: id,
          message: {
            from: { id: 9888, language_code: "fil" },
            chat: { id: 9888, type: "private" },
            text: "/start",
          },
        },
      });
    const first = await send(99);
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().method, "sendMessage");
    assert.equal(first.json().chat_id, 9888);
    assert.equal(first.json().text, defaultBotContent.locales.fil.newUser);
    assert.equal(first.json().reply_markup.inline_keyboard.length, 2);
    assert.equal(first.json().deliveryConfirmed, undefined);
    assert.equal((await send(99)).json().method, undefined);
    assert.equal(
      Number(
        (
          await one(
            db,
            "SELECT count(*) AS n FROM message_delivery_logs WHERE bot_id=$1",
            [f.bot.id],
          )
        ).n,
      ),
      0,
    );
    await db.query(
      "UPDATE telegram_users SET status='blocked' WHERE bot_id=$1",
      [f.bot.id],
    );
    assert.equal((await send(100)).json().method, undefined);
  } finally {
    await f.app.close();
  }
});
