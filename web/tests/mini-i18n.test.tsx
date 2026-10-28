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
  dictionaries,
  contentLocale,
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
  it("all five locales have explicit translations and safe missing-key fallback", () => {
    for (const locale of supportedUiLocales)
      for (const key of Object.keys(zh))
        expect(translate(locale, key)).not.toMatch(/undefined|^translation\./);
    expect(translate("pt-BR", "home")).toBe("Início");
    expect(translate("pt-BR", "inviteShare")).toBe("Compartilhar com amigos");
    expect(translate("pt-BR", "p2PointsEarned")).toBe(
      "Points ganhos com convites",
    );
    expect(translate("pt-BR", "rules")).toBe("Regras do convite");
    expect(translate("pt-BR", "rulesUnpublished")).toBe(
      "Regras ainda não publicadas",
    );
    expect(translate("pt-BR", "journey1")).toBe(
      "Compartilhe seu link de convite",
    );
    expect(translate("en", "home")).toBe("Home");
    expect(translate("zh-CN", "unknown.key")).toBe("内容正在准备中");
    for (const locale of supportedUiLocales)
      expect(translate(locale, "unknown.key")).toBe(
        dictionaries[locale].unavailable,
      );
    expect(normalizeLocale("fil-PH")).toBe("fil");
  });
  it("every locale explicitly covers the complete key set with identical interpolation contracts", () => {
    const keys = Object.keys(zh).sort();
    for (const locale of supportedUiLocales) {
      expect(Object.keys(dictionaries[locale]).sort()).toEqual(keys);
      expect(contentLocale(locale)).toBe(locale);
      for (const key of keys) {
        const entry = dictionaries[locale][key as keyof typeof zh];
        expect(entry.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
        const tokens = (value: string) =>
          [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        expect(tokens(entry), `${locale}.${key}`).toEqual(
          tokens(zh[key as keyof typeof zh]),
        );
      }
    }
  });
  it("non-English locales do not silently borrow English sentences, buttons or error states", () => {
    // Brand terms and mathematical notation intentionally remain unchanged.
    const universal = new Set(["growth", "pointsUnit", "p2GrowthChange"]);
    for (const locale of ["pt-BR", "es-MX", "fil"] as const) {
      for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
        if (!universal.has(key)) {
          expect(dictionaries[locale][key], `${locale}.${key}`).not.toBe(
            dictionaries.en[key],
          );
        }
      }
    }
    expect(translate("es-MX", "unauthorized")).toContain("sesión");
    expect(translate("fil", "inventoryEmpty")).toContain("Walang");
    expect(translate("pt-BR", "p0PointsGap", { points: "100" })).toBe(
      "Faltam 100 Points",
    );
  });
  it("keeps invite Points separate from check-in Growth in every language", () => {
    for (const locale of supportedUiLocales) {
      expect(translate(locale, "p2InviteNext")).toContain("Points");
      expect(translate(locale, "p2InviteNext")).not.toContain("Growth");
      expect(translate(locale, "p0CheckinGrowth")).toContain("Growth");
      expect(translate(locale, "p0CheckinEarned", { growth: "0" })).toContain(
        "0",
      );
      expect(
        translate(locale, "p0CheckinEarned", { growth: "0" }),
      ).not.toContain("5");
    }
  });
  it("distinguishes permission denial from expired auth, connection failure and disabled features", () => {
    expect(translate("zh-CN", "forbidden")).toBe("你没有执行此操作的权限。");
    for (const locale of supportedUiLocales) {
      const states = [
        "forbidden",
        "unauthorized",
        "network",
        "service_unavailable",
        "p0MemberDisabled",
        "p0Unavailable",
      ];
      expect(new Set(states.map((key) => translate(locale, key))).size).toBe(
        states.length,
      );
    }
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
