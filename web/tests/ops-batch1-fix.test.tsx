// Codex review fixes (Batch 1). Fixtures follow docs/ops-read-api.md @ 81745b3.
// Contract/mock tests only — not a substitute for Staging integration.
import { it, expect, vi, afterEach, describe } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import RuntimeOps from "../src/product/ops/RuntimeOps";
import {
  mapPrivatePerf,
  type OpsDataStatus,
  type OpsPerf,
} from "../src/product/ops/opsRead";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BASE = "/v1/brands/b/bots/t";
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
  depositors: ok(1),
  depositAmount: ok("1.000000", "BRL"),
  netDeposit: ok("1.000000", "BRL"),
  ...over,
});
const allOk = {
  depositors: ok(2),
  depositAmount: ok("2.000000", "BRL"),
  netDeposit: ok("2.000000", "BRL"),
};
const st = (
  items: Partial<OpsDataStatus["items"][number]>[],
): OpsDataStatus => ({
  items: items.map((i) => ({
    platformId: "A",
    latestBusinessDate: "2026-09-28",
    completeness: "complete",
    ...i,
  })),
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const summary = {
  timezone: "UTC",
  snapshotAt: "2026-09-29T10:00:00Z",
  realtime: { totalUsers: 1 },
  period: {},
};
const perfBody: OpsPerf = {
  scope: { platformId: null, period: "day", from: "d", to: "d" },
  platforms: [row("A")],
  total: allOk,
};
const pendingBody = {
  identityReview: ok(0),
  identityConflict: ok(2),
  platformDataReview: ok(1),
  qualificationReview: ok(0),
  growthReview: ok(0),
  lowInventory: {
    status: "backend_pending",
    value: null,
    reason: "not_implemented",
  },
};
type Route = (u: string) => Response | "network" | undefined;
function mock(route: Route = () => undefined) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      const u = String(input);
      urls.push(u);
      const r = route(u);
      if (r === "network") throw new TypeError("Failed to fetch");
      if (r) return r;
      if (u.includes("/platforms"))
        return json({
          items: [
            { id: "p1", display_name: "FUN66", market: "BR" },
            { id: "p2", display_name: "MXX", market: "MX" },
          ],
        });
      if (u.includes("trends")) return json({ items: [] });
      if (u.includes("ops/pending")) return json(pendingBody);
      if (u.includes("private-performance")) return json(perfBody);
      if (u.includes("platform-data-status"))
        return json(st([{ platformId: "A" }]));
      return json(summary);
    }),
  );
  return urls;
}
const ALL = ["dashboard.read", "platforms.read", "platform_data.read"];
const view = (permissions = ALL, onNavigate?: (t: string) => void) =>
  render(
    <RuntimeOps
      base={BASE}
      brandId="b"
      permissions={permissions}
      onExpire={() => {}}
      mode="overview"
      scopeLabel={{ brand: "B", bot: "T" }}
      onNavigate={onNavigate}
    />,
  );

describe("P1-1 no platform_data.read", () => {
  it("shows 无权限 (not 待接入) and sends no P4 requests", async () => {
    const urls = mock();
    view(["dashboard.read"]);
    expect(
      await screen.findByText("无权查看私域关联业绩（需要品牌级平台数据权限）"),
    ).toBeTruthy();
    expect(screen.getAllByText("无权限").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("无权查看平台数据状态")).toBeTruthy();
    await waitFor(() =>
      expect(urls.some((u) => u.includes("ops/pending"))).toBe(true),
    );
    expect(
      urls.some(
        (u) =>
          u.includes("private-performance") ||
          u.includes("platform-data-status"),
      ),
    ).toBe(false);
  });
});

describe("P1-2 platform-data-status error kinds", () => {
  const cases: [string, Response | "network", string][] = [
    ["403", json({ error: "forbidden" }, 403), "无权查看平台数据状态"],
    ["404", json({ error: "not_found" }, 404), "数据状态待接入"],
    ["500", json({ error: "internal" }, 500), "平台数据状态加载失败"],
    ["network", "network", "平台数据状态加载失败"],
    ["empty", json({ items: [] }), "暂无已启用 Platform 的数据状态"],
  ];
  for (const [name, res, text] of cases)
    it(name, async () => {
      mock((u) =>
        u.includes("platform-data-status")
          ? res instanceof Response
            ? res.clone()
            : res
          : undefined,
      );
      view();
      expect(await screen.findByText(text)).toBeTruthy();
    });
});

describe("P1-3/4 completeness + period_open", () => {
  it("unknown + incomplete keeps 完整性未知 and notes the partial one", () => {
    const perf: OpsPerf = {
      scope: { platformId: null, period: "day", from: "d", to: "d" },
      platforms: [row("A"), row("B")],
      total: allOk,
    };
    const pd = mapPrivatePerf(
      perf,
      st([
        { platformId: "A", completeness: "unknown" },
        { platformId: "B", completeness: "incomplete" },
      ]),
    )!;
    expect(pd.freshness?.completeness).toBe("unknown");
    expect(pd.freshness?.note).toContain("部分缺失");
  });
  it("all platforms: total one_or_more_platforms_incomplete still detects row period_open", () => {
    const inc = (reason: string) => ({
      status: "data_incomplete" as const,
      value: null,
      reason,
    });
    const perf: OpsPerf = {
      scope: { platformId: null, period: "week", from: "a", to: "b" },
      platforms: [
        row("A"),
        row("B", {
          depositors: inc("period_open"),
          depositAmount: inc("period_open"),
          netDeposit: inc("period_open"),
        }),
      ],
      total: {
        depositors: inc("one_or_more_platforms_incomplete"),
        depositAmount: inc("one_or_more_platforms_incomplete"),
        netDeposit: inc("one_or_more_platforms_incomplete"),
      },
    };
    expect(mapPrivatePerf(perf)!.notice).toContain("统计周期尚未结束");
  });
});

describe("P2-6 per-platform timezone", () => {
  it("breakdown keeps each platform's own timezone", async () => {
    mock((u) =>
      u.includes("private-performance")
        ? json({
            ...perfBody,
            platforms: [
              row("A"),
              row("M", { currency: "MXN", timezone: "America/Mexico_City" }),
            ],
          })
        : undefined,
    );
    render(
      <RuntimeOps
        base={BASE}
        brandId="b"
        permissions={ALL}
        onExpire={() => {}}
        mode="data"
        scopeLabel={{ brand: "B", bot: "T" }}
      />,
    );
    expect(await screen.findByText("America/Mexico_City")).toBeTruthy();
    expect(screen.getByText("America/Sao_Paulo")).toBeTruthy();
  });
});

describe("P2-7 pending navigation", () => {
  it("去处理 navigates to real pages", async () => {
    mock();
    const nav = vi.fn();
    view(ALL, nav);
    await screen.findByText("身份冲突");
    const buttons = await screen.findAllByRole("button", { name: "去处理" });
    buttons.forEach((b) => fireEvent.click(b));
    expect(nav.mock.calls.map((c) => c[0]).sort()).toEqual([
      "daily-data",
      "identities",
    ]);
  });
  it("without a navigation handler the button is disabled, never silent", async () => {
    mock();
    view(ALL);
    await screen.findByText("身份冲突");
    const b = screen.getAllByRole("button", { name: "暂无入口" });
    expect(b.every((x) => (x as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe("P2-8/9 filters and scope", () => {
  it("Market only: no Brand-wide request, explicit unsupported; pending stays with scope note", async () => {
    const urls = mock();
    view();
    await screen.findByText("身份冲突");
    await screen.findByRole("option", { name: "MX" });
    const before = urls.filter((u) => u.includes("private-performance")).length;
    fireEvent.change(screen.getByLabelText("报表市场"), {
      target: { value: "MX" },
    });
    expect(
      await screen.findByText(
        "按国家筛选私域关联业绩暂不支持，请选择具体 Platform",
      ),
    ).toBeTruthy();
    expect(urls.filter((u) => u.includes("private-performance")).length).toBe(
      before,
    );
    expect(screen.getByText("身份冲突")).toBeTruthy();
    expect(screen.getByText(/不随国家或 Platform 筛选变化/)).toBeTruthy();
  });
  it("Market + Platform queries exactly that platformId", async () => {
    const urls = mock();
    view();
    await screen.findByRole("option", { name: "BR" });
    fireEvent.change(screen.getByLabelText("报表市场"), {
      target: { value: "BR" },
    });
    await screen.findByRole("option", { name: "FUN66" });
    fireEvent.change(screen.getByLabelText("报表平台"), {
      target: { value: "p1" },
    });
    await waitFor(() =>
      expect(
        urls.some(
          (u) =>
            u.includes("private-performance") && u.includes("platformId=p1"),
        ),
      ).toBe(true),
    );
    expect(screen.getByText("身份冲突")).toBeTruthy();
  });
});
