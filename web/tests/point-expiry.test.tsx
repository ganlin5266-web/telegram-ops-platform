import React from "react";
import { afterEach, it, expect, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PointExpiry from "../src/point-expiry/PointExpiry";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const props = {
  base: "/v1/brands/b/bots/c",
  permissions: ["points.expiry.read", "points.expiry.manage"],
  csrf: "synthetic-test",
  onExpire: vi.fn(),
};
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
it("read permission denied does not fetch", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(<PointExpiry {...props} permissions={[]} />);
  expect(screen.getByText("你没有查看积分有效期的权限。")).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});
it("disabled feature shows real schema status and empty lot state", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => reply({ schemaReady: true, enabled: false, items: [] })),
  );
  render(<PointExpiry {...props} />);
  await screen.findByText("暂无积分批次。");
  expect(screen.getByText(/批次积分路径未启用/)).toBeTruthy();
  expect(screen.queryByText("undefined")).toBeNull();
});
it("read-only operator has no policy creation control", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => reply({ schemaReady: true, enabled: false, items: [] })),
  );
  render(<PointExpiry {...props} permissions={["points.expiry.read"]} />);
  await screen.findByText("暂无积分批次。");
  expect(screen.queryByText("创建策略版本")).toBeNull();
});
it("schema pending does not request lot data", async () => {
  const fetch = vi.fn(async () =>
    reply({ schemaReady: false, enabled: false, items: [] }),
  );
  vi.stubGlobal("fetch", fetch);
  render(<PointExpiry {...props} />);
  await screen.findByText("数据库结构尚未就绪。");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("draft requires explicit publish confirmation, mutation carries CSRF", async () => {
  const v = {
    id: "v1",
    version: 1,
    mode: "permanent",
    rolling_days: null,
    deadline: null,
    timezone: "UTC",
    effective_at: new Date().toISOString(),
    status: "draft",
    refund_min_compensation_days: null,
  };
  const fetch = vi.fn(async (url: any) =>
    reply(
      String(url).endsWith("/policies")
        ? {
            schemaReady: true,
            enabled: false,
            items: [{ id: "p", name: "TEST ONLY", source: "*", versions: [v] }],
          }
        : { items: [] },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<PointExpiry {...props} />);
  await userEvent.click(await screen.findByText("确认发布"));
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(([url]) => String(url).endsWith("/v1/publish")),
    ).toBe(true),
  );
  const call = (fetch.mock.calls as unknown as any[][]).find(([u]) =>
    String(u).endsWith("/v1/publish"),
  );
  expect(call?.[1].headers["X-CSRF-Token"]).toBe("synthetic-test");
});
it("session expiry hands off to existing auth handler", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => reply({ error: "unauthorized" }, 401)),
  );
  const onExpire = vi.fn();
  render(<PointExpiry {...props} onExpire={onExpire} />);
  await waitFor(() => expect(onExpire).toHaveBeenCalled());
});
