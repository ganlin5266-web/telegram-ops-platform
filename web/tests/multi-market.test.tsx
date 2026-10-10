import React, { useState } from "react";
import { it, expect, afterEach } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  within,
} from "@testing-library/react";
import {
  botHomeButtons,
  disableBlock,
  inventoryFor,
  marketPlatforms,
  redemptionMode,
  sanitizeScope,
  scopeMarkets,
  setPrimary,
  switchMarket,
  tgOptions,
  type Market,
  type Platform,
  type Reward,
  type TgResource,
} from "../src/product/ops/market";
import { FilterBar } from "../src/product/ops/OpsCenter";
import { User360, type User360Data } from "../src/product/ops/User360";
import { Inventory } from "../src/product/ops/Inventory";
import Settings, {
  type SettingsData,
  type SettingsTab,
} from "../src/product/ops/Settings";
import type { Scope } from "../src/product/ops/model";
afterEach(cleanup);

const mk = (code: string, status: Market["status"] = "active"): Market => ({
  code,
  name: code + "-name",
  currency: "USD",
  timezone: "UTC",
  status,
});
const pl = (
  code: string,
  market: string,
  status: Platform["status"] = "active",
): Platform => ({
  code,
  name: code,
  market,
  currency: "USD",
  timezone: "UTC",
  status,
  dataStatus: "ready",
});
const markets = [mk("AA"), mk("BB"), mk("CC", "archived"), mk("DD", "draft")];
const platforms = [
  pl("P1", "AA"),
  pl("P2", "AA"),
  pl("P3", "AA", "disabled"),
  pl("Q1", "BB"),
  pl("Q2", "BB", "archived"),
];

it("only active Markets / Platforms enter ordinary selectors", () => {
  expect(scopeMarkets(markets).map((m) => m.code)).toEqual(["AA", "BB"]);
  expect(marketPlatforms(platforms, "AA").map((p) => p.code)).toEqual([
    "P1",
    "P2",
  ]);
  expect(marketPlatforms(platforms, "BB").map((p) => p.code)).toEqual(["Q1"]);
});
it("switching Market resets Platform; illegal Market+Platform combos are dropped", () => {
  expect(switchMarket({ market: "AA", platform: "P1" }, "BB")).toEqual({
    market: "BB",
    platform: "",
  });
  expect(
    sanitizeScope({ market: "BB", platform: "P1" }, platforms).platform,
  ).toBe("");
  expect(
    sanitizeScope({ market: "AA", platform: "P3" }, platforms).platform,
  ).toBe(""); // disabled
  expect(
    sanitizeScope({ market: "AA", platform: "P2" }, platforms).platform,
  ).toBe("P2");
});

function Bar() {
  const [s, set] = useState<Scope>({
    period: "day",
    day: "2026-09-29",
    market: "AA",
    platform: "",
  });
  const ps = marketPlatforms(platforms, s.market).map((p) => ({
    id: p.code,
    display_name: p.name,
    market: p.market,
  }));
  return (
    <FilterBar
      scope={s}
      onScope={set}
      platforms={ps}
      markets={scopeMarkets(markets).map((m) => ({
        code: m.code,
        name: m.name,
      }))}
    />
  );
}
it("FilterBar: Market first, Platform filtered by Market and reset on Market change, no Brand/Bot selector", () => {
  render(<Bar />);
  const opts = () =>
    within(screen.getByLabelText("报表平台"))
      .getAllByRole("option")
      .map((o) => o.textContent);
  expect(opts()).toEqual(["全部 Platform", "P1", "P2"]);
  fireEvent.change(screen.getByLabelText("报表平台"), {
    target: { value: "P2" },
  });
  expect(screen.getByText(/当前：AA-name \/ P2/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("报表市场"), {
    target: { value: "BB" },
  });
  expect(opts()).toEqual(["全部 Platform", "Q1"]);
  expect(screen.getByText(/当前：BB-name \/ 全部 Platform/)).toBeTruthy();
  expect(screen.queryByTitle("Brand / Bot")).toBeNull();
});

it("redemption target: 0 → bind, 1 → auto, many → choose (out of stock shown, not auto-switched)", () => {
  const e = [
    { platform: "P1", available: false },
    { platform: "P2", available: true },
  ];
  expect(redemptionMode([], e)).toEqual({ kind: "bind" });
  expect(redemptionMode([{ platform: "P1", status: "pending" }], e)).toEqual({
    kind: "bind",
  });
  expect(redemptionMode([{ platform: "P2", status: "verified" }], e)).toEqual({
    kind: "auto",
    platform: "P2",
    available: true,
  });
  expect(
    redemptionMode(
      [
        { platform: "P1", status: "verified" },
        { platform: "P2", status: "verified" },
      ],
      e,
    ),
  ).toEqual({ kind: "choose", options: e });
  // verified but not backend-eligible → not offered
  expect(redemptionMode([{ platform: "P9", status: "verified" }], e)).toEqual({
    kind: "bind",
  });
});

const rw = (
  id: string,
  platform: string,
  label: string,
  available: string,
  stock: Reward["stock"],
): Reward => ({
  id,
  market: "AA",
  platform,
  label,
  cost: "100",
  available,
  assigned: "0",
  used: "0",
  stock,
  uploadedAt: null,
});
const rewards = [
  rw("a", "P1", "R$1", "820", "ok"),
  rw("b", "P1", "R$3", "0", "out"),
  rw("c", "P2", "R$1", "240", "ok"),
];
it("inventory is isolated per Platform and switches with it", () => {
  expect(inventoryFor(rewards, "AA", "P1").map((r) => r.id)).toEqual([
    "a",
    "b",
  ]);
  expect(inventoryFor(rewards, "BB", "P1")).toEqual([]);
  const { rerender } = render(
    <Inventory rewards={rewards} market="AA" platform="P1" />,
  );
  expect(screen.getByText("820")).toBeTruthy();
  expect(screen.getByText("缺货")).toBeTruthy();
  rerender(<Inventory rewards={rewards} market="AA" platform="P2" />);
  expect(screen.queryByText("820")).toBeNull();
  expect(screen.getByText("240")).toBeTruthy();
  rerender(<Inventory rewards={rewards} market="AA" platform="" />);
  expect(screen.getByText(/平台库存摘要待接入/)).toBeTruthy();
});

const res: TgResource[] = [
  {
    id: "b1",
    kind: "bot",
    market: "AA",
    name: "Main Bot",
    handle: "@m",
    status: "active",
    primary: true,
  },
  {
    id: "b2",
    kind: "bot",
    market: "AA",
    name: "VIP Bot",
    handle: "@v",
    status: "active",
    primary: false,
  },
  {
    id: "c1",
    kind: "channel",
    market: "AA",
    name: "Official",
    handle: "t.me/o",
    status: "configured",
    primary: true,
  },
  {
    id: "c2",
    kind: "channel",
    market: "AA",
    name: "Old",
    handle: "t.me/x",
    status: "disabled",
    primary: false,
  },
  {
    id: "c3",
    kind: "channel",
    market: "BB",
    name: "BB Channel",
    handle: "t.me/b",
    status: "configured",
    primary: true,
  },
];
it("Primary resources, Bot Home buttons, disabled resources excluded", () => {
  expect(tgOptions(res, "AA", "channel").map((r) => r.id)).toEqual(["c1"]);
  expect(botHomeButtons(res, "AA").map((b) => b.label)).toEqual([
    "用户中心",
    "官方频道",
  ]); // no group → hidden
  expect(botHomeButtons(res, "AA")[1]!.target).toBe("Official");
  expect(disableBlock(res[0]!)).toMatch(/请先指定新的 Primary/);
  expect(disableBlock(res[1]!)).toBeNull();
  const next = setPrimary(res, "b2");
  expect(
    next.filter((r) => r.kind === "bot" && r.primary).map((r) => r.id),
  ).toEqual(["b2"]);
  expect(next.find((r) => r.id === "c3")!.primary).toBe(true); // other Market untouched
});

it("User 360 shows one member with multiple Platform identities", () => {
  const user: User360Data = {
    id: "u",
    name: "Multi",
    handle: "@m",
    level: { s: "value", v: "2" },
    growth: { s: "value", v: "10" },
    points: { s: "value", v: "5" },
    platform: "P1",
    lastActive: null,
    status: "active",
    telegramId: "1",
    joinedAt: "2026-01-01",
    market: "AA-name",
    platforms: [
      { name: "P1", status: "verified" },
      { name: "P2", status: "pending" },
      { name: "P3", status: "unbound" },
    ],
    sections: {
      会员: [],
      Growth: [],
      Points: [],
      平台账号: null,
      邀请: null,
      活动: null,
      游戏: null,
    },
  };
  render(<User360 user={user} onBack={() => {}} canAdjust={false} />);
  fireEvent.click(screen.getByRole("tab", { name: "平台账号" }));
  const list = screen.getByLabelText("平台账号");
  expect(within(list).getByText("已认证")).toBeTruthy();
  expect(within(list).getByText("审核中")).toBeTruthy();
  expect(within(list).getByText("未绑定")).toBeTruthy();
  expect(screen.getAllByText("Multi").length).toBe(1);
  expect(screen.getByText("市场 AA-name")).toBeTruthy();
});

function SettingsHarness({ canEdit = true }: { canEdit?: boolean }) {
  const [d, setD] = useState<SettingsData>({
    markets,
    platforms,
    resources: res,
    rewards,
    imports: [],
  });
  const [tab, setTab] = useState<SettingsTab>("Telegram资源");
  const [scope, setScope] = useState({ market: "AA", platform: "" });
  return (
    <Settings
      data={d}
      onData={canEdit ? setD : undefined}
      scope={scope}
      onScope={setScope}
      tab={tab}
      onTab={setTab}
      canEdit={canEdit}
      preview
    />
  );
}
it("Settings: Primary switch shows old/new; disabling a Primary is blocked; read-only without permission", () => {
  render(<SettingsHarness />);
  fireEvent.click(screen.getByRole("button", { name: "设为 Primary" }));
  const dlg = screen.getByRole("dialog", { name: "切换 Primary Bot" });
  expect(within(dlg).getByText("Main Bot")).toBeTruthy();
  expect(within(dlg).getByText("VIP Bot")).toBeTruthy();
  fireEvent.click(within(dlg).getByRole("button", { name: "确认" }));
  fireEvent.click(screen.getAllByRole("button", { name: "停用" })[0]!); // VIP Bot is now Primary and listed first
  expect(screen.getByRole("dialog", { name: /无法停用 VIP Bot/ })).toBeTruthy();
  cleanup();
  render(<SettingsHarness canEdit={false} />);
  expect(screen.getByText(/没有高级配置权限/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /新增/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "设为 Primary" })).toBeNull();
});
it("Settings: archived Markets hidden by default; no permanent delete action", () => {
  render(<SettingsHarness />);
  fireEvent.click(screen.getByRole("tab", { name: "国家与市场" }));
  expect(screen.queryByText("CC-name (CC)")).toBeNull();
  expect(screen.getByText("DD-name (DD)")).toBeTruthy();
  expect(screen.queryByText(/永久删除|删除/)).toBeNull();
  fireEvent.click(screen.getByLabelText(/显示已归档/));
  expect(screen.getByText("CC-name (CC)")).toBeTruthy();
});
