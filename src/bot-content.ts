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
import type { MiniConfig } from "./mini-auth.js";

export const contentLanguages = [
  "zh-CN",
  "en",
  "pt-BR",
  "es-MX",
  "fil",
] as const;
const copy = z
  .string()
  .trim()
  .min(1)
  .max(700)
  .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s));
const label = copy.pipe(z.string().max(60));
const localeSchema = z
  .object({
    newUser: copy,
    returningUser: copy,
    openLabel: label,
    inviteLabel: label,
    supportLabel: label,
  })
  .strict();
export const botContentSchema = z
  .object({
    locales: z
      .object({
        "zh-CN": localeSchema,
        en: localeSchema,
        "pt-BR": localeSchema,
        "es-MX": localeSchema,
        fil: localeSchema,
      })
      .strict(),
    supportUrl: z
      .string()
      .regex(/^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{4,31}$/)
      .nullable(),
  })
  .strict();
export type BotContent = z.infer<typeof botContentSchema>;
export const defaultBotContent: BotContent = {
  locales: {
    "zh-CN": {
      newUser: "欢迎！打开奖励中心，绑定平台账号并查看可参与的活动。",
      returningUser: "欢迎回来！查看今日签到、邀请进度和可兑换奖励。",
      openLabel: "打开奖励中心",
      inviteLabel: "邀请好友",
      supportLabel: "联系客服",
    },
    en: {
      newUser:
        "Welcome! Open the Rewards Center to link your platform account and explore available activities.",
      returningUser:
        "Welcome back! Check today’s check-in, invite progress and available rewards.",
      openLabel: "Open Rewards Center",
      inviteLabel: "Invite friends",
      supportLabel: "Contact support",
    },
    "pt-BR": {
      newUser:
        "Boas-vindas! Abra a Central de Recompensas, vincule sua conta da plataforma e veja as atividades disponíveis.",
      returningUser:
        "Que bom ter você de volta! Veja o check-in de hoje, seus convites e as recompensas disponíveis.",
      openLabel: "Abrir Central de Recompensas",
      inviteLabel: "Convidar amigos",
      supportLabel: "Falar com o suporte",
    },
    "es-MX": {
      newUser:
        "¡Bienvenido! Abre el Centro de Recompensas, vincula tu cuenta de la plataforma y descubre las actividades disponibles.",
      returningUser:
        "¡Qué gusto verte de nuevo! Revisa tu registro diario, invitaciones y recompensas disponibles.",
      openLabel: "Abrir Centro de Recompensas",
      inviteLabel: "Invitar amigos",
      supportLabel: "Contactar a soporte",
    },
    fil: {
      newUser:
        "Maligayang pagdating! Buksan ang Rewards Center para i-link ang platform account mo at tingnan ang mga available na aktibidad.",
      returningUser:
        "Maligayang pagbabalik! Tingnan ang check-in ngayong araw, mga imbitasyon at available na reward.",
      openLabel: "Buksan ang Rewards Center",
      inviteLabel: "Mag-imbita ng kaibigan",
      supportLabel: "Makipag-ugnayan sa suporta",
    },
  },
  supportUrl: null,
};
const DRAFT = "OPS_BOT_CONTENT_DRAFT",
  PUBLISHED = "OPS_BOT_CONTENT_PUBLISHED";
export function botMiniUrl(config: MiniConfig | undefined, botId: string) {
  const matches = config?.bindings.filter((b) => b.botId === botId) ?? [];
  return matches.length === 1 ? `${matches[0]!.origin}/mini.html` : null;
}
function language(
  value: string | undefined | null,
): (typeof contentLanguages)[number] | undefined {
  const v = value?.toLowerCase();
  if (!v) return undefined;
  if (v === "zh" || v.startsWith("zh-")) return "zh-CN";
  if (v === "pt" || v.startsWith("pt-")) return "pt-BR";
  if (v === "es" || v.startsWith("es-")) return "es-MX";
  if (v === "fil" || v.startsWith("fil-") || v === "tl") return "fil";
  if (v === "en" || v.startsWith("en-")) return "en";
  return undefined;
}
function parseStored(body: string): BotContent {
  try {
    return botContentSchema.parse(JSON.parse(body));
  } catch {
    throw new DomainError("bot_content_invalid", 409);
  }
}
export async function botContentState(
  tx: Queryable,
  s: Scope,
  config?: MiniConfig,
) {
  const rows = (
    await tx.query(
      "SELECT template_key,body,version,enabled FROM message_templates WHERE brand_id=$1 AND bot_id=$2 AND language=$3 AND template_key IN ($4,$5)",
      [...scopeParams(s), "en", DRAFT, PUBLISHED],
    )
  ).rows;
  const draft = rows.find((r) => r.template_key === DRAFT),
    published = rows.find((r) => r.template_key === PUBLISHED);
  return {
    draft: draft ? parseStored(draft.body) : structuredClone(defaultBotContent),
    draftVersion: draft?.version ?? 0,
    published: published ? parseStored(published.body) : null,
    publishedVersion: published?.version ?? 0,
    enabled: published?.enabled ?? false,
    miniUrl: botMiniUrl(config, s.botId),
  };
}
export function previewBotContent(
  config: BotContent,
  locale: (typeof contentLanguages)[number],
  audience: "new" | "returning",
  miniUrl: string | null,
) {
  const c = config.locales[locale];
  const buttons: Array<{
    text: string;
    url?: string;
    web_app?: { url: string };
  }> = [];
  if (miniUrl) {
    buttons.push(
      { text: c.openLabel, web_app: { url: miniUrl } },
      { text: c.inviteLabel, web_app: { url: `${miniUrl}?view=invite` } },
    );
  }
  if (config.supportUrl)
    buttons.push({ text: c.supportLabel, url: config.supportUrl });
  return {
    text: audience === "new" ? c.newUser : c.returningUser,
    buttons,
    deliveryConfirmed: false as const,
  };
}
async function writable(tx: Queryable) {
  const r = await one(
    tx,
    `SELECT has_column_privilege(current_user,'message_templates','brand_id','INSERT') AND has_column_privilege(current_user,'message_templates','bot_id','INSERT') AND has_column_privilege(current_user,'message_templates','template_key','INSERT') AND has_column_privilege(current_user,'message_templates','language','INSERT') AND has_column_privilege(current_user,'message_templates','body','INSERT') AND has_column_privilege(current_user,'message_templates','enabled','INSERT') AND has_column_privilege(current_user,'message_templates','version','INSERT') AS ins,
 has_column_privilege(current_user,'message_templates','body','UPDATE') AND has_column_privilege(current_user,'message_templates','version','UPDATE') AND has_column_privilege(current_user,'message_templates','enabled','UPDATE') AND has_column_privilege(current_user,'message_templates','updated_at','UPDATE') AS upd`,
  );
  if (!r.ins || !r.upd)
    throw new DomainError("bot_content_storage_unavailable", 503);
}
export function attachBotContent(
  app: FastifyInstance,
  db: Database,
  auth: (req: FastifyRequest) => Promise<Principal>,
  config?: MiniConfig,
) {
  const path = "/v1/brands/:brandId/bots/:botId/operations/content";
  const scope = z.object({ brandId: z.uuid(), botId: z.uuid() });
  const version = z.number().int().nonnegative().max(2147483646);
  app.get(path, async (req) => {
    const s = scope.parse(req.params),
      p = await auth(req);
    return db.transaction(async (tx) => {
      await authorize(tx, p, s, "messages.publish");
      return botContentState(tx, s, config);
    });
  });
  app.post(`${path}/preview`, async (req) => {
    const s = scope.parse(req.params),
      p = await auth(req),
      body = z
        .object({
          config: botContentSchema,
          language: z.enum(contentLanguages),
          audience: z.enum(["new", "returning"]),
        })
        .strict()
        .parse(req.body);
    await authorize(db, p, s, "messages.publish");
    return previewBotContent(
      body.config,
      body.language,
      body.audience,
      botMiniUrl(config, s.botId),
    );
  });
  for (const action of ["draft", "publish", "disable"] as const)
    app.post(`${path}/${action}`, async (req) => {
      const s = scope.parse(req.params),
        p = await auth(req);
      const body =
        action === "draft"
          ? z
              .object({ config: botContentSchema, expectedVersion: version })
              .strict()
              .parse(req.body)
          : z.object({ expectedVersion: version }).strict().parse(req.body);
      return db.transaction(async (tx) => {
        await authorize(tx, p, s, "messages.publish");
        await one(
          tx,
          "SELECT id FROM telegram_bots WHERE brand_id=$1 AND id=$2 FOR UPDATE",
          scopeParams(s),
        );
        await writable(tx);
        const before = await botContentState(tx, s, config);
        if (
          body.expectedVersion !==
          (action === "disable" ? before.publishedVersion : before.draftVersion)
        )
          throw new DomainError("bot_content_version_conflict", 409);
        if (action === "publish" && (!before.miniUrl || !before.draftVersion))
          throw new DomainError(
            !before.miniUrl
              ? "bot_content_mini_unavailable"
              : "bot_content_draft_required",
            409,
          );
        if (action === "disable" && !before.published)
          throw new DomainError("bot_content_not_published", 409);
        const key = action === "draft" ? DRAFT : PUBLISHED,
          next =
            action === "draft"
              ? botContentSchema.parse(
                  "config" in body ? body.config : undefined,
                )
              : action === "publish"
                ? before.draft
                : before.published!;
        const nextVersion =
          (action === "draft" ? before.draftVersion : before.publishedVersion) +
          1;
        await tx.query(
          `INSERT INTO message_templates(brand_id,bot_id,template_key,language,body,enabled,version) VALUES($1,$2,$3,'en',$4,$5,$6)
    ON CONFLICT(bot_id,template_key,language) DO UPDATE SET body=EXCLUDED.body,enabled=EXCLUDED.enabled,version=EXCLUDED.version,updated_at=now()`,
          [
            ...scopeParams(s),
            key,
            JSON.stringify(next),
            action === "publish",
            nextVersion,
          ],
        );
        // Content may contain operator-entered personal data: audit only versions and state.
        await tx.query(
          `INSERT INTO audit_logs(admin_id,brand_id,bot_id,action,object_type,object_id,before_data,after_data,request_id) VALUES($1,$2,$3,$4,'bot_content',$8,$5,$6,$7)`,
          [
            p.adminId,
            ...scopeParams(s),
            `bot.content.${action}`,
            JSON.stringify({
              version:
                action === "draft"
                  ? before.draftVersion
                  : before.publishedVersion,
              enabled: before.enabled,
            }),
            JSON.stringify({
              version: nextVersion,
              enabled: action === "publish",
            }),
            req.id,
            s.botId,
          ],
        );
        return botContentState(tx, s, config);
      });
    });
}
// A webhook response can ask Telegram to send one message, but is not delivery confirmation.
// Missing read privileges fail closed before a SELECT, without aborting referral processing.
export async function botCommandReply(
  tx: Queryable,
  s: Scope,
  input: {
    chatId: number;
    text: string;
    username: string;
    preferredLanguage?: string | null;
    telegramLanguage?: string | null;
    botLanguage: string;
    isNew: boolean;
  },
  config?: MiniConfig,
) {
  const miniUrl = botMiniUrl(config, s.botId);
  if (!miniUrl) return undefined;
  const cmd = input.text.match(
    /^\/(start|invite|help)(?:@([A-Za-z0-9_]+))?(?:\s+[A-Za-z0-9_-]{1,64})?\s*$/,
  );
  if (!cmd || (cmd[2] && cmd[2].toLowerCase() !== input.username.toLowerCase()))
    return undefined;
  if (
    !(
      await one(
        tx,
        "SELECT has_table_privilege(current_user,'message_templates','SELECT') AS readable",
      )
    ).readable
  )
    return undefined;
  const published = (
    await tx.query(
      "SELECT body FROM message_templates WHERE brand_id=$1 AND bot_id=$2 AND template_key=$3 AND language=$4 AND enabled",
      [...scopeParams(s), PUBLISHED, "en"],
    )
  ).rows[0];
  if (!published) return undefined;
  let content: BotContent;
  try {
    content = parseStored(published.body);
  } catch (e) {
    if (e instanceof DomainError && e.code === "bot_content_invalid")
      return undefined;
    throw e;
  }
  const locale =
      language(input.preferredLanguage) ??
      language(input.telegramLanguage) ??
      language(input.botLanguage) ??
      "en",
    c = content.locales[locale];
  const preview = previewBotContent(
    content,
    locale,
    input.isNew ? "new" : "returning",
    miniUrl,
  );
  if (cmd[1] === "invite") {
    preview.text = c.inviteLabel;
    preview.buttons = preview.buttons.filter((b) =>
      b.web_app?.url.endsWith("?view=invite"),
    );
  }
  if (cmd[1] === "help") {
    if (!content.supportUrl) return undefined;
    preview.text = c.supportLabel;
    preview.buttons = preview.buttons.filter((b) => !!b.url);
  }
  return {
    method: "sendMessage" as const,
    chat_id: input.chatId,
    text: preview.text,
    reply_markup: { inline_keyboard: preview.buttons.map((b) => [b]) },
  };
}
