import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import RedemptionInventory, {
  parseCodeLines,
} from "../src/redemptions/RedemptionInventory";

const base = "/v1/brands/brand/bots/bot";
const rule = {
  id: "rule-1",
  platform_id: "platform-1",
  tier_key: "brl_10",
  version: 1,
  status: "published",
  name: "BRL 10",
  points_cost: "100",
  face_value: "10.00000000",
  face_currency: "BRL",
  effective_from: "2026-10-18",
  effective_until: null,
  enabled: true,
};
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
let calls: { path: string; options: RequestInit }[];
let denied = false;
let orderRows: unknown[] = [];

beforeEach(() => {
  calls = [];
  denied = false;
  orderRows = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit) => {
      calls.push({ path, options });
      if (denied && path.endsWith("/redemption-rules"))
        return response({ error: "forbidden" }, 403);
      if (path.endsWith("/redemption-rules/preview"))
        return response({
          readonly: true,
          writes: 0,
          rule: {
            platformId: "platform-1",
            tierKey: "brl_25",
            name: "BRL 25",
            pointsCost: 200,
            faceValue: "25.00000000",
            currency: "BRL",
            effectiveFrom: "2026-10-18",
            effectiveUntil: null,
            mode: "fixed",
            dailyCountLimit: 1,
            dailyPointsLimit: 300,
            requiresDeposit: false,
            timezone: "America/Sao_Paulo",
          },
        });
      if (path.endsWith("/redemption-rules") && options.method === "POST")
        return response({ id: "rule-2", status: "draft" }, 201);
      if (path.endsWith("/redemption-rules"))
        return response({ items: [rule] });
      if (path.endsWith("/redemption-inventory"))
        return response({
          items: [
            {
              platform_id: "platform-1",
              rule_id: "rule-1",
              total: 9,
              available: 5,
              expired: 2,
              disabled: 1,
              assigned: 1,
              claimed: 0,
            },
          ],
        });
      if (
        path.endsWith("/redemption-code-batches") &&
        options.method === "POST"
      )
        return response({
          status: "rejected",
          total_count: 2,
          imported_count: 0,
          duplicate_count: 2,
        });
      if (path.endsWith("/redemption-code-batches"))
        return response({
          items: [
            {
              id: "batch-1",
              platform_id: "platform-1",
              rule_id: "rule-1",
              status: "rejected",
              total_count: 2,
              imported_count: 0,
              duplicate_count: 2,
              created_at: "2026-10-18T12:00:00Z",
            },
          ],
        });
      if (path.endsWith("/redemptions")) return response({ items: orderRows });
      if (path.endsWith("/platforms"))
        return response({
          items: [
            {
              id: "platform-1",
              code: "FUN66",
              display_name: "FUN66",
              currency: "BRL",
              timezone: "America/Sao_Paulo",
              status: "active",
            },
          ],
        });
      throw new Error(`Unhandled route ${path}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("does not request inventory without read permission", () => {
  render(
    <RedemptionInventory
      base={base}
      permissions={[]}
      csrf="csrf"
      onExpire={() => {}}
    />,
  );
  expect(screen.getByText(/没有查看兑换配置与库存的权限/)).toBeTruthy();
  expect(calls).toHaveLength(0);
});

it("lists safe order metadata and independently gates manual review", async () => {
  orderRows = [
    {
      id: "order-1",
      platform_id: "platform-1",
      points_cost: "100",
      status: "code_claimed",
      business_date: "2026-10-19",
      review_reason: null,
      created_at: "2026-10-19T00:00:00Z",
      tier_key: "brl_10",
      face_value: "10",
      face_currency: "BRL",
    },
  ];
  render(
    <RedemptionInventory
      base={base}
      permissions={["redemptions.read"]}
      csrf="csrf"
      onExpire={() => {}}
    />,
  );
  await screen.findByText("code_claimed");
  expect(screen.queryByText("标记待核实")).toBeNull();
  expect(document.body.textContent).not.toContain("兑换码明文");
  cleanup();
  render(
    <RedemptionInventory
      base={base}
      permissions={["redemptions.read", "redemptions.review"]}
      csrf="csrf"
      onExpire={() => {}}
    />,
  );
  await screen.findByText("标记待核实");
});

it("keeps rules and import actions independently permissioned", async () => {
  render(
    <RedemptionInventory
      base={base}
      permissions={["redemptions.read"]}
      csrf="csrf"
      onExpire={() => {}}
    />,
  );
  await screen.findByText("BRL 10");
  expect(screen.queryByText("新建固定档位")).toBeNull();
  expect(screen.queryByText("批量导入兑换码")).toBeNull();
  expect(calls.some((call) => call.path.endsWith("/platforms"))).toBe(false);
  expect(screen.getByText("过期")).toBeTruthy();
  expect(screen.getByText("禁用")).toBeTruthy();
});

it("shows duplicate rejection counts and clears plaintext after import", async () => {
  render(
    <RedemptionInventory
      base={base}
      permissions={["redemptions.read", "redemptions.inventory.manage"]}
      csrf="csrf"
      onExpire={() => {}}
    />,
  );
  await screen.findByText("BRL 10");
  fireEvent.click(screen.getByText("批量导入兑换码"));
  const input = screen.getByLabelText("兑换码（每行一个，最多 500 个）");
  fireEvent.change(input, { target: { value: "SECRET-A\nSECRET-A" } });
  fireEvent.click(screen.getByText("确认导入"));
  await screen.findByText(/整批未导入：发现 2 个同平台重复码/);
  expect((input as HTMLTextAreaElement).value).toBe("");
  expect(document.body.textContent).not.toContain("SECRET-A");
  const call = calls.find(
    (item) =>
      item.path.endsWith("/redemption-code-batches") &&
      item.options.method === "POST",
  )!;
  expect(JSON.parse(String(call.options.body))).toEqual({
    ruleId: "rule-1",
    codes: [
      { code: "SECRET-A", expiresAt: null },
      { code: "SECRET-A", expiresAt: null },
    ],
  });
  expect(call.options.headers).toHaveProperty("X-CSRF-Token", "csrf");
});

it("previews and creates only the approved fixed-tier contract", async () => {
  render(
    <RedemptionInventory
      base={base}
      permissions={[
        "redemptions.read",
        "redemptions.rules.manage",
        "platforms.read",
      ]}
      csrf="csrf"
      onExpire={() => {}}
    />,
  );
  await screen.findByText("BRL 10");
  fireEvent.click(screen.getByText("新建固定档位"));
  fireEvent.change(screen.getByLabelText("平台"), {
    target: { value: "platform-1" },
  });
  fireEvent.change(screen.getByLabelText("档位标识"), {
    target: { value: "brl_25" },
  });
  fireEvent.change(screen.getByLabelText("显示名称"), {
    target: { value: "BRL 25" },
  });
  fireEvent.change(screen.getByLabelText("Points 成本"), {
    target: { value: "200" },
  });
  fireEvent.change(screen.getByLabelText("兑换码面额"), {
    target: { value: "25.00000000" },
  });
  fireEvent.change(screen.getByLabelText("币种"), {
    target: { value: "BRL" },
  });
  fireEvent.change(screen.getByLabelText("生效日期"), {
    target: { value: "2026-10-18" },
  });
  fireEvent.click(screen.getByText("预览"));
  await screen.findByText("每日最多 1 次 / 300 Points · 无充值校验");
  fireEvent.click(screen.getByText("创建草稿"));
  await screen.findByText("固定兑换档位草稿已创建，请核对后再发布。");

  const create = calls.find(
    (item) =>
      item.path.endsWith("/redemption-rules") && item.options.method === "POST",
  )!;
  expect(JSON.parse(String(create.options.body))).toEqual({
    platformId: "platform-1",
    tierKey: "brl_25",
    name: "BRL 25",
    pointsCost: 200,
    faceValue: "25.00000000",
    currency: "BRL",
    effectiveFrom: "2026-10-18",
    effectiveUntil: null,
  });
  expect(create.options.headers).toHaveProperty("X-CSRF-Token", "csrf");
});

it("maps backend forbidden responses without leaking data", async () => {
  denied = true;
  render(
    <RedemptionInventory
      base={base}
      permissions={["redemptions.read"]}
      csrf="csrf"
      onExpire={() => {}}
    />,
  );
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain("没有权限");
});

it("parses opaque one-code-per-line input without inventing CSV semantics", () => {
  expect(parseCodeLines("\uFEFFCODE,WITH,COMMAS\r\n\n  CODE-B  \n")).toEqual([
    "CODE,WITH,COMMAS",
    "CODE-B",
  ]);
});
