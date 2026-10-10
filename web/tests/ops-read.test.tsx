// Fixtures follow Codex contract docs/ops-read-api.md @ 81745b3409cd4e1ad46beb5e01343bea36436dc4.
// These are contract tests only, not a substitute for Staging integration.
import { describe, expect, it } from "vitest";
import {
  decimalText,
  mapPending,
  mapPrivatePerf,
  metricCell,
  type OpsDataStatus,
  type OpsPending,
  type OpsPerf,
} from "../src/product/ops/opsRead";

const ok = (value: string | number, currency?: string) => ({
  status: "ok" as const,
  value,
  ...(currency ? { currency } : {}),
});
const row = (code: string, over: Record<string, unknown> = {}) => ({
  platformId: code,
  code,
  displayName: code,
  currency: "BRL",
  timezone: "America/Sao_Paulo",
  completeness: "complete" as const,
  depositors: ok(12),
  depositAmount: ok("1234.560000", "BRL"),
  netDeposit: ok("1000.000000", "BRL"),
  ...over,
});
const status = (
  items: Partial<OpsDataStatus["items"][number]>[],
): OpsDataStatus => ({
  items: items.map((i) => ({
    platformId: "A",
    latestBusinessDate: "2026-09-28",
    completeness: "complete",
    reviewRequired: false,
    ...i,
  })),
  expectedBusinessDate: {
    status: "backend_pending",
    value: null,
    reason: "expected_business_date_not_configured",
  },
});

describe("ops-read contract: metric envelope", () => {
  it("keeps exact decimal strings and currency, never floats", () => {
    expect(decimalText("1234.560000")).toBe("1234.56");
    expect(decimalText("0.000000")).toBe("0");
    expect(decimalText("12")).toBe("12");
    // Beyond float precision: must stay exact.
    expect(metricCell(ok("9007199254740993.000001", "BRL"))).toEqual({
      s: "value",
      v: "9007199254740993.000001 BRL",
    });
  });
  it("real 0 vs not_applicable vs pending vs incomplete vs forbidden", () => {
    expect(metricCell(ok(0))).toEqual({ s: "value", v: "0" });
    expect(metricCell(ok("0.000000", "BRL"))).toEqual({
      s: "value",
      v: "0 BRL",
    });
    expect(
      metricCell({
        status: "not_applicable",
        value: null,
        reason: "multiple_currencies",
      }),
    ).toEqual({ s: "na" });
    expect(metricCell({ status: "backend_pending", value: null })).toEqual({
      s: "pending",
    });
    expect(
      metricCell({
        status: "data_incomplete",
        value: null,
        reason: "period_open",
      }),
    ).toEqual({ s: "incomplete" });
    expect(metricCell({ status: "forbidden", value: null })).toEqual({
      s: "forbidden",
    });
    expect(metricCell(undefined)).toEqual({ s: "pending" });
  });
});

describe("ops-read contract: private-performance", () => {
  it("normal single platform day", () => {
    const pd = mapPrivatePerf(
      {
        scope: {
          platformId: "A",
          period: "day",
          from: "2026-09-28",
          to: "2026-09-28",
        },
        platforms: [row("A")],
        total: null,
      },
      status([{ platformId: "A" }]),
    )!;
    expect(pd.metrics.depositors).toEqual({ s: "value", v: "12" });
    expect(pd.metrics.depositAmount).toEqual({ s: "value", v: "1234.56 BRL" });
    expect(pd.metrics.netDeposit).toEqual({ s: "value", v: "1000 BRL" });
    expect(pd.metrics.returnActive).toEqual({ s: "pending" });
    expect(pd.breakdown).toBeNull();
    expect(pd.freshness).toEqual({
      latestBusinessDate: "2026-09-28",
      completeness: "complete",
    });
  });
  it("multiple currencies: per-platform money kept, totals not_applicable, depositors total from backend", () => {
    const perf: OpsPerf = {
      scope: {
        platformId: null,
        period: "week",
        from: "2026-09-28",
        to: "2026-10-04",
      },
      platforms: [
        row("A"),
        row("M", {
          currency: "MXN",
          depositAmount: ok("50.000000", "MXN"),
          netDeposit: ok("-3.500000", "MXN"),
        }),
      ],
      total: {
        depositors: ok(20),
        depositAmount: {
          status: "not_applicable",
          value: null,
          reason: "multiple_currencies",
        },
        netDeposit: {
          status: "not_applicable",
          value: null,
          reason: "multiple_currencies",
        },
      },
    };
    const pd = mapPrivatePerf(
      perf,
      status([
        { platformId: "A" },
        { platformId: "M", latestBusinessDate: "2026-09-27" },
      ]),
    )!;
    expect(pd.metrics.depositors).toEqual({ s: "value", v: "20" }); // not 12+12
    expect(pd.metrics.depositAmount).toEqual({ s: "na" });
    expect(pd.notice).toContain("币种不同");
    expect(pd.breakdown?.map((r) => r.values.depositAmount)).toEqual([
      { s: "value", v: "1234.56 BRL" },
      { s: "value", v: "50 MXN" },
    ]);
    expect(pd.breakdown?.[1].values.netDeposit).toEqual({
      s: "value",
      v: "-3.5 MXN",
    });
    expect(pd.freshness?.latestBusinessDate).toBe("2026-09-27");
  });
  it("incomplete / open period never becomes 0", () => {
    const inc = {
      status: "data_incomplete" as const,
      value: null,
      reason: "period_open",
    };
    const pd = mapPrivatePerf(
      {
        scope: {
          platformId: "A",
          period: "month",
          from: "2026-10-01",
          to: "2026-10-31",
        },
        platforms: [
          row("A", {
            completeness: "incomplete",
            depositors: inc,
            depositAmount: inc,
            netDeposit: inc,
          }),
        ],
        total: null,
      },
      status([{ platformId: "A", completeness: "incomplete" }]),
    )!;
    expect(pd.metrics.depositors).toEqual({ s: "incomplete" });
    expect(pd.metrics.netDeposit).toEqual({ s: "incomplete" });
    expect(pd.notice).toContain("尚未结束");
    expect(pd.freshness?.completeness).toBe("partial");
  });
  it("supports all five completeness states, worst wins", () => {
    const perf: OpsPerf = {
      scope: { platformId: null, period: "day", from: "d", to: "d" },
      platforms: [row("A"), row("B")],
      total: {
        depositors: ok(1),
        depositAmount: ok("1", "BRL"),
        netDeposit: ok("1", "BRL"),
      },
    };
    const pick = (b: OpsDataStatus["items"][number]["completeness"]) =>
      mapPrivatePerf(
        perf,
        status([{ platformId: "A" }, { platformId: "B", completeness: b }]),
      )!.freshness?.completeness;
    expect(pick("complete")).toBe("complete");
    expect(pick("incomplete")).toBe("partial");
    expect(pick("unknown")).toBe("unknown");
    expect(pick("conflicting")).toBe("conflict");
    const missing = mapPrivatePerf(
      perf,
      status([
        { platformId: "A" },
        { platformId: "B", completeness: "missing", latestBusinessDate: null },
      ]),
    )!;
    expect(missing.freshness).toMatchObject({
      completeness: "missing",
      latestBusinessDate: "2026-09-28",
    });
    expect(missing.freshness?.note).toContain("尚无已生效数据");
  });
  it("review required is surfaced; no status → freshness null; no data → null", () => {
    const perf: OpsPerf = {
      scope: { platformId: "A", period: "day", from: "d", to: "d" },
      platforms: [row("A")],
      total: null,
    };
    expect(
      mapPrivatePerf(perf, status([{ platformId: "A", reviewRequired: true }]))!
        .freshness?.note,
    ).toContain("待复核");
    expect(mapPrivatePerf(perf)!.freshness).toBeNull();
    expect(mapPrivatePerf(undefined)).toBeNull();
  });
});

describe("ops-read contract: pending", () => {
  const off = {
    status: "forbidden" as const,
    value: null,
    reason: "permission_required",
  };
  const base: OpsPending = {
    identityReview: ok(0),
    identityConflict: ok(2),
    platformDataReview: off,
    qualificationReview: ok(0),
    growthReview: { status: "data_incomplete", value: null, reason: "x" },
    lowInventory: {
      status: "backend_pending",
      value: null,
      reason: "not_implemented",
    },
  };
  it("real zeros omitted, positive counts listed, non-ok categories reported as gaps", () => {
    const v = mapPending(base)!;
    expect(v.items.map((i) => [i.key, i.count])).toEqual([
      ["identityConflict", "2"],
    ]);
    expect(v.gaps.map((g) => [g.key, g.state])).toEqual([
      ["platformDataReview", "forbidden"],
      ["growthReview", "incomplete"],
      ["lowInventory", "pending"],
    ]);
  });
  it("all zero with full permission → empty items and no gaps (真正无待处理)", () => {
    const all0 = {
      ...base,
      identityConflict: ok(0),
      platformDataReview: ok(0),
      growthReview: ok(0),
      lowInventory: ok(0),
    };
    expect(mapPending(all0)).toEqual({ items: [], gaps: [] });
    expect(mapPending(undefined)).toBeNull();
  });
});
