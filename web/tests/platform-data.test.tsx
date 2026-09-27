import React from "react";
import { it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DailyData from "../src/platform-data/DailyData";
import PlatformAccounts from "../src/mini/PlatformAccounts";
import type { MiniClient } from "../src/mini/client";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("daily data read permission required; no upload or activation without explicit grants", async () => {
  render(
    <DailyData
      base="/v1/scope"
      csrf="test"
      permissions={[]}
      onExpire={() => {}}
    />,
  );
  expect(screen.getByText("没有平台数据读取权限。")).toBeTruthy();
  expect(screen.queryByText("上传并预检")).toBeNull();
});
it("batch requires explicit confirmation before activate and source evidence is explicit", async () => {
  const calls: { path: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, opts: any) => {
      calls.push({ path, method: opts?.method ?? "GET" });
      const batch = {
        id: "batch",
        business_date: "2026-09-26",
        status: "ready",
        completeness: "complete",
        file_digest: "abc",
        row_count: 1,
        accepted_rows: 1,
        rejected_rows: 0,
        warning_rows: 0,
        issues: [],
      };
      let data: any;
      if (path.endsWith("/platforms"))
        data = {
          items: [
            {
              id: "p",
              display_name: "FUN66",
              code: "TEST",
              timezone: "America/Sao_Paulo",
              currency: "BRL",
            },
          ],
        };
      else if (path.includes("/batches?"))
        data = { items: [batch], nextOffset: null };
      else if (path.includes("/facts?")) data = { items: [], nextOffset: null };
      else if (path.endsWith("/activate")) data = { ok: true };
      else
        data = {
          batch,
          rows: [
            {
              id: "e",
              rowNumber: 2,
              uidMasked: "BR****01",
              values: { deposit: "100.000000", withdrawal: null },
              previousValues: null,
              issues: [],
            },
          ],
        };
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  render(
    <DailyData
      base="/v1/scope"
      csrf="test"
      permissions={["platform_data.read", "platform_data.activate"]}
      onExpire={() => {}}
    />,
  );
  const u = userEvent.setup();
  await u.click(await screen.findByRole("button", { name: "预检详情" }));
  const activate = await screen.findByRole("button", { name: "确认 Activate" });
  expect((activate as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText("授权查看来源证据")).toBeNull();
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  await u.click(screen.getByRole("checkbox"));
  await u.click(activate);
  await waitFor(() =>
    expect(calls.filter((c) => c.path.endsWith("/activate"))).toHaveLength(1),
  );
  expect(document.body.textContent).not.toContain("BRTEST10001");
});
it("Mini platform status shows safe update date, no financial facts", async () => {
  const client = {
    platforms: async () => ({
      items: [
        {
          id: "p",
          display_name: "FUN66",
          status: "active",
          verification_method: "manual_admin",
          identity: { status: "verified", uidMasked: "BR****01" },
        },
      ],
    }),
    identities: async () => ({ items: [], nextCursor: null }),
    platformDataStatus: async () => ({
      items: [{ platformId: "p", latestDate: "2026-09-26", status: "updated" }],
    }),
  } as unknown as MiniClient;
  render(<PlatformAccounts client={client} locale="zh-CN" />);
  expect(await screen.findByText("平台数据: 已更新至 2026-09-26")).toBeTruthy();
  expect(document.body.textContent).not.toContain("100.00");
});
it("adapter choice is explicit and preview shows version without activating", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path.endsWith("/platforms")
              ? {
                  items: [
                    {
                      id: "p",
                      display_name: "Synthetic",
                      code: "TEST",
                      timezone: "America/Sao_Paulo",
                      currency: "BRL",
                    },
                  ],
                }
              : { items: [], nextOffset: null },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );
  render(
    <DailyData
      base="/v1/scope"
      csrf="test"
      permissions={["platform_data.read", "platform_data.import"]}
      onExpire={() => {}}
    />,
  );
  const select = await screen.findByRole("combobox", { name: "报表适配版本" });
  await userEvent.selectOptions(select, "player-report-minor-units");
  expect((select as HTMLSelectElement).value).toBe("player-report-minor-units");
  expect(screen.getByText(/仅使用已批准的精确列结构/)).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "上传并预检" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.queryByRole("button", { name: "确认 Activate" })).toBeNull();
});
