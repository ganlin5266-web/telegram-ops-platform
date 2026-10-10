import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MiniApp } from "../src/mini/main";
import type { Home, MemberSummary } from "../src/mini/client";

const base = (member: MemberSummary, extra: Partial<Home> = {}): Home => ({
  member,
  profile: {
    displayName: "Ada",
    projectName: "P",
    botName: "B",
    uiLanguage: "zh-CN",
    preferredLanguage: "zh-CN",
    botLanguage: "zh-CN",
  },
  points: { accountExists: true, balance: "100", expiringSoon: "20" },
  invitedCount: "0",
  redemptionCount: "0",
  activities: { participationEnabled: false },
  ...extra,
});
const m = (o: Partial<MemberSummary> = {}): MemberSummary => ({
  enabled: true,
  available: true,
  level: 1,
  levelName: "L1",
  growth: "5",
  progress: 1,
  nextThreshold: "500",
  todayGrowth: "0",
  ...o,
});
function client(homes: Home[], pageItems: any[] = []) {
  let i = 0;
  return {
    connected: true,
    connect: async () => {},
    home: vi.fn(async () => homes[Math.min(i++, homes.length - 1)]),
    page: vi.fn(async () => ({ items: pageItems, nextCursor: null })),
    memberHistory: async () => ({ items: [], next: null }),
    memberCheckin: vi.fn(async () => ({})),
    platforms: async () => ({ items: [] }),
    forget: () => {},
    logout: async () => {},
  } as any;
}
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
const open = async (c: any) => {
  render(<MiniApp client={c} />);
  await screen.findByRole("heading", { name: "你好，Ada" });
  return userEvent.setup();
};

describe("Phase 2 retention", () => {
  it("not checked in: check-in, feedback with real Growth change and next action", async () => {
    const c = client([base(m()), base(m({ growth: "10" }))]);
    const u = await open(c);
    await u.click(screen.getByRole("button", { name: "立即签到" }));
    const fb = await screen.findByRole("status");
    expect(fb.textContent).toContain("+5 Growth");
    expect(fb.textContent).toContain("Growth 5 → 10");
    expect(fb.textContent).toContain("还差 490 Growth 升级 LV2");
    expect(
      within(fb).getByRole("button", { name: "邀请好友继续赚 Growth" }),
    ).toBeTruthy();
  });
  it("checked in (backend field): daily done, no clickable check-in", async () => {
    await open(client([base(m({ todayCheckedIn: true }))]));
    expect(screen.getByTestId("daily-done").textContent).toContain(
      "今日已签到 ✓",
    );
    expect(screen.queryByRole("button", { name: "立即签到" })).toBeNull();
  });
  it("pending check-in status shows confirming state", async () => {
    await open(client([base(m({ todayCheckinAvailable: false }))]));
    expect(screen.getByText("签到状态确认中")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "立即签到" })).toBeNull();
  });
  it("near level-up emphasises gap and links to Growth Ways", async () => {
    const u = await open(client([base(m({ growth: "460" }))]));
    expect(screen.getByText("还差 40 Growth 升级 LV2")).toBeTruthy();
    await u.click(screen.getByRole("button", { name: "去赚 Growth" }));
    expect(await screen.findByTestId("growth-ways")).toBeTruthy();
  });
  it("level-up feedback only from backend level change", async () => {
    const c = client([
      base(m({ growth: "495" })),
      base(m({ growth: "500", level: 2, nextThreshold: "2000" })),
    ]);
    const u = await open(c);
    await u.click(screen.getByRole("button", { name: "立即签到" }));
    expect(await screen.findByText("恭喜升级到 LV2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "查看会员权益" })).toBeTruthy();
  });
  it("Growth Ways ordered by state; completed check-in grouped as done", async () => {
    const u = await open(client([base(m({ todayCheckedIn: true }))]));
    await u.click(
      within(screen.getByRole("navigation")).getByRole("button", {
        name: "会员",
        exact: true,
      }),
    );
    const ways = await screen.findByTestId("growth-ways");
    const groups = [...ways.querySelectorAll("h3")].map((h) => h.textContent);
    expect(groups[0]).toBe("当前最值得做");
    expect(groups).toContain("今日已完成");
    expect(
      ways.querySelector('.way-group.done [data-way="checkin"]'),
    ).toBeTruthy();
  });
  it("0 invites: no fake share link, stats hidden with pending note, five distinct steps", async () => {
    const u = await open(client([base(m())]));
    await u.click(screen.getByRole("button", { name: /邀请好友/ }));
    const hero = await screen.findByTestId("invite-hero");
    expect(
      within(hero).getByRole("button", { name: "分享入口即将开放" }),
    ).toHaveProperty("disabled", true);
    expect(hero.textContent).not.toContain("—");
    expect(within(hero).getByTestId("referral-pending").textContent).toBe(
      "邀请统计待后端开放",
    );
    expect(
      screen.getByText("分享不等于有效邀请，好友达标后才计入。"),
    ).toBeTruthy();
    for (const s of [
      "好友注册",
      "好友绑定平台账号",
      "好友达到有效条件",
      "奖励发放",
    ])
      expect(screen.getByText(s)).toBeTruthy();
  });
  it("invites with backend summary: progress, qualified/pending/rewarded states, safe names", async () => {
    const c = client(
      [
        base(m(), {
          invitedCount: "4",
          referral: {
            qualifiedToday: "3",
            dailyRewardLimit: "5",
            growthEarned: "150",
            remainingRewardChances: "2",
            qualifiedTotal: "3",
            shareUrl: "https://t.me/bot?start=ref",
          },
        }),
      ],
      [
        { id: "r1", created_at: "2026-09-01T00:00:00Z", status: "bound" },
        {
          id: "r2",
          created_at: "2026-09-02T00:00:00Z",
          status: "qualified",
          reward_status: "rewarded",
        },
      ],
    );
    const u = await open(c);
    await u.click(screen.getByRole("button", { name: /邀请好友/ }));
    const hero = await screen.findByTestId("invite-hero");
    expect(hero.textContent).toContain("3 / 5");
    expect(hero.textContent).toContain("150");
    expect(within(hero).getByRole("button", { name: "邀请好友" })).toBeTruthy();
    await screen.findByText("好友 1");
    expect(screen.getByText("已绑定")).toBeTruthy();
    expect(screen.getByText("已奖励")).toBeTruthy();
  });
  it("points expiring stays on home", async () => {
    await open(client([base(m())]));
    expect(screen.getByLabelText("我的积分").textContent).toContain("20");
  });
});
