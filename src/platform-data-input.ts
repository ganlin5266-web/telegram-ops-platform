import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { z } from "zod";
import { DomainError } from "./db.js";
import { canonicalUid } from "./platform-identities.js";
export const moneyFields = [
  "deposit",
  "gift",
  "withdrawal",
  "source_net",
  "bet",
  "payout",
  "game_profit",
  "first_deposit",
] as const;
export const fields = [
  "uid",
  "tier",
  "login_account",
  "registered_at",
  "login_time",
  "channel",
  "agent",
  ...moneyFields,
  "deposit_count",
  "first_deposit_date",
] as const;
export const digest = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
export function stable(v: any): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x).sort(([a], [b]) => a.localeCompare(b)),
        )
      : x,
  );
}
export function businessDate(s: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number(s.slice(0, 4)) >= 2000 &&
    Number(s.slice(0, 4)) <= 2100 &&
    !Number.isNaN(Date.parse(s + "T00:00:00Z")) &&
    new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s
  );
}
export const importInput = z
  .object({
    platformId: z.uuid(),
    businessDate: z.string().refine(businessDate),
    timezone: z.string().min(1).max(100),
    currency: z.string().regex(/^[A-Z]{3}$/),
    sourceType: z.enum(["csv", "xlsx"]),
    filename: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[^/\\\x00-\x1f]+$/),
    fileBase64: z.string().min(1).max(2800000),
    adapter: z
      .object({
        id: z.string().min(1).max(80),
        version: z.string().min(1).max(30),
      })
      .strict()
      .optional(),
    mapping: z.partialRecord(z.enum(fields), z.string().min(1).max(100)),
    coverage: z
      .object({
        kind: z.enum(["full", "filtered"]),
        filter: z.string().max(300),
      })
      .strict(),
    completeness: z
      .enum(["complete", "incomplete", "unknown"])
      .default("unknown"),
    replacement: z.boolean().default(false),
    reason: z.string().min(1).max(160),
  })
  .strict()
  .refine((v) => v.coverage.kind !== "full" || v.coverage.filter === "");
export type ImportInput = z.infer<typeof importInput>;
export type Issue = {
  severity: "fatal" | "warning" | "info";
  code: string;
  field?: string;
  row?: number;
};
export function decimal(raw: string): string | null {
  if (raw.trim() === "") return null;
  const s = raw.trim();
  if (!/^-?\d{1,22}(?:\.\d{1,6})?$/.test(s))
    throw new DomainError("amount_format_invalid", 400);
  const neg = s.startsWith("-"),
    [whole, frac = ""] = s.replace(/^-/, "").split(".");
  const value = BigInt(whole!) * 1000000n + BigInt(frac.padEnd(6, "0"));
  return `${neg && value !== 0n ? "-" : ""}${value / 1000000n}.${(value % 1000000n).toString().padStart(6, "0")}`;
}
const units = (s: string) => BigInt(s.replace(".", ""));
function csv(text: string): string[][] {
  const rows: string[][] = [],
    row: string[] = [];
  let cell = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += c;
    } else if (c === '"') {
      if (cell || closed) throw new DomainError("csv_structure_invalid", 400);
      quoted = true;
    } else if (c === "," || c === "\n" || c === "\r") {
      row.push(cell);
      cell = "";
      closed = false;
      if (c !== ",") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        rows.push(row.splice(0));
      }
    } else {
      if (closed) throw new DomainError("csv_structure_invalid", 400);
      cell += c;
    }
    if (cell.length > 2000 || row.length > 64 || rows.length > 1001)
      throw new DomainError("file_limits_exceeded", 400);
  }
  if (quoted) throw new DomainError("csv_structure_invalid", 400);
  if (cell || row.length || closed) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
function guardZip(b: Buffer) {
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--)
    if (b.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new DomainError("xlsx_structure_invalid", 400);
  const n = b.readUInt16LE(end + 10),
    offset = b.readUInt32LE(end + 16);
  let pos = offset,
    total = 0;
  if (n > 200 || n === 65535 || offset >= b.length)
    throw new DomainError("file_limits_exceeded", 400);
  for (let i = 0; i < n; i++) {
    if (pos + 46 > b.length || b.readUInt32LE(pos) !== 0x02014b50)
      throw new DomainError("xlsx_structure_invalid", 400);
    total += b.readUInt32LE(pos + 24);
    const len = b.readUInt16LE(pos + 28),
      extra = b.readUInt16LE(pos + 30),
      comment = b.readUInt16LE(pos + 32),
      name = b.subarray(pos + 46, pos + 46 + len).toString();
    if (
      total > 16000000 ||
      b.readUInt16LE(pos + 8) & 1 ||
      /vbaProject|externalLinks/i.test(name)
    )
      throw new DomainError("xlsx_unsupported", 400);
    const compressed = b.readUInt32LE(pos + 20),
      local = b.readUInt32LE(pos + 42),
      method = b.readUInt16LE(pos + 10);
    if (
      local + 30 > b.length ||
      b.readUInt32LE(local) !== 0x04034b50 ||
      ![0, 8].includes(method)
    )
      throw new DomainError("xlsx_structure_invalid", 400);
    const start =
      local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    if (start + compressed > b.length)
      throw new DomainError("xlsx_structure_invalid", 400);
    let inflated: Buffer;
    try {
      inflated =
        method === 8
          ? inflateRawSync(b.subarray(start, start + compressed), {
              maxOutputLength: 16000000,
            })
          : b.subarray(start, start + compressed);
    } catch {
      throw new DomainError("xlsx_unsupported", 400);
    }
    if (
      inflated.length !== b.readUInt32LE(pos + 24) ||
      inflated.includes(Buffer.from("<!DOCTYPE"))
    )
      throw new DomainError("xlsx_unsupported", 400);
    pos += 46 + len + extra + comment;
  }
}
export async function parseFile(v: ImportInput) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(v.fileBase64))
    throw new DomainError("file_encoding_invalid", 400);
  const b = Buffer.from(v.fileBase64, "base64");
  if (!b.length || b.length > 2000000 || b.toString("base64") !== v.fileBase64)
    throw new DomainError("file_limits_exceeded", 400);
  let rows: string[][];
  if (v.sourceType === "csv") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(b);
    } catch {
      throw new DomainError("csv_utf8_required", 400);
    }
    rows = csv(text.replace(/^\uFEFF/, ""));
  } else {
    guardZip(b);
    const w = new ExcelJS.Workbook();
    try {
      await w.xlsx.load(b as any);
    } catch {
      throw new DomainError("xlsx_structure_invalid", 400);
    }
    if (w.worksheets.length !== 1)
      throw new DomainError("single_sheet_required", 400);
    const sheet = w.worksheets[0]!;
    if (sheet.rowCount > 1001 || sheet.columnCount > 64)
      throw new DomainError("file_limits_exceeded", 400);
    rows = [];
    for (let n = 1; n <= sheet.rowCount; n++) {
      const row: string[] = [];
      for (let j = 1; j <= sheet.columnCount; j++) {
        const x = sheet.getCell(n, j).value;
        if (x === null) row.push("");
        else if (typeof x === "string") row.push(x);
        else if (
          typeof x === "number" &&
          Number.isFinite(x) &&
          Math.abs(x) <= Number.MAX_SAFE_INTEGER
        )
          row.push(String(x));
        else throw new DomainError("xlsx_text_or_number_required", 400);
      }
      rows.push(row);
    }
  }
  const headers = rows.shift();
  if (
    !headers ||
    headers.length < 1 ||
    headers.length > 64 ||
    new Set(headers).size !== headers.length ||
    headers.some((h) => !h || h.length > 100) ||
    rows.length > 1000 ||
    !rows.length
  )
    throw new DomainError("file_headers_or_rows_invalid", 400);
  if (
    !v.adapter &&
    (!v.mapping.uid ||
      !headers.includes(v.mapping.uid) ||
      Object.values(v.mapping).some((h) => !headers.includes(h)) ||
      new Set(Object.values(v.mapping)).size !==
        Object.values(v.mapping).length)
  )
    throw new DomainError("explicit_mapping_invalid", 400);
  if (
    rows.some(
      (r) => r.length !== headers.length || r.some((x) => x.length > 2000),
    )
  )
    throw new DomainError("file_row_structure_invalid", 400);
  return {
    headers,
    fileDigest: digest(b),
    rows: rows.map((r) =>
      Object.fromEntries(headers.map((h, j) => [h, r[j]!])),
    ),
  };
}
export function normalizeRow(
  raw: Record<string, string>,
  mapping: ImportInput["mapping"],
  platform: Record<string, any>,
  row: number,
) {
  const normalized: Record<string, string | null> = {},
    issues: Issue[] = [];
  for (const field of fields) {
    const value = mapping[field] ? (raw[mapping[field]!] ?? "") : "";
    try {
      if (field === "uid") normalized.uid = canonicalUid(value, platform);
      else if ((moneyFields as readonly string[]).includes(field)) {
        normalized[field] = decimal(value);
        if (normalized[field] === null)
          issues.push({
            severity: "warning",
            code: "missing_metric",
            field,
            row,
          });
      } else if (field === "deposit_count") {
        if (value && !/^\d{1,12}$/.test(value)) throw Error();
        normalized[field] = value ? BigInt(value).toString() : null;
      } else if (field === "first_deposit_date") {
        if (value && !businessDate(value)) throw Error();
        normalized[field] = value || null;
      } else if (field === "registered_at" || field === "login_time") {
        if (
          value &&
          (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
            value,
          ) ||
            !businessDate(value.slice(0, 10)) ||
            !Number.isFinite(Date.parse(value)))
        )
          throw Error();
        normalized[field] = value ? new Date(value).toISOString() : null;
        if (!value)
          issues.push({
            severity: "warning",
            code: "missing_time",
            field,
            row,
          });
      } else {
        if (value.length > 300) throw Error();
        normalized[field] = value || null;
      }
    } catch {
      normalized[field] = null;
      issues.push({
        severity: "fatal",
        code: field === "uid" ? "uid_invalid" : "value_invalid",
        field,
        row,
      });
    }
  }
  if (
    normalized.deposit !== null &&
    normalized.withdrawal !== null &&
    normalized.source_net !== null &&
    normalized.deposit !== undefined &&
    normalized.withdrawal !== undefined &&
    normalized.source_net !== undefined
  ) {
    if (
      units(normalized.deposit) - units(normalized.withdrawal) !==
      units(normalized.source_net)
    )
      issues.push({ severity: "warning", code: "source_net_mismatch", row });
  }
  return { normalized, issues };
}
