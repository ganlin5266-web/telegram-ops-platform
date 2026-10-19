import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/migrations.js";
import { one, type Database, type Queryable } from "../src/db.js";
import {
  changeRedemptionRule,
  createRedemptionRule,
  importCodeBatch,
} from "../src/redemption-v2.js";
import {
  createRedemptionCodeVault,
  type RedemptionCodeVault,
} from "../src/redemption-vault.js";
import { createApp } from "../src/app.js";

let db: Database, close: () => Promise<void>, vault: RedemptionCodeVault;
const adapt = (p: any): Queryable => ({
  query: async (sql, args) =>
    args === undefined
      ? ((await p.exec(sql)).at(-1) ?? { rows: [] })
      : p.query(sql, args),
});

before(async () => {
  const p = new PGlite();
  db = {
    ...adapt(p),
    transaction: (fn) => p.transaction((tx) => fn(adapt(tx))),
  };
  close = () => p.close();
  await migrate(db);
  vault = createRedemptionCodeVault({
    REDEMPTION_CODE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    REDEMPTION_CODE_FINGERPRINT_KEY: randomBytes(32).toString("base64"),
    REDEMPTION_CODE_KEY_VERSION: "test-v1",
  })!;
});
after(async () => close());

async function fixture() {
  const brand = await one(
    db,
    "INSERT INTO brands(name,slug,default_language) VALUES('B2B',$1,'en') RETURNING id",
    [randomUUID()],
  );
  const bot = await one(
    db,
    `INSERT INTO telegram_bots(
  brand_id,name,username,token_secret_ref,webhook_secret_ref,
  default_language,supported_languages,status
 ) VALUES($1,'B2B',$2,$3,$4,'en',ARRAY['en'],'active') RETURNING id`,
    [brand.id, randomUUID(), randomUUID(), randomUUID()],
  );
  const platform = await one(
    db,
    `INSERT INTO platforms(
  brand_id,code,display_name,market,timezone,currency,verification_method
 ) VALUES($1,$2,'B2B','BR','UTC','BRL','manual_admin') RETURNING id`,
    [
      brand.id,
      `B2B_${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    ],
  );
  const admin = await one(
    db,
    "INSERT INTO admins(auth_subject,display_name) VALUES($1,'B2B') RETURNING id",
    [randomUUID()],
  );
  await db.query(
    `INSERT INTO admin_roles(admin_id,role_id,brand_id)
  SELECT $1,id,$2 FROM roles WHERE name='Super Admin'`,
    [admin.id, brand.id],
  );
  return {
    brandId: brand.id,
    botId: bot.id,
    platformId: platform.id,
    adminId: admin.id,
    scope: { brandId: brand.id, botId: bot.id },
    principal: { adminId: admin.id },
  };
}

async function publishedRule(
  f: Awaited<ReturnType<typeof fixture>>,
  tierKey = "brl_10",
) {
  const rule = await createRedemptionRule(
    db,
    f.principal,
    f.scope,
    {
      platformId: f.platformId,
      tierKey,
      name: "B2B fixed tier",
      pointsCost: 100,
      faceValue: "10.00",
      currency: "BRL",
      effectiveFrom: "2026-01-01",
      effectiveUntil: null,
    },
    randomUUID(),
  );
  await changeRedemptionRule(
    db,
    f.principal,
    f.scope,
    rule.id,
    "publish",
    randomUUID(),
  );
  return rule;
}

test("fixed tiers preview, publish and disable with immutable published history", async () => {
  const f = await fixture();
  const app = createApp(
    db,
    () => undefined,
    async () => f.principal,
    undefined,
    undefined,
    vault,
  );
  try {
    const base = `/v1/brands/${f.brandId}/bots/${f.botId}`;
    const preview = await app.inject({
      method: "POST",
      url: base + "/redemption-rules/preview",
      payload: {
        platformId: f.platformId,
        tierKey: "brl_30",
        name: "BRL 30",
        pointsCost: 300,
        faceValue: "30.00",
        currency: "BRL",
        effectiveFrom: "2026-10-18",
        effectiveUntil: null,
      },
    });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.json().rule, {
      platformId: f.platformId,
      tierKey: "brl_30",
      name: "BRL 30",
      pointsCost: 300,
      faceValue: "30.00",
      currency: "BRL",
      effectiveFrom: "2026-10-18",
      effectiveUntil: null,
      mode: "fixed",
      dailyCountLimit: 1,
      dailyPointsLimit: 300,
      requiresDeposit: false,
      timezone: "UTC",
    });

    const rule = await publishedRule(f);
    assert.equal(
      (
        await one(
          db,
          "SELECT status,enabled,version,points_cost::text,face_value::text FROM redemption_rules WHERE id=$1",
          [rule.id],
        )
      ).status,
      "published",
    );
    await assert.rejects(
      () =>
        db.query("UPDATE redemption_rules SET points_cost=200 WHERE id=$1", [
          rule.id,
        ]),
      /redemption_rule_immutable/,
    );
    await changeRedemptionRule(
      db,
      f.principal,
      f.scope,
      rule.id,
      "disable",
      randomUUID(),
    );
    assert.deepEqual(
      await one(db, "SELECT status,enabled FROM redemption_rules WHERE id=$1", [
        rule.id,
      ]),
      { status: "disabled", enabled: false },
    );
    assert.equal(
      (
        await one(
          db,
          `SELECT count(*)::int n FROM audit_logs
   WHERE object_id=$1 AND action IN (
    'redemption.rule.create','redemption.rule.publish','redemption.rule.disable'
   )`,
          [rule.id],
        )
      ).n,
      3,
    );
  } finally {
    await app.close();
  }
});

test("encrypted batch import reports inventory status without exposing codes", async () => {
  const f = await fixture(),
    rule = await publishedRule(f);
  const plainA = "PRIVATE-CODE-A",
    plainB = "PRIVATE-CODE-B";
  const result = await importCodeBatch(
    db,
    vault,
    f.principal,
    f.scope,
    {
      ruleId: rule.id,
      codes: [
        {
          code: plainA,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
        {
          code: plainB,
          expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
        },
      ],
    },
    randomUUID(),
  );
  assert.equal(result.status, "imported");
  assert.equal(result.imported_count, 2);
  const stored = (
    await db.query(
      `SELECT id,code_secret_ref,code_ciphertext,
  code_fingerprint,expires_at FROM redemption_codes WHERE batch_id=$1
  ORDER BY expires_at DESC`,
      [result.id],
    )
  ).rows;
  assert.equal(stored.length, 2);
  assert.ok(!JSON.stringify(stored).includes(plainA));
  assert.ok(!JSON.stringify(stored).includes(plainB));

  const audit = await one(
    db,
    "SELECT after_data::text data FROM audit_logs WHERE object_id=$1 AND action='redemption.inventory.import'",
    [result.id],
  );
  assert.ok(!audit.data.includes(plainA));
  assert.ok(!audit.data.includes(plainB));

  const app = createApp(
    db,
    () => undefined,
    async () => f.principal,
    undefined,
    undefined,
    vault,
  );
  try {
    const base = `/v1/brands/${f.brandId}/bots/${f.botId}`;
    const response = await app.inject({ url: base + "/redemption-inventory" });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(!response.body.includes(plainA));
    const batches = await app.inject({
      url: base + "/redemption-code-batches",
    });
    assert.equal(batches.statusCode, 200, batches.body);
    assert.ok(!batches.body.includes(plainA));
    assert.deepEqual(
      {
        status: batches.json().items[0].status,
        total: batches.json().items[0].total_count,
        imported: batches.json().items[0].imported_count,
        duplicates: batches.json().items[0].duplicate_count,
      },
      { status: "imported", total: 2, imported: 2, duplicates: 0 },
    );
    const item = response.json().items[0];
    assert.deepEqual(
      {
        total: item.total,
        available: item.available,
        expired: item.expired,
        disabled: item.disabled,
      },
      { total: 2, available: 1, expired: 1, disabled: 0 },
    );

    const active = stored.find(
      (row) => new Date(row.expires_at).getTime() > Date.now(),
    )!;
    const disabled = await app.inject({
      method: "POST",
      url: base + `/redemption-codes/${active.id}/disable`,
      payload: {},
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    const updated = (
      await app.inject({ url: base + "/redemption-inventory" })
    ).json().items[0];
    assert.deepEqual(
      {
        available: updated.available,
        expired: updated.expired,
        disabled: updated.disabled,
      },
      { available: 0, expired: 1, disabled: 1 },
    );
  } finally {
    await app.close();
  }
});

test("same-platform duplicates reject the whole batch and replay is idempotent", async () => {
  const f = await fixture(),
    rule = await publishedRule(f);
  const first = await importCodeBatch(
    db,
    vault,
    f.principal,
    f.scope,
    {
      ruleId: rule.id,
      codes: [{ code: "DUP-A", expiresAt: null }],
    },
    randomUUID(),
  );
  const replay = await importCodeBatch(
    db,
    vault,
    f.principal,
    f.scope,
    {
      ruleId: rule.id,
      codes: [{ code: "DUP-A", expiresAt: null }],
    },
    randomUUID(),
  );
  assert.equal(replay.id, first.id);

  const mixed = await importCodeBatch(
    db,
    vault,
    f.principal,
    f.scope,
    {
      ruleId: rule.id,
      codes: [
        { code: "DUP-A", expiresAt: null },
        { code: "UNIQUE-BUT-REJECTED", expiresAt: null },
      ],
    },
    randomUUID(),
  );
  assert.deepEqual(
    {
      status: mixed.status,
      imported: mixed.imported_count,
      duplicates: mixed.duplicate_count,
    },
    { status: "rejected", imported: 0, duplicates: 1 },
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int n FROM redemption_codes WHERE brand_id=$1 AND platform_id=$2",
        [f.brandId, f.platformId],
      )
    ).n,
    1,
  );

  const within = await importCodeBatch(
    db,
    vault,
    f.principal,
    f.scope,
    {
      ruleId: rule.id,
      codes: [
        { code: "WITHIN-DUP", expiresAt: null },
        { code: "WITHIN-DUP", expiresAt: null },
      ],
    },
    randomUUID(),
  );
  assert.deepEqual(
    {
      status: within.status,
      imported: within.imported_count,
      duplicates: within.duplicate_count,
    },
    { status: "rejected", imported: 0, duplicates: 2 },
  );
});

test("the same code may exist on another platform but never leaks across scope", async () => {
  const f = await fixture(),
    rule = await publishedRule(f);
  await importCodeBatch(
    db,
    vault,
    f.principal,
    f.scope,
    {
      ruleId: rule.id,
      codes: [{ code: "PLATFORM-LOCAL", expiresAt: null }],
    },
    randomUUID(),
  );
  const other = await one(
    db,
    `INSERT INTO platforms(
  brand_id,code,display_name,market,timezone,currency,verification_method
 ) VALUES($1,$2,'Other','BR','UTC','BRL','manual_admin') RETURNING id`,
    [
      f.brandId,
      `OTHER_${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    ],
  );
  const second = await createRedemptionRule(
    db,
    f.principal,
    f.scope,
    {
      platformId: other.id,
      tierKey: "brl_10",
      name: "Other tier",
      pointsCost: 100,
      faceValue: "10",
      currency: "BRL",
      effectiveFrom: "2026-01-01",
      effectiveUntil: null,
    },
    randomUUID(),
  );
  await changeRedemptionRule(
    db,
    f.principal,
    f.scope,
    second.id,
    "publish",
    randomUUID(),
  );
  const imported = await importCodeBatch(
    db,
    vault,
    f.principal,
    f.scope,
    {
      ruleId: second.id,
      codes: [{ code: "PLATFORM-LOCAL", expiresAt: null }],
    },
    randomUUID(),
  );
  assert.equal(imported.status, "imported");
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int n FROM redemption_codes WHERE brand_id=$1 AND code_key_version='test-v1'",
        [f.brandId],
      )
    ).n,
    2,
  );
});

test("inventory operator is modular, bot-scoped and cannot manage rules", async () => {
  const f = await fixture(),
    rule = await publishedRule(f);
  const operator = await one(
    db,
    "INSERT INTO admins(auth_subject,display_name) VALUES($1,'Inventory operator') RETURNING id",
    [randomUUID()],
  );
  await db.query(
    `INSERT INTO admin_roles(admin_id,role_id,brand_id,bot_id)
  SELECT $1,id,$2,$3 FROM roles WHERE name='Redemption Inventory Operator'`,
    [operator.id, f.brandId, f.botId],
  );
  const secondBot = await one(
    db,
    `INSERT INTO telegram_bots(
  brand_id,name,username,token_secret_ref,webhook_secret_ref,
  default_language,supported_languages,status
 ) VALUES($1,'Other Bot',$2,$3,$4,'en',ARRAY['en'],'active') RETURNING id`,
    [f.brandId, randomUUID(), randomUUID(), randomUUID()],
  );
  const app = createApp(
    db,
    () => undefined,
    async () => ({ adminId: operator.id }),
    undefined,
    undefined,
    vault,
  );
  try {
    const base = `/v1/brands/${f.brandId}/bots/${f.botId}`;
    const invalid = await app.inject({
      method: "POST",
      url: base + "/redemption-code-batches",
      payload: {
        ruleId: rule.id,
        codes: [{ code: "BAD CODE", expiresAt: null }],
      },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.equal(
      (
        await one(
          db,
          "SELECT count(*)::int n FROM redemption_code_batches WHERE bot_id=$1",
          [f.botId],
        )
      ).n,
      0,
    );
    const imported = await app.inject({
      method: "POST",
      url: base + "/redemption-code-batches",
      payload: {
        ruleId: rule.id,
        codes: [{ code: "OPERATOR-CODE", expiresAt: null }],
      },
    });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal(
      (await app.inject({ url: base + "/redemption-inventory" })).statusCode,
      200,
    );

    const create = await app.inject({
      method: "POST",
      url: base + "/redemption-rules",
      payload: {
        platformId: f.platformId,
        tierKey: "forbidden",
        name: "Forbidden",
        pointsCost: 10,
        faceValue: "1",
        currency: "BRL",
        effectiveFrom: "2026-01-01",
        effectiveUntil: null,
      },
    });
    assert.equal(create.statusCode, 403, create.body);
    assert.equal(
      (
        await app.inject({
          url: `/v1/brands/${f.brandId}/bots/${secondBot.id}/redemption-inventory`,
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});

test("vault configuration and authenticated encryption reject tampering", () => {
  assert.equal(createRedemptionCodeVault({}), undefined);
  assert.throws(() =>
    createRedemptionCodeVault({ REDEMPTION_CODE_KEY_VERSION: "v1" }),
  );
  assert.throws(() =>
    createRedemptionCodeVault({
      REDEMPTION_CODE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      REDEMPTION_CODE_KEY_VERSION: "v1",
    }),
  );
  const encrypted = vault.encrypt(
    "INTEGRITY-CODE",
    "00000000-0000-0000-0000-000000000001",
  );
  assert.equal(
    vault.decrypt(
      {
        code_ciphertext: encrypted.ciphertext,
        code_iv: encrypted.iv,
        code_auth_tag: encrypted.authTag,
        code_key_version: encrypted.keyVersion,
        code_fingerprint: encrypted.fingerprint,
      },
      "00000000-0000-0000-0000-000000000001",
    ),
    "INTEGRITY-CODE",
  );
  assert.throws(() =>
    vault.decrypt(
      {
        code_ciphertext: encrypted.ciphertext,
        code_iv: encrypted.iv,
        code_auth_tag: encrypted.authTag,
        code_key_version: encrypted.keyVersion,
        code_fingerprint: "0".repeat(64),
      },
      "00000000-0000-0000-0000-000000000001",
    ),
  );
});

test("vault keyring decrypts old codes while new codes use the active key", () => {
  const oldKey = randomBytes(32).toString("base64");
  const newKey = randomBytes(32).toString("base64");
  const fingerprintKey = randomBytes(32).toString("base64");
  const platformId = "00000000-0000-0000-0000-000000000002";
  const env = (active: string, keys: Record<string, string>) => ({
    REDEMPTION_CODE_ENCRYPTION_KEYS: JSON.stringify(keys),
    REDEMPTION_CODE_ACTIVE_KEY_VERSION: active,
    REDEMPTION_CODE_FINGERPRINT_KEY: fingerprintKey,
  });
  const first = createRedemptionCodeVault(env("v1", { v1: oldKey }))!;
  const old = first.encrypt("OLD-ROTATION-CODE", platformId);
  const rotated = createRedemptionCodeVault(
    env("v2", { v1: oldKey, v2: newKey }),
  )!;
  assert.equal(
    rotated.decrypt(
      {
        code_ciphertext: old.ciphertext,
        code_iv: old.iv,
        code_auth_tag: old.authTag,
        code_key_version: old.keyVersion,
        code_fingerprint: old.fingerprint,
      },
      platformId,
    ),
    "OLD-ROTATION-CODE",
  );
  const current = rotated.encrypt("NEW-ROTATION-CODE", platformId);
  assert.equal(current.keyVersion, "v2");
  assert.equal(
    rotated.decrypt(
      {
        code_ciphertext: current.ciphertext,
        code_iv: current.iv,
        code_auth_tag: current.authTag,
        code_key_version: current.keyVersion,
        code_fingerprint: current.fingerprint,
      },
      platformId,
    ),
    "NEW-ROTATION-CODE",
  );
  assert.equal(
    rotated.fingerprint("OLD-ROTATION-CODE", platformId),
    old.fingerprint,
  );
  const retired = createRedemptionCodeVault(env("v2", { v2: newKey }))!;
  assert.throws(
    () =>
      retired.decrypt(
        {
          code_ciphertext: old.ciphertext,
          code_iv: old.iv,
          code_auth_tag: old.authTag,
          code_key_version: old.keyVersion,
          code_fingerprint: old.fingerprint,
        },
        platformId,
      ),
    /redemption_code_key_unavailable/,
  );
});

test("vault rejects ambiguous or incomplete keyring configuration", () => {
  const encryption = randomBytes(32).toString("base64");
  const fingerprint = randomBytes(32).toString("base64");
  assert.throws(
    () =>
      createRedemptionCodeVault({
        REDEMPTION_CODE_ENCRYPTION_KEYS: "not-json",
        REDEMPTION_CODE_ACTIVE_KEY_VERSION: "v2",
        REDEMPTION_CODE_FINGERPRINT_KEY: fingerprint,
      }),
    /Invalid REDEMPTION_CODE_ENCRYPTION_KEYS/,
  );
  assert.throws(
    () =>
      createRedemptionCodeVault({
        REDEMPTION_CODE_ENCRYPTION_KEYS: JSON.stringify({ v1: encryption }),
        REDEMPTION_CODE_ACTIVE_KEY_VERSION: "v2",
        REDEMPTION_CODE_FINGERPRINT_KEY: fingerprint,
      }),
    /Active redemption code encryption key unavailable/,
  );
  assert.throws(
    () =>
      createRedemptionCodeVault({
        REDEMPTION_CODE_ENCRYPTION_KEYS: JSON.stringify({ v1: encryption }),
        REDEMPTION_CODE_ACTIVE_KEY_VERSION: "v1",
        REDEMPTION_CODE_ENCRYPTION_KEY: encryption,
        REDEMPTION_CODE_KEY_VERSION: "v1",
        REDEMPTION_CODE_FINGERPRINT_KEY: fingerprint,
      }),
    /cannot be mixed/,
  );
});

test("Batch 2B operations never create orders or modify Points, Lots, or Growth", async () => {
  const before = await one(
    db,
    `SELECT
  (SELECT count(*)::int FROM redemptions) redemptions,
  (SELECT count(*)::int FROM point_ledger) point_ledger,
  (SELECT count(*)::int FROM point_lots) point_lots,
  (SELECT count(*)::int FROM point_lot_allocations) allocations,
  (SELECT count(*)::int FROM growth_ledger) growth_ledger`,
  );
  const f = await fixture(),
    rule = await publishedRule(f);
  await importCodeBatch(
    db,
    vault,
    f.principal,
    f.scope,
    {
      ruleId: rule.id,
      codes: [{ code: "NO-SIDE-EFFECT", expiresAt: null }],
    },
    randomUUID(),
  );
  const after = await one(
    db,
    `SELECT
  (SELECT count(*)::int FROM redemptions) redemptions,
  (SELECT count(*)::int FROM point_ledger) point_ledger,
  (SELECT count(*)::int FROM point_lots) point_lots,
  (SELECT count(*)::int FROM point_lot_allocations) allocations,
  (SELECT count(*)::int FROM growth_ledger) growth_ledger`,
  );
  assert.deepEqual(after, before);
});
