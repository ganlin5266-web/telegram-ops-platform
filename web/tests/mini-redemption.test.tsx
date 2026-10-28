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
  canRedeem: true,
  balance: "100",
  pointsGap: "0",
  unavailableReason: null,
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

it("renders backend gap/limit states without arithmetic or inferring eligibility", async () => {
  const client: any = {
    redemptionTiers: async () => ({
      items: [
        {
          ...tier,
          id: "huge",
          points_cost: "9007199254740993",
          balance: "1",
          pointsGap: "9007199254740992",
          canRedeem: false,
          unavailableReason: "insufficient_points",
        },
        {
          ...tier,
          id: "limit",
          canRedeem: false,
          unavailableReason: "daily_redemption_limit",
        },
        {
          ...tier,
          id: "stock",
          canRedeem: false,
          unavailableReason: "inventory_empty",
        },
        { ...tier, id: "unknown", canRedeem: undefined },
      ],
    }),
    createRedemption: vi.fn(),
  };
  render(
    <RedemptionCentre
      client={client}
      locale="en"
      t={(k, v) => translate("en", k, v)}
      onChanged={async () => {}}
    />,
  );
  await screen.findAllByText(/9,007,199,254,740,992/);
  expect(
    screen
      .getAllByRole("button")
      .every((b) => (b as HTMLButtonElement).disabled),
  ).toBe(true);
  expect(client.createRedemption).not.toHaveBeenCalled();
});
it("claim network loss recovers original order without a second debit", async () => {
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  const client: any = {
    redemptionTiers: async () => ({ items: [tier] }),
    createRedemption: vi.fn(async () => ({
      id: "original",
      status: "code_assigned",
    })),
    claimRedemption: vi.fn().mockRejectedValue(new Error("connection lost")),
    redemptionCode: vi.fn(async () => ({
      id: "original",
      status: "code_claimed",
      code: "ORIGINAL",
      redemptionUrl: null,
    })),
  };
  render(
    <RedemptionCentre
      client={client}
      locale="en"
      t={(k, v) => translate("en", k, v)}
      onChanged={async () => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Redeem now" }));
  fireEvent.click(await screen.findByRole("button", { name: "View code" }));
  await screen.findByText("ORIGINAL");
  expect(client.createRedemption).toHaveBeenCalledTimes(1);
  expect(client.claimRedemption).toHaveBeenCalledTimes(1);
  expect(client.redemptionCode).toHaveBeenCalledWith("original");
});
it("rapid duplicate clicks create only one order and one confirmation", async () => {
  const confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  let resolve: any;
  const pending = new Promise((r) => (resolve = r));
  const client: any = {
    redemptionTiers: async () => ({ items: [tier] }),
    createRedemption: vi.fn(() => pending),
    claimRedemption: vi.fn(async () => ({
      id: "o",
      status: "code_claimed",
      code: "ONE",
      redemptionUrl: null,
    })),
  };
  render(
    <RedemptionCentre
      client={client}
      locale="en"
      t={(k, v) => translate("en", k, v)}
      onChanged={async () => {}}
    />,
  );
  const button = await screen.findByRole("button", { name: "Redeem now" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(client.createRedemption).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledTimes(1);
  resolve({ id: "o", status: "code_assigned" });
  await screen.findByText("ONE");
});
it("forbidden catalogue does not masquerade as empty inventory", async () => {
  const { MiniError } = await import("../src/mini/client");
  const client: any = {
    redemptionTiers: vi.fn().mockRejectedValue(new MiniError("forbidden", 403)),
  };
  render(
    <RedemptionCentre
      client={client}
      locale="en"
      t={(k, v) => translate("en", k, v)}
      onChanged={async () => {}}
    />,
  );
  expect((await screen.findByRole("alert")).textContent).toBe(
    translate("en", "forbidden"),
  );
  expect(screen.queryByText(translate("en", "redeemNoTiers"))).toBeNull();
});
it("assigned and claimed remain distinct, and unsafe platform links never render", async () => {
  const client: any = {
    redemptionTiers: async () => ({ items: [] }),
    redemptionCode: async () => ({
      id: "o",
      status: "code_assigned",
      code: "SECRET",
      redemptionUrl: "javascript:alert(1)",
    }),
    claimRedemption: vi.fn(async () => ({
      id: "o",
      status: "code_claimed",
      code: "SECRET",
      redemptionUrl: "javascript:alert(1)",
    })),
  };
  render(
    <RedemptionCentre
      client={client}
      locale="en"
      t={(k, v) => translate("en", k, v)}
      onChanged={async () => {}}
      recoverId="o"
    />,
  );
  await screen.findByText(translate("en", "code_assigned"));
  expect(screen.queryByText("SECRET")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View code" }));
  await screen.findByText("SECRET");
  expect(screen.queryByRole("link")).toBeNull();
  expect(client.claimRedemption).toHaveBeenCalledTimes(1);
});
