import React from "react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MiniApp } from "../src/mini/main";
import { translate } from "../src/mini/i18n";
const home = {
  profile: {
    displayName: "Ada",
    projectName: "Private Brand",
    botName: "Private Bot",
    uiLanguage: "zh-CN",
    preferredLanguage: "zh-CN",
  },
  points: { accountExists: false, balance: null },
  invitedCount: "0",
  redemptionCount: "0",
  activities: { participationEnabled: false },
  primaryAction: { kind: "bind_uid" },
};
const client = () =>
  ({
    connected: true,
    home: async () => home,
    page: async () => ({ items: [], nextCursor: null }),
    redemptionTiers: async () => ({ items: [] }),
    forget: () => {},
    logout: vi.fn(async () => {}),
    memberHistory: async () => ({ items: [] }),
  }) as any;
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function open(c = client()) {
  render(<MiniApp client={c} />);
  await screen.findByRole("heading", { name: "你好，Ada" });
  return userEvent.setup();
}
const nav = () => within(screen.getByRole("navigation"));
describe("P0 product layout", () => {
  it("four destinations, no unfinished activities/games/benefits", async () => {
    await open();
    expect(
      nav()
        .getAllByRole("button")
        .map((x) => x.textContent),
    ).toEqual(["首页", "奖励", "邀请", "我的"]);
    expect(screen.queryByText("小游戏")).toBeNull();
    expect(screen.queryByText("活动即将上线")).toBeNull();
    expect(screen.queryByText("我的权益")).toBeNull();
  });
  it("new user has one backend-selected bind action, no invented balance", async () => {
    await open();
    expect(screen.getByTestId("today-focus").textContent).not.toContain(
      "0 Points",
    );
    expect(
      within(screen.getByTestId("primary-action")).getByRole("button", {
        name: "去绑定",
      }),
    ).toBeTruthy();
    expect(screen.getByTestId("today-focus").textContent).not.toContain("LV1");
  });
  it("rewards default to catalogue/orders and ledger remains accessible", async () => {
    const u = await open();
    await u.click(nav().getByRole("button", { name: "奖励", exact: true }));
    await screen.findByText("当前没有可兑换档位。");
    expect(screen.getByRole("heading", { name: "兑换中心" })).toBeTruthy();
    await u.click(
      screen.getByRole("button", { name: "积分明细", exact: true }),
    );
    await screen.findByText("还没有积分记录");
  });
  it("invite absent summary has no fake link or reward", async () => {
    const u = await open();
    await u.click(nav().getByRole("button", { name: "邀请", exact: true }));
    await screen.findByText("还没有邀请记录");
    expect(screen.queryByRole("button", { name: "复制邀请链接" })).toBeNull();
    expect(screen.getByTestId("invite-hero").textContent).not.toContain("50");
  });
  it("member details moved to me and sensitive scope names stay hidden", async () => {
    const u = await open();
    await u.click(nav().getByRole("button", { name: "我的", exact: true }));
    expect(screen.getByRole("button", { name: /会员 · Growth/ })).toBeTruthy();
    expect(screen.queryByText("Private Brand")).toBeNull();
    expect(screen.queryByText("Private Bot")).toBeNull();
    await u.click(screen.getByRole("button", { name: /会员 · Growth/ }));
    expect(await screen.findByText("会员成长尚未启用")).toBeTruthy();
  });
  it("device language selection has genuine Filipino, secure logout retained", async () => {
    const c = client(),
      u = await open(c);
    await u.click(nav().getByRole("button", { name: "我的", exact: true }));
    await u.click(screen.getByRole("button", { name: /语言 简体中文/ }));
    await u.click(
      screen.getByRole("button", { name: "Filipino", exact: true }),
    );
    await waitFor(() => expect(document.documentElement.lang).toBe("fil"));
    expect(localStorage.getItem("mini-ui-language:telegram-mini-ui")).toBe(
      "fil",
    );
    expect(screen.queryByText(/Full translation is being prepared/)).toBeNull();
    await u.click(
      screen.getByRole("button", {
        name: translate("fil", "logout"),
        exact: true,
      }),
    );
    expect(c.logout).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("heading", {
        name: translate("fil", "loggedOut"),
      }),
    ).toBeTruthy();
  });
});
