import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export type EncryptedCode = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: string;
  fingerprint: string;
};
export type RedemptionCodeVault = {
  encrypt(code: string, platformId: string): EncryptedCode;
  decrypt(row: any, platformId: string): string;
  fingerprint(code: string, platformId: string): string;
};

const codePattern = /^[\x21-\x7e]{4,160}$/;
const versionPattern = /^[a-zA-Z0-9._-]{1,32}$/;
function key(value: string | undefined, label: string) {
  if (!value) throw new Error(`${label} required`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new Error(`${label} must be 32-byte base64`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32) throw new Error(`${label} must be 32-byte base64`);
  return decoded;
}

function encryptionKeys(env: NodeJS.ProcessEnv) {
  const keyringConfigured = Boolean(
    env.REDEMPTION_CODE_ENCRYPTION_KEYS ||
    env.REDEMPTION_CODE_ACTIVE_KEY_VERSION,
  );
  const legacyConfigured = Boolean(
    env.REDEMPTION_CODE_ENCRYPTION_KEY || env.REDEMPTION_CODE_KEY_VERSION,
  );
  if (keyringConfigured && legacyConfigured)
    throw new Error(
      "Redemption code legacy and keyring encryption configuration cannot be mixed",
    );

  if (keyringConfigured) {
    const active = env.REDEMPTION_CODE_ACTIVE_KEY_VERSION;
    if (!active || !versionPattern.test(active))
      throw new Error("Invalid REDEMPTION_CODE_ACTIVE_KEY_VERSION");
    let raw: unknown;
    try {
      raw = JSON.parse(env.REDEMPTION_CODE_ENCRYPTION_KEYS ?? "");
    } catch {
      throw new Error("Invalid REDEMPTION_CODE_ENCRYPTION_KEYS");
    }
    if (!raw || Array.isArray(raw) || typeof raw !== "object")
      throw new Error("Invalid REDEMPTION_CODE_ENCRYPTION_KEYS");
    const entries = Object.entries(raw as Record<string, unknown>);
    if (
      !entries.length ||
      entries.some(
        ([version, value]) =>
          !versionPattern.test(version) || typeof value !== "string",
      )
    )
      throw new Error("Invalid REDEMPTION_CODE_ENCRYPTION_KEYS");
    const keys = new Map(
      entries.map(([version, value]) => [
        version,
        key(value as string, "REDEMPTION_CODE_ENCRYPTION_KEYS entry"),
      ]),
    );
    if (!keys.has(active))
      throw new Error("Active redemption code encryption key unavailable");
    return { active, keys };
  }

  const active = env.REDEMPTION_CODE_KEY_VERSION;
  if (!active || !versionPattern.test(active))
    throw new Error("Invalid REDEMPTION_CODE_KEY_VERSION");
  return {
    active,
    keys: new Map([
      [
        active,
        key(
          env.REDEMPTION_CODE_ENCRYPTION_KEY,
          "REDEMPTION_CODE_ENCRYPTION_KEY",
        ),
      ],
    ]),
  };
}

export function createRedemptionCodeVault(
  env: NodeJS.ProcessEnv,
): RedemptionCodeVault | undefined {
  const any = Boolean(
    env.REDEMPTION_CODE_ENCRYPTION_KEYS ||
    env.REDEMPTION_CODE_ACTIVE_KEY_VERSION ||
    env.REDEMPTION_CODE_ENCRYPTION_KEY ||
    env.REDEMPTION_CODE_KEY_VERSION ||
    env.REDEMPTION_CODE_FINGERPRINT_KEY,
  );
  if (!any) return undefined;
  const { active, keys } = encryptionKeys(env);
  const fingerprintKey = key(
    env.REDEMPTION_CODE_FINGERPRINT_KEY,
    "REDEMPTION_CODE_FINGERPRINT_KEY",
  );
  const fingerprint = (code: string, platformId: string) =>
    createHmac("sha256", fingerprintKey)
      .update(`${platformId}\0${code}`)
      .digest("hex");
  return {
    fingerprint,
    encrypt(code, platformId) {
      if (!codePattern.test(code)) throw new Error("invalid_redemption_code");
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", keys.get(active)!, iv);
      cipher.setAAD(Buffer.from(`${platformId}\0${active}`));
      const ciphertext = Buffer.concat([
        cipher.update(code, "utf8"),
        cipher.final(),
      ]);
      return {
        ciphertext,
        iv,
        authTag: cipher.getAuthTag(),
        keyVersion: active,
        fingerprint: fingerprint(code, platformId),
      };
    },
    decrypt(row, platformId) {
      const version = String(row.code_key_version ?? "");
      const encryption = keys.get(version);
      if (!encryption) throw new Error("redemption_code_key_unavailable");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        encryption,
        Buffer.from(row.code_iv),
      );
      decipher.setAAD(Buffer.from(`${platformId}\0${version}`));
      decipher.setAuthTag(Buffer.from(row.code_auth_tag));
      const code = Buffer.concat([
        decipher.update(Buffer.from(row.code_ciphertext)),
        decipher.final(),
      ]).toString("utf8");
      const expected = Buffer.from(fingerprint(code, platformId), "hex"),
        actual = Buffer.from(String(row.code_fingerprint), "hex");
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      )
        throw new Error("redemption_code_integrity_failed");
      return code;
    },
  };
}
