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

it("conflict displays operator copy and drills into scoped P4 evidence", async () => {
  const fetch = vi.fn(async (url: string) => {
    if (url.includes("/platform-data/batches/conflict-batch"))
      return response({
        batch: {
          id: "conflict-batch",
          business_date: "2026-09-27",
          status: "review_required",
        },
        rows: [{ id: "evidence", rowNumber: 2, uidMasked: "BR****01" }],
      });
    if (url.endsWith("/daily/subject"))
      return response({
        subject: { entitlement_date: "2026-09-28", current_revision_id: "rev" },
        revisions: [
          {
            id: "rev",
            revision_number: 2,
            status: "review_required",
            reason_code: "conflicting_data",
            conflict_evidence: [
              { batch_id: "conflict-batch", evidence_id: "evidence" },
            ],
          },
        ],
      });
    if (url.includes("/daily?"))
      return response({
        items: [
          {
            id: "subject",
            status: "review_required",
            reason_code: "conflicting_data",
          },
        ],
      });
    if (url.endsWith("/platforms"))
      return response({ items: [{ id: "platform", display_name: "FUN66" }] });
    return response({ schemaReady: true, enabled: true, items: [] });
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <Entitlements
      {...props}
      permissions={[...props.permissions, "platform_data.read"]}
    />,
  );
  await screen.findByText("FUN66");
  await userEvent.click(
    screen.getByRole("button", { name: "日资格", exact: true }),
  );
  await userEvent.selectOptions(screen.getByLabelText("权益平台"), "platform");
  const input = screen.getByLabelText("权益日期");
  const { fireEvent } = await import("@testing-library/react");
  fireEvent.change(input, { target: { value: "2026-09-28" } });
  await userEvent.click(
    screen.getByRole("button", { name: "刷新", exact: true }),
  );
  await screen.findByText(/平台数据存在冲突/);
  expect(screen.queryByText("conflicting_data")).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "查看详情", exact: true }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "查看 P4 冲突证据" }),
  );
  await screen.findByRole("region", { name: "P4 冲突证据" });
  expect(screen.getByText(/BR\*\*\*\*01/)).toBeTruthy();
  expect(
    fetch.mock.calls.some(
      ([url]) => url === props.base + "/platform-data/batches/conflict-batch",
    ),
  ).toBe(true);
});
