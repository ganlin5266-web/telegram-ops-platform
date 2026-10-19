import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import RedemptionCentre from "../src/mini/RedemptionCentre";
import { translate, type Locale } from "../src/mini/i18n";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const tier = {
  id: "22222222-2222-4222-8222-222222222222",
  platform_id: "p",
  tier_key: "brl_10",
  name: "BRL 10",
  points_cost: "100",
  face_value: "10",
  face_currency: "BRL",
  display_name: "FUN66",
  redemption_url: "https://example.test/redeem",
  available: 1,
};
it("confirms once, reveals/copies the assigned code and exposes only an https platform jump", async () => {
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.stubGlobal("crypto", {
    randomUUID: () => "33333333-3333-4333-8333-333333333333",
  });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  const client: any = {
    redemptionTiers: vi.fn().mockResolvedValue({ items: [tier] }),
    createRedemption: vi
      .fn()
      .mockResolvedValue({ id: "o", status: "code_assigned" }),
    claimRedemption: vi.fn().mockResolvedValue({
      id: "o",
      status: "code_claimed",
      code: "SAFE-CODE",
      redemptionUrl: tier.redemption_url,
    }),
    redemptionCode: vi.fn(),
  };
  render(
    <RedemptionCentre
      client={client}
      locale={"zh-CN" as Locale}
      t={(k, v) => translate("zh-CN", k, v)}
      onChanged={async () => {}}
    />,
  );
  await screen.findByText(/FUN66/);
  fireEvent.click(screen.getByText("立即兑换"));
  await screen.findByText("SAFE-CODE");
  expect(client.createRedemption).toHaveBeenCalledTimes(1);
  expect(client.claimRedemption).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText("复制兑换码"));
  expect(writeText).toHaveBeenCalledWith("SAFE-CODE");
  expect(
    screen.getByRole("link", { name: "前往游戏平台" }).getAttribute("href"),
  ).toBe(tier.redemption_url);
});

it("recovers an existing order without creating or assigning another code", async () => {
  const client: any = {
    redemptionTiers: vi.fn().mockResolvedValue({ items: [] }),
    createRedemption: vi.fn(),
    claimRedemption: vi.fn(),
    redemptionCode: vi.fn().mockResolvedValue({
      id: "o",
      status: "code_claimed",
      code: "ORIGINAL",
      redemptionUrl: null,
    }),
  };
  render(
    <RedemptionCentre
      client={client}
      locale={"en" as Locale}
      t={(k, v) => translate("en", k, v)}
      onChanged={async () => {}}
      recoverId="o"
    />,
  );
  await screen.findByText("ORIGINAL");
  expect(client.redemptionCode).toHaveBeenCalledWith("o");
  expect(client.createRedemption).not.toHaveBeenCalled();
});
