import React from "react";
import { it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Entitlements from "../src/entitlements/Entitlements";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const props = {
  base: "/v1/brands/b/bots/c",
  permissions: ["entitlements.read"],
  csrf: "synthetic-test",
  onExpire: vi.fn(),
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
it("entitlement permission denied has no network request", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(<Entitlements {...props} permissions={[]} />);
  expect(screen.getByText("你没有查看会员权益的权限。")).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});
it("disabled feature is explicit and read only operator cannot publish or run", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response({ schemaReady: true, enabled: false, items: [] }),
    ),
  );
  render(<Entitlements {...props} />);
  await screen.findByText("资格计算关闭；草稿与预览可用");
  expect(screen.queryByText("新建规则版本")).toBeNull();
  expect(screen.queryByText("执行最多20个到期任务")).toBeNull();
  expect(screen.getByText(/不发积分或游戏次数/)).toBeTruthy();
});
it("new draft does not publish itself and independent rule permission is required", async () => {
  const fetch = vi.fn(async () =>
    response({ schemaReady: true, enabled: false, items: [] }),
  );
  vi.stubGlobal("fetch", fetch);
  render(
    <Entitlements
      {...props}
      permissions={[...props.permissions, "entitlements.rules.manage"]}
    />,
  );
  await screen.findByText("资格计算关闭；草稿与预览可用");
  await userEvent.click(screen.getByText("新建规则版本"));
  expect(screen.getByText("预览，不写资格")).toBeTruthy();
  expect(screen.getByText("保存草稿")).toBeTruthy();
  expect(fetch.mock.calls.length).toBe(2);
});
it("expired admin session requests user reauthentication", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response({ error: "unauthorized" }, 401)),
  );
  render(<Entitlements {...props} />);
  await vi.waitFor(() => expect(props.onExpire).toHaveBeenCalled());
});
