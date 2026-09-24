import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { DomainError } from "./db.js";
// Replicas should share QUERY_CURSOR_SECRET. Without it, restart invalidates cursors safely.
const configured = process.env.QUERY_CURSOR_SECRET;
if (configured && Buffer.byteLength(configured) < 32)
  throw new Error("QUERY_CURSOR_SECRET must contain at least 32 bytes");
const key = configured ? Buffer.from(configured) : randomBytes(32);
const payloadSchema = z
  .object({
    v: z.literal(1),
    binding: z.string().length(64),
    id: z.uuid(),
    value: z.string().max(100).nullable(),
    expires: z.number(),
  })
  .strict();
export const binding = (data: unknown) =>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");
export function encodeCursor(
  context: string,
  id: string,
  value: string | null,
) {
  const data = Buffer.from(
    JSON.stringify({
      v: 1,
      binding: context,
      id,
      value,
      expires: Date.now() + 3600000,
    }),
  ).toString("base64url");
  return `${data}.${createHmac("sha256", key).update(data).digest("base64url")}`;
}
export function decodeCursor(token: string, context: string) {
  try {
    const [data, signature, ...extra] = token.split(".");
    if (!data || !signature || extra.length) throw Error();
    const expected = createHmac("sha256", key).update(data).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      throw Error();
    const payload = payloadSchema.parse(
      JSON.parse(Buffer.from(data, "base64url").toString()),
    );
    if (payload.binding !== context || payload.expires < Date.now())
      throw Error();
    return payload;
  } catch {
    throw new DomainError("invalid_cursor", 400);
  }
}
