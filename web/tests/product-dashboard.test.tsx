import React from "react";
import { it, expect, vi, afterEach } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import Dashboard from "../src/product/Dashboard";
import { metrics, metricValue, periodRange } from "../src/product/metrics";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("calendar ranges respect Sao Paulo, Monday weeks, leap months and DST", () => {
  expect(periodRange("2026-09-28", "day", "America/Sao_Paulo")).toEqual({
    from: "2026-09-28T03:00:00.000Z",
    to: "2026-09-29T03:00:00.000Z",
  });
  expect(periodRange("2026-09-30", "week", "America/Sao_Paulo").from).toBe(
    "2026-09-28T03:00:00.000Z",
  );
  expect(periodRange("2024-02-18", "month", "UTC")).toEqual({
    from: "2024-02-01T00:00:00.000Z",
    to: "2024-03-01T00:00:00.000Z",
  });
  const r = periodRange("2026-03-08", "day", "America/New_York");
  expect(Date.parse(r.to) - Date.parse(r.from)).toBe(23 * 3600000);
  expect(() => periodRange("2026-02-31", "day", "UTC")).toThrow();
});
it("unknown differs from zero; exact large integers and unsupported attribution fail closed", () => {
  const m = metrics.find((m) => m.key === "pointsCredit")!;
  expect(
    metricValue(m, { period: { pointsEarned: "9007199254740993123" } }),
  ).toBe("9007199254740993123");
  expect(metricValue(m, { period: { pointsEarned: "0" } })).toBe("0");
  expect(metricValue(m, { period: { pointsEarned: "19" } }, true)).toBeNull();
  expect(
    metricValue(
      metrics.find((m) => m.key === "activeUsers")!,
      {},
    ),
  ).toBeNull();
  expect(metrics.find((m) => m.key === "inviters")?.aggregation).toBe(
    "DISTINCT",
  );
  expect(metrics.find((m) => m.key === "inviteConversion")?.week).toContain(
    "分子",
  );
});
it("period changes issue bounded aggregate GETs; platform filters never leak Bot totals", async () => {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, options) => {
      urls.push(String(input));
      expect(options.method || "GET").toBe("GET");
      return new Response(
        JSON.stringify(
          String(input).endsWith("/platforms")
            ? {
                items: [
                  {
                    id: "p",
                    display_name: "Platform",
                    market: "BR",
                    timezone: "America/Sao_Paulo",
                  },
                ],
              }
            : {
                timezone: "America/Sao_Paulo",
                snapshotAt: "now",
                realtime: { totalUsers: 4, pointsBalance: "2640" },
                period: {
                  newUsers: 2,
                  pointsEarned: "100",
                  pointsSpent: "0",
                  referrals: { newRelations: 1, uniqueInviters: 1 },
                  redemptions: { created: 0 },
                  refunds: { points: "0" },
                },
              },
        ),
        { headers: { "content-type": "application/json" } },
      );
    }),
  );
  render(
    <Dashboard
      base="/v1/brands/b/bots/t"
      permissions={["dashboard.read", "platforms.read"]}
      onExpire={() => {}}
      dataCenter
    />,
  );
  await screen.findByText("2,640");
  fireEvent.click(screen.getByRole("button", { name: "月", exact: true }));
  await waitFor(() =>
    expect(
      urls.some(
        (url) =>
          url.includes("summary") &&
          new URL(url, "http://test").searchParams
            .get("from")
            ?.includes("T03:00"),
      ),
    ).toBe(true),
  );
  fireEvent.change(screen.getByLabelText("报表平台"), {
    target: { value: "p" },
  });
  expect(screen.queryByText("2,640")).toBeNull();
  expect(screen.getAllByText("待接入").length).toBeGreaterThan(10);
  expect(
    urls.every((u) => !u.includes("/users") && !u.includes("ledger")),
  ).toBe(true);
});
it("permission denial does not fetch dashboard", () => {
  const send = vi.fn();
  vi.stubGlobal("fetch", send);
  render(<Dashboard base="/b" permissions={[]} onExpire={() => {}} />);
  expect(send).not.toHaveBeenCalled();
});
