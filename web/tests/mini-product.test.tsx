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
const fixture = vi.hoisted(() => ({
  profile: {
    displayName: "Ada",
    projectName: "Staging Test Brand",
    botName: "P1 Test Bot",
    uiLanguage: "zh-CN",
    preferredLanguage: null as string | null,
    botLanguage: "zh-CN",
  },
  points: { accountExists: false, balance: null as string | null },
  invitedCount: "0",
  redemptionCount: "0",
  activities: { participationEnabled: false },
}));
vi.mock("../src/mini/client", async (original) => ({
  ...(await original<typeof import("../src/mini/client")>()),
  createClient: () => ({
    connected: true,
    home: async () => fixture,
    page: async () => ({ items: [], nextCursor: null }),
    forget: () => {},
    logout: async () => {},
  }),
}));
import { MiniApp } from "../src/mini/main";
beforeEach(() => {
  fixture.profile.preferredLanguage = null;
  fixture.points = { accountExists: false, balance: null };
});
afterEach(cleanup);
const open = async () => {
  render(<MiniApp />);
  await screen.findByRole("heading", { name: "你好，Ada" });
  return userEvent.setup();
};
const nav = () => within(screen.getByRole("navigation"));
describe("Mini product presentation", () => {
  it("empty/new member sees a clear next action, never a giant missing-account card", async () => {
    await open();
    expect(screen.getByTestId("today-focus").textContent).toContain(
      "等级即将开放",
    );
    expect(screen.queryByText("暂无积分账户")).toBeNull();
    expect(
      within(screen.getByTestId("today-focus")).getByRole("button", {
        name: "会员",
      }),
    ).toBeTruthy();
    expect(screen.getByText("STAGING")).toBeTruthy();
  });
  it("activity templates remain disabled with no invented amount, rules or progress", async () => {
    const u = await open();
    await u.click(nav().getByRole("button", { name: "活动", exact: true }));
    expect(screen.getAllByRole("button", { name: "敬请期待" })).toHaveLength(4);
    expect(
      screen
        .getAllByRole("button", { name: "敬请期待" })
        .every((x) => (x as HTMLButtonElement).disabled),
    ).toBe(true);
    expect(screen.queryByText("查看规则")).toBeNull();
  });
  it("rewards separate points, ledger and real redemption history", async () => {
    const u = await open();
    await u.click(
      screen.getByRole("button", { name: "奖励中心", exact: true }),
    );
    await screen.findByText("还没有积分记录");
    expect(
      (screen.getByRole("button", { name: /兑换中心/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await u.click(
      screen.getByRole("button", { name: "我的兑换", exact: true }),
    );
    await screen.findByText("还没有兑换记录");
  });
  it("invitations show the future journey without a fake sharing link", async () => {
    const u = await open();
    await u.click(
      screen.getByRole("button", { name: "邀请好友", exact: true }),
    );
    await screen.findByText("还没有邀请记录");
    expect(screen.getByText("分享专属入口")).toBeTruthy();
    expect(screen.queryByText("复制邀请链接")).toBeNull();
    expect(screen.getByText("规则尚未发布")).toBeTruthy();
  });
  it("game placeholder cannot grant chances; personal page hides technical names and IDs", async () => {
    const u = await open();
    await u.click(screen.getByRole("button", { name: "小游戏 即将开放" }));
    expect(screen.getByRole("heading", { name: "小游戏" })).toBeTruthy();
    await u.click(nav().getByRole("button", { name: "我的", exact: true }));
    expect(screen.getByText("平台账号")).toBeTruthy();
    expect(screen.getByText("我的权益")).toBeTruthy();
    expect(screen.queryByText("P1 Test Bot")).toBeNull();
    expect(screen.queryByText("Staging Test Brand")).toBeNull();
  });
  it("real device language choice and explicit English fallback, logout retained", async () => {
    const u = await open();
    await u.click(nav().getByRole("button", { name: "我的", exact: true }));
    await u.click(screen.getByRole("button", { name: /语言 简体中文/ }));
    await u.click(screen.getByRole("button", { name: "English", exact: true }));
    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
    expect(localStorage.getItem("mini-ui-language:p1-staging-auth")).toBe("en");
    await u.click(
      screen.getByRole("button", { name: "Filipino", exact: true }),
    );
    expect(
      screen.getByText(
        "Full translation is being prepared. English is shown for now.",
      ),
    ).toBeTruthy();
    await u.click(
      screen.getByRole("button", { name: "Sign out", exact: true }),
    );
    await screen.findByRole("heading", { name: "Signed out safely" });
  });
});

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    clear: () => store.clear(),
  });
});
afterEach(() => vi.unstubAllGlobals());
