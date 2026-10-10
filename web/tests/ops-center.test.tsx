import React, { useState } from "react";
import { it, expect, vi, afterEach } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import OpsCenter from "../src/product/ops/OpsCenter";
import RuntimeOps from "../src/product/ops/RuntimeOps";
import {
  fmt,
  periodDays,
  trendDays,
  share,
  type Scope,
} from "../src/product/ops/model";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("cell states stay distinct: 0, —, 待接入, 加载失败", () => {
  expect(fmt({ s: "value", v: "0" })).toBe("0");
  expect(fmt({ s: "na" })).toBe("—");
  expect(fmt({ s: "pending" })).toBe("待接入");
  expect(fmt({ s: "error" })).toBe("加载失败");
  expect(fmt({ s: "value", v: "9007199254740993123" })).toBe(
    "9,007,199,254,740,993,123",
  );
  expect(share({ s: "value", v: "1" }, { s: "value", v: "0" })).toBeNull();
});
it("periods: Monday weeks, natural months, 7-day trend window", () => {
  expect(periodDays("2026-10-01", "week")).toEqual({
    start: "2026-09-28",
    end: "2026-10-04",
  });
  expect(periodDays("2024-02-10", "month")).toEqual({
    start: "2024-02-01",
    end: "2024-02-29",
  });
  expect(trendDays("2026-09-29", "day")).toEqual({
    start: "2026-09-23",
    end: "2026-09-29",
  });
});
function mockFetch(
  urls: string[],
  ops?: (u: string) => { status?: number; body: unknown } | undefined,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      const u = String(input);
      urls.push(u);
      if (u.includes("/ops/")) {
        const f = ops?.(u);
        if (f)
          return new Response(JSON.stringify(f.body), {
            status: f.status ?? 200,
            headers: { "content-type": "application/json" },
          });
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      const body = u.includes("/platforms")
        ? { items: [{ id: "p", display_name: "Plat", market: "BR" }] }
        : u.includes("members/analytics")
          ? {
              available: true,
              timezone: "UTC",
              members: "0",
              issued: "0",
              net: "0",
              earners: "0",
              upgrades: "0",
              distribution: [{ level: 1, n: 0 }],
            }
          : u.includes("trends")
            ? {
                items: [
                  {
                    date: "2026-09-29",
                    newUsers: 3,
                    pointsEarned: "10",
                    pointsSpent: "0",
                  },
                ],
              }
            : {
                timezone: "UTC",
                snapshotAt: "2026-09-29T10:00:00Z",
                realtime: { totalUsers: 4321, pointsBalance: "5" },
                period: {
                  newUsers: 0,
                  pointsEarned: "100",
                  pointsSpent: "0",
                  referrals: { newRelations: 2, uniqueInviters: 1 },
                  redemptions: { created: 0 },
                },
              };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
}
it("runtime: real zeros render as 0, unsupported metrics as 待接入, one period drives all requests", async () => {
  const urls: string[] = [];
  mockFetch(urls);
  render(
    <RuntimeOps
      base="/v1/brands/b/bots/t"
      brandId="b"
      permissions={["dashboard.read", "growth.read", "platforms.read"]}
      onExpire={() => {}}
      mode="overview"
      scopeLabel={{ brand: "B", bot: "T" }}
    />,
  );
  await screen.findByText("4,321");
  expect(screen.getAllByText("待接入").length).toBeGreaterThan(3);
  expect(
    screen.getByText("待处理聚合待接入：后端尚未提供跨模块待办数量"),
  ).toBeTruthy();
  const before = urls.length;
  fireEvent.click(screen.getByRole("button", { name: "月" }));
  await waitFor(() => expect(urls.length).toBeGreaterThan(before));
  const after = urls.slice(before);
  // Expected month follows the real current date (UTC test zone), not a hard-coded month.
  const m = periodDays(new Date().toISOString().slice(0, 10), "month");
  expect(
    after.some(
      (u) => u.includes("summary") && u.includes(`from=${m.start.slice(0, 7)}`),
    ),
  ).toBe(true);
  expect(
    after.some((u) =>
      u.includes(`members/analytics?from=${m.start}&to=${m.end}`),
    ),
  ).toBe(true);
  expect(after.every((u) => !/POST/.test(u))).toBe(true);
});
it("platform filter makes Bot totals 待接入 instead of leaking them", async () => {
  mockFetch([]);
  render(
    <RuntimeOps
      base="/v1/brands/b/bots/t"
      brandId="b"
      permissions={["dashboard.read", "platforms.read"]}
      onExpire={() => {}}
      mode="overview"
      scopeLabel={{ brand: "B", bot: "T" }}
    />,
  );
  await screen.findByText("4,321");
  await screen.findByRole("option", { name: "Plat" });
  fireEvent.change(screen.getByLabelText("报表平台"), {
    target: { value: "p" },
  });
  await waitFor(() => expect(screen.queryByText("4,321")).toBeNull());
});
it("no permission issues no request", () => {
  const f = vi.fn();
  vi.stubGlobal("fetch", f);
  render(
    <RuntimeOps
      base="/b"
      brandId="b"
      permissions={[]}
      onExpire={() => {}}
      mode="overview"
      scopeLabel={{ brand: "B", bot: "T" }}
    />,
  );
  expect(f).not.toHaveBeenCalled();
});
it("pending center sorts critical first and every item has 去处理", () => {
  const nav = vi.fn();
  function H() {
    const [scope, setScope] = useState<Scope>({
      period: "day",
      day: "2026-09-29",
      platform: "",
      market: "",
    });
    const c = { s: "pending" } as const;
    const data: any = {
      timezone: "UTC",
      updatedAt: null,
      realtime: false,
      metrics: new Proxy({}, { get: () => c }),
      trends: {},
      pending: [
        {
          key: "a",
          label: "UID 审核",
          count: "2",
          reason: "r",
          severity: "normal",
          target: "x",
        },
        {
          key: "b",
          label: "数据冲突",
          count: "1",
          reason: "r",
          severity: "critical",
          target: "y",
        },
      ],
      growth: { sources: {} },
      levels: null,
      points: {},
      funnel: {},
      referral: {},
      retention: null,
      retentionDefinition: null,
    };
    for (const k of ["growth", "points", "funnel", "referral"])
      data[k] = new Proxy(data[k], { get: (t, p) => (p in t ? t[p] : c) });
    data.growth.sources = new Proxy({}, { get: () => c });
    return (
      <OpsCenter
        data={data}
        scope={scope}
        onScope={setScope}
        platforms={[]}
        scopeLabel={{ brand: "B", bot: "T" }}
        mode="overview"
        onNavigate={nav}
      />
    );
  }
  render(<H />);
  const items = screen
    .getAllByRole("listitem")
    .filter((li) => li.closest(".ops-todo"));
  expect(items[0]!.textContent).toContain("数据冲突");
  fireEvent.click(screen.getAllByRole("button", { name: "去处理" })[0]!);
  expect(nav).toHaveBeenCalledWith("y");
});

it("ops contract: pending shows forbidden categories, perf network failure is an error (not 待接入/0)", async () => {
  const urls: string[] = [];
  mockFetch(urls, (u) => {
    if (u.includes("ops/pending"))
      return {
        body: {
          identityReview: { status: "ok", value: 0 },
          identityConflict: { status: "ok", value: 0 },
          platformDataReview: {
            status: "forbidden",
            value: null,
            reason: "permission_required",
          },
          qualificationReview: { status: "ok", value: 0 },
          growthReview: { status: "ok", value: 0 },
          lowInventory: {
            status: "backend_pending",
            value: null,
            reason: "not_implemented",
          },
        },
      };
    if (u.includes("private-performance"))
      return { status: 500, body: { error: "internal" } };
    if (u.includes("platform-data-status")) return { body: { items: [] } };
  });
  render(
    <RuntimeOps
      base="/v1/brands/b/bots/t"
      brandId="b"
      permissions={["dashboard.read", "platform_data.read"]}
      onExpire={() => {}}
      mode="overview"
      scopeLabel={{ brand: "B", bot: "T" }}
    />,
  );
  expect(await screen.findByText("可查看的类别暂无待处理")).toBeTruthy();
  expect(screen.queryByText("当前无待处理事项")).toBeNull();
  expect(screen.getByLabelText("未计入的待处理类别").textContent).toContain(
    "平台数据复核（无权限）",
  );
  expect(
    await screen.findByText("私域关联业绩加载失败，请刷新重试"),
  ).toBeTruthy();
  const perfUrl = urls.find((u) => u.includes("private-performance"))!;
  expect(perfUrl).toMatch(/period=day&date=\d{4}-\d{2}-\d{2}/);
});
it("ops contract: pending endpoint 403 is 无权查看, never 当前无待处理事项", async () => {
  mockFetch([], (u) =>
    u.includes("ops/pending")
      ? { status: 403, body: { error: "forbidden" } }
      : undefined,
  );
  render(
    <RuntimeOps
      base="/v1/brands/b/bots/t"
      brandId="b"
      permissions={["dashboard.read"]}
      onExpire={() => {}}
      mode="overview"
      scopeLabel={{ brand: "B", bot: "T" }}
    />,
  );
  expect(await screen.findByText("无权查看待处理汇总")).toBeTruthy();
  expect(screen.queryByText("当前无待处理事项")).toBeNull();
});
