// Isolated acceptance fixture. Never imported by production or Vite source.
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  postgres,
  one,
  DomainError,
  type Database,
  type Queryable,
} from "../../src/db.js";
import { migrate } from "../../src/migrations.js";
import { createApp } from "../../src/app.js";
import { hashPassword } from "../../src/passwords.js";
if (!process.env.UI_TEST_PASSWORD)
  throw new Error("Ephemeral UI test password required");
let db: Database, close: () => Promise<void>;
if (process.env.TEST_DATABASE_URL) {
  const pool = postgres(process.env.TEST_DATABASE_URL);
  db = pool;
  close = pool.close;
} else {
  const memory = new PGlite();
  const adapt = (client: any): Queryable => ({
    query: async (sql, params) =>
      params === undefined
        ? ((await client.exec(sql)).at(-1) ?? { rows: [] })
        : client.query(sql, params),
  });
  db = {
    ...adapt(memory),
    transaction: (fn) => memory.transaction((tx) => fn(adapt(tx))),
  };
  close = () => memory.close();
}
await migrate(db);
const admin = await one(
  db,
  "INSERT INTO admins(auth_subject,display_name,ui_language) VALUES($1,'验收管理员','zh-CN') RETURNING id",
  [randomUUID()],
);
await db.query(
  "INSERT INTO admin_credentials(admin_id,login,password_hash) VALUES($1,$2,$3)",
  [
    admin.id,
    process.env.UI_TEST_LOGIN,
    await hashPassword(process.env.UI_TEST_PASSWORD),
  ],
);
for (const name of ["验收品牌 A", "验收品牌 B"]) {
  const brand = await one(
    db,
    "INSERT INTO brands(name,slug,default_language) VALUES($1,$2,'pt-BR') RETURNING id",
    [name, randomUUID()],
  );
  await db.query(
    "INSERT INTO admin_roles(admin_id,role_id,brand_id) SELECT $1,id,$2 FROM roles WHERE name='Admin'",
    [admin.id, brand.id],
  );
  for (const botName of name.endsWith("A")
    ? ["验收 Bot A1", "验收 Bot A2"]
    : ["验收 Bot B1"]) {
    const bot = await one(
      db,
      "INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status) VALUES($1,$2,$3,$4,$5,'pt-BR',ARRAY['pt-BR','en'],'active') RETURNING id",
      [brand.id, botName, randomUUID(), randomUUID(), randomUUID()],
    );
    for (let index = 0; index < 51; index++)
      await db.query(
        "INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id,first_name,telegram_language_code) VALUES($1,$2,$3,$4,'zh-CN')",
        [
          brand.id,
          bot.id,
          String(5000000000 + index),
          `${botName} 用户 ${index}`,
        ],
      );
    const inviter = await one(
      db,
      "SELECT id FROM telegram_users WHERE bot_id=$1 AND telegram_user_id=5000000000",
      [bot.id],
    );
    await db.query(
      "INSERT INTO referrals(brand_id,bot_id,inviter_id,invitee_id,start_parameter) SELECT brand_id,bot_id,$2,id,'isolated-ui-acceptance' FROM telegram_users WHERE bot_id=$1 AND id<>$2",
      [bot.id, inviter.id],
    );
  }
}
// Isolated importer identity keeps the ordinary Admin regression fixture unchanged.
const importer = await one(
  db,
  "INSERT INTO admins(auth_subject,display_name,ui_language) VALUES($1,'验收导入员','zh-CN') RETURNING id",
  [randomUUID()],
);
await db.query(
  "INSERT INTO admin_credentials(admin_id,login,password_hash) VALUES($1,$2,$3)",
  [
    importer.id,
    process.env.UI_TEST_LOGIN + "-p4",
    await hashPassword(process.env.UI_TEST_PASSWORD!),
  ],
);
const dataRole = await one(
  db,
  "INSERT INTO roles(name) VALUES($1) RETURNING id",
  ["P4 UI " + randomUUID()],
);
await db.query(
  "INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE name IN ('platforms.read','platforms.manage','platform_data.read','platform_data.import','platform_data.activate')",
  [dataRole.id],
);
await db.query(
  "INSERT INTO admin_roles(admin_id,role_id,brand_id) SELECT $2::uuid,role_id,brand_id FROM admin_roles WHERE admin_id=$1",
  [admin.id, importer.id],
);
await db.query(
  "INSERT INTO admin_roles(admin_id,role_id,brand_id) SELECT DISTINCT $3::uuid,$2::uuid,brand_id FROM admin_roles WHERE admin_id=$1",
  [admin.id, dataRole.id, importer.id],
);
const app = createApp(
  db,
  () => undefined,
  async () => {
    throw new DomainError("unauthorized", 401);
  },
  {
    allowedOrigins: ["http://127.0.0.1:5173", "http://localhost:5173"],
    secure: false,
    sameSite: "Lax",
    sessionSeconds: 28800,
    production: false,
  },
);
await app.listen({ host: "127.0.0.1", port: 3000 });
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    await app.close();
    await close();
    process.exit(0);
  });
