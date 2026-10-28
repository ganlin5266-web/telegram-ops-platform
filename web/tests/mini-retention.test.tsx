import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MiniApp } from "../src/mini/main";
import { checkinState } from "../src/mini/retention";
import type { Home, MemberSummary } from "../src/mini/client";
const member = (o: Partial<MemberSummary> = {}): MemberSummary => ({
  enabled: true,
  available: true,
  level: 1,
  growth: "5",
  nextThreshold: "500",
  todayCheckedIn: false,
  canCheckin: true,
  checkinStatus: "available",
  actualGrowthEarned: "0",
  businessTimezone: "America/Sao_Paulo",
  ...o,
});
const base = (
  m: MemberSummary = member(),
  extra: Partial<Home> = {},
): Home => ({
  member: m,
  profile: {
    displayName: "Ada",
    projectName: "P",
    botName: "B",
    uiLanguage: "zh-CN",
    preferredLanguage: "zh-CN",
  },
  points: { accountExists: true, balance: "100", expiringSoon: "20" },
  invitedCount: "0",
  redemptionCount: "0",
  activities: { participationEnabled: false },
  primaryAction: { kind: "checkin" },
  ...extra,
});
function client(homes: Home[], items: any[] = []) {
  let i = 0;
  return {
    connected: true,
    home: vi.fn(async () => homes[Math.min(i++, homes.length - 1)]),
    page: vi.fn(async () => ({ items, nextCursor: null })),
    memberHistory: async () => ({ items: [] }),
    memberCheckin: vi.fn(async () => ({})),
    redemptionTiers: async () => ({ items: [] }),
    platforms: async () => ({ items: [] }),
    identities: async () => ({ items: [], nextCursor: null }),
    platformDataStatus: async () => ({ items: [] }),
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function open(c: any) {
  render(<MiniApp client={c} />);
  await screen.findByRole("heading", { name: "你好，Ada" });
  return userEvent.setup();
}
const invite = () =>
  within(screen.getByRole("navigation")).getByRole("button", {
    name: "邀请",
    exact: true,
  });
describe("P0 truthful state and recommended journeys", () => {
  it("renders Points before daily action and only one dominant action", async () => {
    await open(client([base()]));
    const hero = screen.getByTestId("today-focus");
    expect(hero.textContent).toContain("100");
    expect(hero.textContent).toContain("20");
    expect(document.querySelectorAll(".primary-action")).toHaveLength(1);
    expect(
      hero.compareDocumentPosition(screen.getByTestId("checkin-panel")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
  it("reads actual checkin ledger value, never derives it from total Growth delta", async () => {
    const c = client([
      base(),
      base(
        member({
          growth: "80",
          todayCheckedIn: true,
          canCheckin: false,
          checkinStatus: "checked_in",
          actualGrowthEarned: "2",
          nextAvailableAt: "2026-10-30T03:00:00.000Z",
        }),
        { primaryAction: { kind: "view_records" } },
      ),
    ]);
    const u = await open(c);
    await u.click(screen.getByRole("button", { name: "立即签到" }));
    const panel = screen.getByTestId("checkin-panel");
    await within(panel).findByText(/2 Growth/);
    expect(panel.textContent).not.toContain("75 Growth");
    expect(screen.getByTestId("today-focus").textContent).toContain("100");
    expect(panel.textContent).toContain("America/Sao_Paulo");
    expect(c.memberCheckin).toHaveBeenCalledTimes(1);
  });
  it("renders backend checked-in state after reload without a second claim button", async () => {
    await open(
      client([
        base(
          member({
            todayCheckedIn: true,
            canCheckin: false,
            checkinStatus: "checked_in",
            actualGrowthEarned: "0",
          }),
          { primaryAction: { kind: "view_records" } },
        ),
      ]),
    );
    expect(screen.getByTestId("daily-done").textContent).toContain("0 Growth");
    expect(screen.queryByRole("button", { name: "立即签到" })).toBeNull();
  });
  it("cap reached shows real zero and no reward promise", async () => {
    await open(
      client([
        base(member({ canCheckin: false, checkinStatus: "cap_reached" }), {
          primaryAction: { kind: "view_records" },
        }),
      ]),
    );
    expect(screen.getByTestId("checkin-panel").textContent).toMatch(/上限/);
    expect(screen.queryByRole("button", { name: "立即签到" })).toBeNull();
  });
  it("missing state is unavailable; valid new member may explicitly check in", () => {
    expect(checkinState({ enabled: true, available: true })).toBe("pending");
    expect(checkinState(member({ available: false }))).toBe("available");
  });
  it("pending UID uses backend review action, never repeats bind prompt", async () => {
    await open(
      client([
        base(member(), {
          identity: { status: "pending" },
          primaryAction: { kind: "view_identity" },
        }),
      ]),
    );
    expect(
      within(screen.getByTestId("primary-action")).getByRole("button", {
        name: /审核/,
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "去绑定" })).toBeNull();
  });
  it("missing primary action does not invent eligibility", async () => {
    await open(
      client([
        base(member({ canCheckin: false, checkinStatus: "unavailable" }), {
          primaryAction: null,
        }),
      ]),
    );
    expect(screen.queryByTestId("primary-action")).toBeNull();
  });
  it("qualified six is not rewarded five and four record statuses remain distinct", async () => {
    const c = client(
      [
        base(member(), {
          referral: {
            qualifiedToday: "6",
            rewardedToday: "5",
            dailyCap: 5,
            pendingCount: "2",
            pointsEarned: "250",
            activity: {
              inviterPoints: "50",
              inviteePoints: "20",
              inviteeEnabled: true,
            },
            rewardEligible: true,
            shareUrl: "https://t.me/testbot?start=ref_abc",
          },
        }),
      ],
      ["pending", "rewarded", "cap_exceeded", "review_required"].map(
        (displayStatus, i) => ({
          id: String(i),
          created_at: "2026-10-29",
          displayStatus,
        }),
      ),
    );
    const u = await open(c);
    await u.click(invite());
    const hero = screen.getByTestId("invite-hero");
    expect(hero.textContent).toContain("5 / 5");
    expect(hero.textContent).not.toContain("6 / 5");
    expect(hero.textContent).toContain("50 Points");
    expect(hero.textContent).toContain("20 Points");
    for (const text of ["已奖励", "超额不奖励，不顺延", "异常待复核"])
      expect(await screen.findByText(text)).toBeTruthy();
    await u.click(within(hero).getByRole("button", { name: "复制邀请链接" }));
    expect(await navigator.clipboard.readText()).toBe(
      "https://t.me/testbot?start=ref_abc",
    );
  });
  it("disabled rewards retain sharing but hide reward promises", async () => {
    const u = await open(
      client([
        base(member(), {
          referral: {
            activity: {
              inviterPoints: "50",
              inviteePoints: "20",
              inviteeEnabled: true,
            },
            rewardEligible: false,
            rewardAvailability: "disabled",
            shareUrl: "https://t.me/testbot?start=ref_abc",
          },
        }),
      ]),
    );
    await u.click(invite());
    const hero = screen.getByTestId("invite-hero");
    expect(
      within(hero).getByRole("button", { name: "分享给好友" }),
    ).toBeTruthy();
    expect(hero.textContent).not.toContain("50 Points");
    expect(hero.textContent).not.toContain("20 Points");
  });
  it("invitee reward off omits20 and refuses non-Telegram share URL", async () => {
    const u = await open(
      client([
        base(member(), {
          referral: {
            activity: {
              inviterPoints: "50",
              inviteePoints: "20",
              inviteeEnabled: false,
            },
            rewardEligible: true,
            shareUrl: "https://evil.test/?secret=1",
          },
        }),
      ]),
    );
    await u.click(invite());
    const hero = screen.getByTestId("invite-hero");
    expect(hero.textContent).not.toContain("20 Points");
    expect(
      within(hero).getByRole("button", { name: "分享入口即将开放" }),
    ).toHaveProperty("disabled", true);
  });
  it("member_required keeps sharing and offers checkin navigation without an automatic write", async () => {
    const c = client([
      base(member({ available: false }), {
        referral: {
          activity: {
            inviterPoints: "50",
            inviteePoints: "20",
            inviteeEnabled: true,
          },
          rewardEligible: false,
          rewardAvailability: "member_required",
          shareUrl: "https://t.me/testbot?start=ref_abc",
        },
      }),
    ]);
    const u = await open(c);
    await u.click(invite());
    const hero = screen.getByTestId("invite-hero");
    expect(within(hero).getByText("会员资料尚未初始化")).toBeTruthy();
    expect(
      within(hero).getByRole("button", { name: "分享给好友" }),
    ).toBeTruthy();
    expect(hero.textContent).not.toContain("50 Points");
    await u.click(within(hero).getByRole("button", { name: /每日签到/ }));
    expect(screen.getByTestId("checkin-panel")).toBeTruthy();
    expect(c.memberCheckin).not.toHaveBeenCalled();
  });
  it("switching platform requests scoped home and invitation history", async () => {
    const platforms = [
      { id: "p1", displayName: "P1", timezone: "UTC" },
      { id: "p2", displayName: "P2", timezone: "UTC" },
    ];
    const c = client([
      base(member(), { platforms, currentPlatform: platforms[0] }),
      base(member(), { platforms, currentPlatform: platforms[1] }),
    ]);
    const u = await open(c);
    await u.click(invite());
    await u.selectOptions(screen.getByRole("combobox"), "p2");
    expect(c.home).toHaveBeenLastCalledWith("p2");
    expect(c.page).toHaveBeenLastCalledWith("referrals", undefined, "p2");
  });
});
