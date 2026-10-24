import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReferralCampaigns from "../src/referrals/ReferralCampaigns";

const brandBase = "/v1/brands/brand";
const botBase = brandBase + "/bots/bot";
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
let calls: Array<{ path: string; options: RequestInit }>;
let rules: any[];

beforeEach(() => {
  calls = [];
  rules = [];
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit) => {
      calls.push({ path, options });
      if (path === botBase + "/platforms")
        return response({
          items: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              code: "FUN66",
              display_name: "FUN66",
              timezone: "America/Sao_Paulo",
              status: "active",
            },
          ],
        });
      if (path === brandBase + "/referral-rules" && options.method === "POST") {
        const input = JSON.parse(String(options.body));
        rules = [
          {
            id: "22222222-2222-4222-8222-222222222222",
            platform_id: input.platformId,
            campaign_key: input.campaignKey,
            version: 1,
            status: "draft",
            effective_from: input.effectiveFrom,
            effective_until: input.effectiveUntil,
            inviter_points: "50",
            invitee_points: "20",
            invitee_enabled: input.inviteeEnabled,
          },
        ];
        return response(rules[0]);
      }
      if (path.endsWith("/publish")) {
        rules[0].status = "published";
        return response(rules[0]);
      }
      if (path.endsWith("/disable")) {
        rules[0].status = "disabled";
        return response(rules[0]);
      }
      if (path === brandBase + "/referral-rules")
        return response({ items: rules });
      throw new Error(`Unhandled route ${path}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderCampaigns = (permissions: string[]) =>
  render(
    <ReferralCampaigns
      brandBase={brandBase}
      botBase={botBase}
      permissions={permissions}
      csrf="csrf-safe"
      onExpire={() => {}}
    />,
  );

it("does not request referral configuration without read permission", () => {
  renderCampaigns([]);
  expect(screen.getByText("你没有查看邀请活动的权限。")).toBeTruthy();
  expect(calls).toHaveLength(0);
});

it("previews fixed 50/20 rules, creates a long-lived draft, publishes and disables it", async () => {
  const user = userEvent.setup();
  renderCampaigns([
    "referrals.read",
    "referrals.rules.manage",
    "referrals.rules.publish",
    "platforms.read",
  ]);
  await screen.findByText("暂无邀请活动。");
  await user.click(screen.getByRole("button", { name: "新建邀请活动" }));
  const dialog = screen.getByRole("dialog", { name: "新建邀请活动" });
  await user.selectOptions(within(dialog).getByLabelText("平台"), [
    "11111111-1111-4111-8111-111111111111",
  ]);
  await user.type(within(dialog).getByLabelText("活动标识"), "FUN66-LAUNCH");
  await user.type(within(dialog).getByLabelText("开始日期"), "2026-10-24");
  await user.click(within(dialog).getByLabelText("长期有效"));
  await user.click(
    within(dialog).getByLabelText("合格后同时奖励被邀请人 20 Points"),
  );
  await user.click(within(dialog).getByRole("button", { name: "预览" }));
  const preview = within(dialog).getByTestId("referral-rule-preview");
  expect(preview.textContent).toContain("邀请人 50 Points");
  expect(preview.textContent).toContain("被邀请人 20 Points");
  expect(preview.textContent).toContain("长期有效");
  await user.click(within(preview).getByRole("button", { name: "创建草稿" }));
  await screen.findByText("FUN66-LAUNCH");
  const create = calls.find(
    (call) =>
      call.path === brandBase + "/referral-rules" &&
      call.options.method === "POST",
  )!;
  expect(JSON.parse(String(create.options.body))).toEqual({
    platformId: "11111111-1111-4111-8111-111111111111",
    campaignKey: "FUN66-LAUNCH",
    effectiveFrom: "2026-10-24",
    effectiveUntil: null,
    inviteeEnabled: true,
  });
  expect(create.options.headers).toHaveProperty("X-CSRF-Token", "csrf-safe");
  await user.click(screen.getByRole("button", { name: "发布" }));
  await screen.findByText("邀请活动已发布。");
  await user.click(screen.getByRole("button", { name: "停用" }));
  await screen.findByText("邀请活动已停用。");
  expect(calls.filter((call) => call.path.endsWith("/publish"))).toHaveLength(
    1,
  );
  expect(calls.filter((call) => call.path.endsWith("/disable"))).toHaveLength(
    1,
  );
});

it("keeps rule creation and publishing independently permissioned", async () => {
  rules = [
    {
      id: "22222222-2222-4222-8222-222222222222",
      platform_id: "11111111-1111-4111-8111-111111111111",
      campaign_key: "READ-ONLY",
      version: 1,
      status: "draft",
      effective_from: "2026-10-24",
      effective_until: null,
      inviter_points: "50",
      invitee_points: "20",
      invitee_enabled: false,
    },
  ];
  renderCampaigns(["referrals.read"]);
  await screen.findByText("READ-ONLY");
  expect(screen.queryByRole("button", { name: "新建邀请活动" })).toBeNull();
  expect(screen.queryByRole("button", { name: "发布" })).toBeNull();
  expect(calls.some((call) => call.path.endsWith("/platforms"))).toBe(false);
});
