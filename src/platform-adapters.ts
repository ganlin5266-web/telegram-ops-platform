import { DomainError } from "./db.js";
import {
  decimal,
  fields,
  moneyFields,
  normalizeRow,
  stable,
  digest,
  type Issue,
} from "./platform-data-input.js";

type Field = {
  source: string;
  target?: string;
  extension?: string;
  type: "money" | "id" | "count" | "text" | "date" | "datetime";
  required?: boolean;
  divisor?: string;
  format?: "ymd" | "dmy" | "mdy" | "local" | "iso" | "excel_serial";
  sentinel?: string;
  semantics: string;
  review?: boolean;
};
export type Adapter = {
  id: string;
  version: string;
  schema: string;
  defaultMoneyDivisor: string;
  fields: Field[];
  rawOnly: string[];
};
const f = (
  source: string,
  target: string,
  type: Field["type"],
  extra: Partial<Field> = {},
): Field => ({
  source,
  target,
  type,
  semantics: `source_reported_${target}`,
  ...extra,
});
const ext = (
  source: string,
  extension: string,
  type: Field["type"],
  extra: Partial<Field> = {},
): Field => ({
  source,
  extension,
  type,
  semantics: `source_reported_${extension}`,
  ...extra,
});
// Source labels, never customer rows. New versions are additive; old snapshots stay immutable in batches.
const reports: Adapter[] = [
  {
    id: "player-report-minor-units",
    version: "1",
    schema: "player-report-zh-47-v1",
    defaultMoneyDivisor: "100",
    fields: [
      f("玩家id ", "uid", "id", { required: true }),
      f("注册时间", "registered_at", "datetime", { format: "local" }),
      f("最后登陆时间", "login_time", "datetime", { format: "local" }),
      f("渠道名称", "channel", "text"),
      f("总代名称", "agent", "text"),
      f("当日充值", "deposit", "money"),
      f("当日赠送", "gift", "money"),
      f("当日提现", "withdrawal", "money"),
      f("当日充提差", "source_net", "money"),
      f("当日充值次数", "deposit_count", "count"),
      f("玩家首充日期", "first_deposit_date", "date", {
        format: "local",
        sentinel: "1900-01-01 00:00:00",
      }),
      f("玩家首充金額", "first_deposit", "money"),
      ...[
        ["实时账号余额", "account_balance"],
        ["当日投注", "reported_daily_bet"],
        ["当日返奖", "reported_daily_payout"],
        ["当日盈亏", "reported_daily_profit"],
        ["当日体验金投注", "trial_daily_bet"],
        ["当日体验金返奖", "trial_daily_payout"],
        ["当日体验金盈亏", "trial_daily_profit"],
        ["历史充值", "historical_deposit"],
        ["历史赠送", "historical_gift"],
        ["历史提现", "historical_withdrawal"],
        ["历史充提差", "historical_net"],
        ["历史总投注", "historical_bet"],
        ["历史总返奖", "historical_payout"],
        ["历史体验金投注", "historical_trial_bet"],
        ["历史体验金返奖", "historical_trial_payout"],
        ["历史盈亏", "historical_profit"],
        ["历史体验金盈亏", "historical_trial_profit"],
        ["最近存款金額(最后转入金额)", "last_transfer_amount"],
      ].map(([s, k]) => ext(s!, k!, "money", { review: true })),
      ext("最近存款時間", "last_deposit_at", "datetime", {
        format: "local",
        review: true,
      }),
      ext("最近下注時間", "last_bet_at", "datetime", {
        format: "local",
        review: true,
      }),
      ext("近两个月充值天数", "recent_deposit_days", "count"),
      ext("近两个月提款天数", "recent_withdrawal_days", "count"),
    ],
    rawOnly: [
      "平台",
      "游戏id ",
      "日期 ",
      "注册IP",
      "上级id",
      "都是会员,用户类型0正常1测试",
      "状态:0正常",
      "渠道号",
      "总代号",
      "用户邮箱",
      "最后登陆ip",
      "最后登录设备",
      "最后登录设备码UUID",
    ],
  },
  {
    id: "synthetic-mx",
    version: "1",
    schema: "synthetic-mx-v1",
    defaultMoneyDivisor: "1",
    fields: [
      f("Player", "uid", "id", { required: true }),
      f("Deposit MXN", "deposit", "money"),
      f("Bet Reported", "bet", "money", {
        semantics: "synthetic_declared_bet",
      }),
      f("Joined", "registered_at", "datetime", { format: "dmy" }),
      f("First date", "first_deposit_date", "date", { format: "dmy" }),
      f("First amount", "first_deposit", "money"),
    ],
    rawOnly: [],
  },
];
export function adapterDefinition(id: string, version: string): Adapter {
  const a = reports.find((a) => a.id === id && a.version === version);
  if (!a) throw new DomainError("unsupported_mapping_version", 400);
  return structuredClone(a);
}
export const adapterOptions = () =>
  reports.map((a) => ({ id: a.id, version: a.version, schema: a.schema }));
export function scaleMoney(raw: string, divisor: string): string | null {
  const text = raw.trim();
  if (text === "") return null;
  if (!/^-?\d{1,28}(?:\.\d{1,12})?$/.test(text))
    throw new DomainError("amount_format_invalid", 400);
  if (!/^(1|10|100|1000|10000|100000|1000000)$/.test(divisor))
    throw new DomainError("money_divisor_invalid", 400);
  const [whole, frac = ""] = text.replace(/^-/, "").split(".");
  const numerator =
      BigInt(whole! + frac) * 1000000n * (text.startsWith("-") ? -1n : 1n),
    denominator = 10n ** BigInt(frac.length) * BigInt(divisor);
  if (numerator % denominator !== 0n)
    throw new DomainError("money_precision_loss", 400);
  const x = numerator / denominator,
    abs = x < 0n ? -x : x;
  return decimal(
    `${x < 0n ? "-" : ""}${abs / 1000000n}.${(abs % 1000000n).toString().padStart(6, "0")}`,
  );
}
function parts(s: string, format: Field["format"]) {
  let p: number[];
  if (format === "excel_serial") {
    if (!/^\d+(?:\.\d+)?$/.test(s)) throw Error();
    const [w, f = ""] = s.split(".");
    const denominator = 10n ** BigInt(f.length);
    const ticks = (BigInt(w!) * denominator + BigInt(f || "0")) * 86400000n;
    if (ticks % denominator !== 0n || BigInt(w!) === 60n || BigInt(w!) > 73415n)
      throw Error();
    const d = new Date(
      Date.UTC(1899, 11, 30) +
        Number(ticks / denominator) +
        (BigInt(w!) < 60n ? 86400000 : 0),
    );
    p = [
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
    ];
  } else {
    const m =
      format === "dmy" || format === "mdy"
        ? /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(s)
        : /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(s);
    if (!m) throw Error();
    p =
      format === "dmy"
        ? [+m[3]!, +m[2]!, +m[1]!]
        : format === "mdy"
          ? [+m[3]!, +m[1]!, +m[2]!]
          : [+m[1]!, +m[2]!, +m[3]!];
    p.push(+(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }
  const [y, m, d, h, mi, se] = p as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const t = new Date(Date.UTC(y, m - 1, d, h, mi, se));
  if (
    y < 1900 ||
    y > 2100 ||
    t.getUTCFullYear() !== y ||
    t.getUTCMonth() + 1 !== m ||
    t.getUTCDate() !== d ||
    h > 23 ||
    mi > 59 ||
    se > 59
  )
    throw Error();
  return p;
}
export function parseAdapterDate(
  s: string,
  format: Field["format"],
  timezone: string,
  dateOnly = false,
): string {
  if (format === "iso") {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(s))
      throw Error();
    parts(s.slice(0, 19).replace("T", " "), "local");
    const d = new Date(s);
    return dateOnly ? d.toISOString().slice(0, 10) : d.toISOString();
  }
  const p = parts(s, format);
  const [y, m, d, h, mi, se] = p as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (dateOnly)
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const wall = Date.UTC(y, m - 1, d, h, mi, se);
  const candidates: number[] = [];
  // Enumerate IANA offsets in 15-minute increments; ambiguous/nonexistent wall times fail closed.
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const t = wall - offset * 60000;
    const out = Object.fromEntries(
      fmt.formatToParts(t).map((x) => [x.type, x.value]),
    );
    if (
      Number(out.year) === y &&
      Number(out.month) === m &&
      Number(out.day) === d &&
      Number(out.hour) === h &&
      Number(out.minute) === mi &&
      Number(out.second) === se
    )
      candidates.push(t);
  }
  if (candidates.length !== 1) throw Error();
  return new Date(candidates[0]!).toISOString();
}
export function mappingSnapshot(
  a: Adapter,
  headers: string[],
  platformId: string,
  sourceType: string,
  timezone: string,
  currency: string,
) {
  const known = [...a.fields.map((f) => f.source), ...a.rawOnly];
  if (
    headers.some((h) => !known.includes(h)) ||
    a.fields.some((f) => f.required && !headers.includes(f.source))
  )
    throw new DomainError("unsupported_schema", 400);
  const definition = { ...a };
  return {
    adapterId: a.id,
    mappingVersion: a.version,
    schemaIdentifier: a.schema,
    platformId,
    sourceType,
    timezone,
    currency,
    status: "active",
    definition,
    definitionDigest: digest(stable(definition)),
    schemaFingerprint: digest(stable([...headers].sort())),
    recognizedFields: headers,
    missingFields: known.filter((h) => !headers.includes(h)),
    unknownFields: [],
    fieldAvailability: Object.fromEntries(
      a.fields.map((f) => [
        f.target ?? f.extension,
        headers.includes(f.source),
      ]),
    ),
  };
}
export function normalizeAdapterRow(
  raw: Record<string, string>,
  a: Adapter,
  platform: Record<string, any>,
  row: number,
): { normalized: Record<string, any>; issues: Issue[] } {
  const transformed: Record<string, string> = {},
    extensions: Record<string, unknown> = {},
    issues: Issue[] = [];
  let sentinel = false;
  for (const field of a.fields) {
    const v = (raw[field.source] ?? "").trim();
    let value: string | null = v || null;
    try {
      if (v && field.sentinel === v) {
        value = null;
        if (field.target === "first_deposit_date") sentinel = true;
      } else if (field.type === "money")
        value = scaleMoney(v, field.divisor ?? a.defaultMoneyDivisor);
      else if (v && (field.type === "date" || field.type === "datetime")) {
        if (v === "1900-01-01 00:00:00" && !field.sentinel) {
          issues.push({
            severity: "warning",
            code: "unconfirmed_sentinel_semantics",
            field: field.extension ?? field.target,
            row,
          });
          value = null;
        } else
          value = parseAdapterDate(
            v,
            field.format,
            platform.timezone,
            field.type === "date",
          );
      } else if (v && field.type === "count") {
        if (!/^\d{1,12}$/.test(v)) throw Error();
        value = BigInt(v).toString();
      }
      if (field.required && !v) throw Error();
      if (field.target) transformed[field.target] = value ?? "";
      if (field.extension)
        extensions[field.extension] = {
          type: field.type,
          value,
          semantics: field.semantics,
          semanticStatus: field.review ? "unconfirmed" : "source_reported",
        };
      if (field.review && v)
        issues.push({
          severity: "warning",
          code: "source_semantics_unconfirmed",
          field: field.extension,
          row,
        });
    } catch {
      issues.push({
        severity: "fatal",
        code: "adapter_value_invalid",
        field: field.target ?? field.extension,
        row,
      });
    }
  }
  const n = normalizeRow(
    transformed,
    Object.fromEntries(fields.map((f) => [f, f])),
    platform,
    row,
  );
  // Cross-validation is derived. It never awards eligibility or rewards.
  const amount = n.normalized.first_deposit,
    date = n.normalized.first_deposit_date;
  let has: boolean | null = null;
  if (sentinel && amount === "0.000000") has = false;
  else if (
    !sentinel &&
    date &&
    amount !== null &&
    amount !== undefined &&
    BigInt(amount.replace(".", "")) > 0n
  )
    has = true;
  else if (sentinel || date)
    issues.push({
      severity: "warning",
      code: "first_deposit_inconsistent",
      row,
    });
  return {
    normalized: {
      ...n.normalized,
      _adapter: {
        id: a.id,
        version: a.version,
        definitionDigest: digest(stable(a)),
      },
      extensions,
      derived: { has_first_deposit: has },
    },
    issues: [...n.issues, ...issues],
  };
}
