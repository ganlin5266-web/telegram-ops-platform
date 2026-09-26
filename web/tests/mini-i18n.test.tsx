import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resolveLocale,
  normalizeLocale,
  translate,
  formatPoints,
  formatDate,
  formatMoney,
  homeState,
  savePreference,
  readPreference,
  supportedUiLocales,
  zh,
} from "../src/mini/i18n";
describe("Mini presentation locale", () => {
  it("device choice, stored user, Bot, project, Telegram, system precedence", () => {
    expect(
      resolveLocale({ device: "pt-BR", preferred: "en", bot: "zh-CN" }),
    ).toBe("pt-BR");
    expect(resolveLocale({ preferred: "en", bot: "zh-CN" })).toBe("en");
    expect(
      resolveLocale({ bot: "es-MX", project: "en", telegram: "zh-CN" }),
    ).toBe("es-MX");
    expect(resolveLocale({ project: "fil", telegram: "en" })).toBe("fil");
    expect(resolveLocale({ telegram: "pt" })).toBe("pt-BR");
    expect(resolveLocale({ bot: "unsupported", fallback: "zh-CN" })).toBe(
      "zh-CN",
    );
    expect(resolveLocale({})).toBe("en");
  });
  it("all choices have safe text, complete English, explicit missing-key fallback", () => {
    for (const locale of supportedUiLocales)
      for (const key of Object.keys(zh))
        expect(translate(locale, key)).not.toMatch(/undefined|^translation\./);
    expect(translate("pt-BR", "home")).toBe("Home");
    expect(translate("en", "home")).toBe("Home");
    expect(translate("zh-CN", "unknown.key")).toBe("Content is being prepared");
    expect(normalizeLocale("fil-PH")).toBe("fil");
  });
  it("integer points preserve bigint precision; no invented currency", () => {
    expect(formatPoints("9007199254740993", "en")).toBe(
      "9,007,199,254,740,993",
    );
    expect(formatPoints(null, "zh-CN")).toBe("—");
    expect(formatPoints("-120", "en")).toBe("-120");
    expect(formatMoney(1, "en", "")).toBe("—");
    expect(formatMoney(12, "pt-BR", "BRL")).toContain("12,00");
  });
  it("dates are locale formatted; invalid values are safe", () => {
    expect(formatDate("2026-09-26T12:00:00Z", "en")).not.toBe(
      formatDate("2026-09-26T12:00:00Z", "zh-CN"),
    );
    expect(formatDate("bad", "en")).toBe("—");
  });
  it("empty/new-data state never fabricates engagement or rewards", () => {
    expect(
      homeState({
        points: { accountExists: false },
        invitedCount: "0",
        redemptionCount: "0",
      }),
    ).toBe("empty_state");
    expect(
      homeState({
        points: { accountExists: true },
        invitedCount: "0",
        redemptionCount: "0",
      }),
    ).toBe("returning_user");
  });
  it("device preference is only a locale and isolated by public app selector", () => {
    localStorage.clear();
    savePreference("test-a", "en");
    expect(readPreference("test-a")).toBe("en");
    expect(readPreference("test-b")).toBeUndefined();
    expect(localStorage.getItem("mini-ui-language:test-a")).toBe("en");
    localStorage.clear();
  });
});

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    clear: () => store.clear(),
  });
});
afterEach(() => vi.unstubAllGlobals());
