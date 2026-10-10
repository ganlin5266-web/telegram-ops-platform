import React, { useState } from "react";
import { it, expect, afterEach, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  within,
} from "@testing-library/react";
import {
  AdminSidebar,
  domainOf,
  domains,
  type Domain,
} from "../src/product/ops/nav";
import OpsCenter, { funnelDrop } from "../src/product/ops/OpsCenter";
import { User360, type User360Data } from "../src/product/ops/User360";
import MemberOps from "../src/product/ops/MemberOps";
import type { Cell, OpsData, Scope } from "../src/product/ops/model";
afterEach(cleanup);

const v = (n: number | string): Cell => ({ s: "value", v: String(n) });
const P: Cell = { s: "pending" };
function data(over: Partial<OpsData> = {}): OpsData {
  return {
    timezone: "America/Sao_Paulo",
    updatedAt: null,
    realtime: false,
    metrics: {
      totalUsers: v(100),
      newUsers: v(0),
      activeUsers: P,
      boundUsers: v(10),
      members: v(5),
      upgrades: v(0),
      growthIssued: v(1),
      growthEarners: v(1),
      pointsCredit: v(1),
      pointsDebit: v(1),
      qualifiedInvites: P,
      pendingTotal: P,
    },
    trends: {},
    pending: null,
    growth: {
      issued: v(1),
      earners: v(1),
      net: v(1),
      upgrades: v(0),
      theoretical: P,
      actual: P,
      correction: P,
      dailyCap: P,
      sources: { platform: P, referral: P, task: P, checkin: P },
    },
    levels: null,
    points: {
      credit: P,
      debit: P,
      issued: P,
      spent: P,
      expired: P,
      redeemed: P,
      outstanding: P,
    },
    funnel: {
      initiated: v(100),
      registered: v(70),
      bound: v(50),
      qualified: v(30),
      rewarded: v(30),
    },
    referral: {
      inviters: P,
      invitedUsers: P,
      qualified: P,
      qualifiedRate: P,
      growthReward: P,
    },
    retention: null,
    retentionDefinition: null,
    ...over,
  };
}
function Ops({
  d,
  mode = "overview" as const,
  nav,
}: {
  d: OpsData;
  mode?: "overview" | "data";
  nav?: (t: string) => void;
}) {
  const [scope, setScope] = useState<Scope>({
    period: "day",
    day: "2026-09-29",
    platform: "",
    market: "",
  });
  return (
    <OpsCenter
      data={d}
      scope={scope}
      onScope={setScope}
      platforms={[]}
      scopeLabel={{ brand: "B", bot: "T" }}
      mode={mode}
      onNavigate={nav}
    />
  );
}

it("sidebar: 9 frozen domains, active state, badge only when > 0, legacy pages map to their domain", () => {
  const sel = vi.fn();
  render(
    <AdminSidebar
      active="users"
      onSelect={sel}
      mode="full"
      onToggle={() => {}}
      brand="FUN Club"
      env="STAGING"
      badges={{ users: 12, data: 0 }}
    />,
  );
  const nav = within(screen.getByRole("navigation", { name: "一级导航" }));
  expect(
    nav
      .getAllByRole("button")
      .map((b) => b.querySelector(".adm-label")!.textContent),
  ).toEqual([
    "总览",
    "用户",
    "会员",
    "内容",
    "活动",
    "积分",
    "游戏",
    "数据",
    "设置",
  ]);
  expect(
    nav.getByRole("button", { name: /^用户/ }).getAttribute("aria-current"),
  ).toBe("page");
  expect(screen.getByLabelText("12 项待处理")).toBeTruthy();
  expect(document.querySelectorAll(".adm-badge").length).toBe(1);
  expect(screen.getByText("STAGING")).toBeTruthy();
  fireEvent.click(nav.getByRole("button", { name: "内容" }));
  expect(sel).toHaveBeenCalledWith("content");
  expect(domainOf("identities")).toBe("users");
  expect(domainOf("entitlements")).toBe("membership");
  expect(domainOf("point-expiry")).toBe("points");
  expect(domainOf("daily-data")).toBe("data");
  expect(domainOf("platforms")).toBe("settings");
  expect(domains.length).toBe(9);
});
it("sidebar rail keeps accessible names and toggles", () => {
  const t = vi.fn();
  render(
    <AdminSidebar
      active={"data" as Domain}
      onSelect={() => {}}
      mode="rail"
      onToggle={t}
      brand="B"
    />,
  );
  expect(document.querySelector(".adm-side")!.getAttribute("data-mode")).toBe(
    "rail",
  );
  expect(
    screen.getByRole("button", { name: "数据" }).getAttribute("title"),
  ).toBe("数据");
  fireEvent.click(screen.getByRole("button", { name: "展开导航" }));
  expect(t).toHaveBeenCalled();
});
it("dashboard: 4 blocks (规模/私域成效/投入/待处理), real 0 vs 待接入, no quick actions", () => {
  render(<Ops d={data()} />);
  const core = screen.getByLabelText("核心指标");
  expect(core.querySelectorAll(".ops-card").length).toBe(4);
  for (const h of ["私域规模", "私域关联业绩", "运营投入", "待处理"])
    expect(screen.getByRole("heading", { name: new RegExp(h) })).toBeTruthy();
  expect(screen.getByText("私域关联业绩待接入")).toBeTruthy();
  expect(screen.queryByText("裂变漏斗")).toBeNull();
  expect(
    within(core).getByText("新增用户").closest("article")!.textContent,
  ).toContain("0");
  expect(
    within(core).getByText("活跃用户").closest("article")!.textContent,
  ).toContain("待接入");
  expect(screen.getByLabelText("辅助指标")).toBeTruthy();
  expect(screen.queryByText("快速操作")).toBeNull();
  expect(
    screen.getByText("待处理聚合待接入：后端尚未提供跨模块待办数量"),
  ).toBeTruthy();
});
it("pending: empty list is a calm real-zero state", () => {
  render(<Ops d={data({ pending: [] })} />);
  expect(screen.getByText("当前无待处理事项")).toBeTruthy();
});
it("referral funnel highlights the lowest adjacent conversion (Preview 100→70→50→30→30)", () => {
  expect(funnelDrop(data().funnel)).toEqual({
    index: 3,
    from: "平台绑定",
    to: "有效邀请",
    rate: "60.0%",
  });
  render(<Ops d={data()} mode="data" />);
  fireEvent.click(screen.getByRole("tab", { name: "裂变" }));
  expect(screen.getByRole("status").textContent).toContain(
    "平台绑定 → 有效邀请",
  );
  expect(document.querySelector(".ops-funnel li.drop")!.textContent).toContain(
    "有效邀请",
  );
  expect(funnelDrop({ ...data().funnel, bound: P })).toBeNull();
});
it("retention: D1/D3/D7 top cards + breakdown; pending never shows fake 0", () => {
  const d = data({
    retention: [
      { segment: "整体留存", d1: v("41.2%"), d3: v("28.5%"), d7: v("0%") },
      { segment: "会员留存", d1: v("58.4%"), d3: v("44.0%"), d7: v("33.1%") },
    ],
  });
  const { unmount } = render(<Ops d={d} mode="data" />);
  fireEvent.click(screen.getByRole("tab", { name: "留存" }));
  const top = screen.getByLabelText("核心留存");
  expect(top.textContent).toContain("41.2%");
  expect(top.textContent).toContain("0%");
  expect(screen.getByText("会员留存")).toBeTruthy();
  unmount();
  render(<Ops d={data()} mode="data" />);
  fireEvent.click(screen.getByRole("tab", { name: "留存" }));
  expect(screen.getByText("留存数据待接入")).toBeTruthy();
  expect(screen.queryByLabelText("核心留存")).toBeNull();
});
it("period switch updates the shared context for every module", () => {
  render(<Ops d={data()} />);
  fireEvent.click(screen.getByRole("button", { name: "周" }));
  expect(screen.getByText(/周一至周日 · 2026-09-28 → 2026-10-04/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "月" }));
  expect(screen.getByText(/自然月 · 2026-09-01 → 2026-09-30/)).toBeTruthy();
});
it("dashboard analysis links route to data sub-domains", () => {
  const nav = vi.fn();
  render(<Ops d={data()} nav={nav} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Growth / Points 分析 →" }),
  );
  expect(nav).toHaveBeenCalledWith("data:Growth");
});
const user: User360Data = {
  id: "u",
  name: "预览用户",
  handle: "@p",
  level: v(3),
  growth: v(2180),
  points: v(12400),
  platform: "Plat",
  platformStatus: "conflict",
  lastActive: "今天",
  status: "active",
  telegramId: "T",
  joinedAt: "2026-01-01",
  sections: {
    会员: null,
    Growth: null,
    Points: null,
    平台账号: null,
    邀请: null,
    活动: null,
    游戏: null,
  },
  advanced: [["Request ID", "req-1"]],
};
it("User 360: Level/Growth/Points first, friendly platform status, advanced folded, preview adjust never submits", () => {
  const f = vi.fn();
  vi.stubGlobal("fetch", f);
  render(<User360 user={user} onBack={() => {}} canAdjust preview />);
  const val = screen.getByLabelText("会员经济状态");
  expect(val.textContent).toContain("LV3");
  expect(val.textContent).toContain("2,180");
  expect(val.textContent).toContain("12,400");
  expect(screen.getByText(/账号冲突/)).toBeTruthy();
  expect(
    (
      screen
        .getByText("高级诊断 · 仅管理员")
        .closest("details") as HTMLDetailsElement
    ).open,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "调整 Growth" }));
  fireEvent.change(screen.getByLabelText("调整值"), {
    target: { value: "50" },
  });
  expect(screen.getByRole("dialog").textContent).toContain("2,230");
  fireEvent.change(screen.getByLabelText("调整原因"), {
    target: { value: "测试" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview 模拟确认" }));
  expect(f).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
it("Member Operations: defaults to 会员用户, ladder LV1–LV5, rules table, benefits not active", () => {
  render(
    <MemberOps
      data={{
        members: [],
        benefitsAvailable: false,
        levels: [5, 1, 3, 2, 4].map((l) => ({
          level: l,
          name: null,
          threshold: String(l * 100),
        })),
        rules: [
          {
            action: "每日签到",
            condition: "每日 1 次",
            growth: "+5 Growth",
            status: "published",
          },
        ],
      }}
    />,
  );
  expect(
    screen.getByRole("tab", { name: "会员用户" }).getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: "等级设置" }));
  expect(
    [...document.querySelectorAll(".ops-ladder b")].map((b) => b.textContent),
  ).toEqual(["LV1", "LV2", "LV3", "LV4", "LV5"]);
  fireEvent.click(screen.getByRole("tab", { name: "Growth 规则" }));
  expect(screen.getByText("已发布 · 只读")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "权益设置" }));
  expect(screen.getAllByText("未生效").length).toBe(20);
});
