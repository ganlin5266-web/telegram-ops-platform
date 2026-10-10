import React from "react";
import { it, expect, afterEach } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  within,
} from "@testing-library/react";
import {
  gateMetric,
  perfNeeds,
  redeemableRewards,
  redemptionMode,
  restockTemplate,
  shortfall,
  standardTemplate,
  crossMarketTemplate,
  importBlocked,
  type Platform,
  type Reward,
} from "../src/product/ops/market";
import { PerfBlock, PerfPage } from "../src/product/ops/PrivatePerf";
import {
  Inventory,
  RewardCatalog,
  templateCsv,
} from "../src/product/ops/Inventory";
import Settings, { type SettingsData } from "../src/product/ops/Settings";
import {
  fmt,
  perfKeys,
  type Cell,
  type OpsData,
  type PrivatePerf,
} from "../src/product/ops/model";
afterEach(cleanup);

const v = (x: string): Cell => ({ s: "value", v: x });
const full = {
  registration: "available",
  active: "available",
  firstDeposit: "available",
  deposit: "available",
  withdrawal: "available",
  repeatDeposit: "available",
} as const;

it("capability gate: unavailable → 不适用, pending → 待接入, missing dataset → 数据不完整, never 0", () => {
  expect(gateMetric(v("0"), perfNeeds.netDeposit!, full)).toEqual(v("0"));
  expect(
    gateMetric(v("5"), perfNeeds.repeatRate!, {
      ...full,
      repeatDeposit: "unavailable",
    }),
  ).toEqual({ s: "na" });
  expect(
    gateMetric(v("5"), perfNeeds.repeatRate!, {
      ...full,
      repeatDeposit: "pending",
    }),
  ).toEqual({ s: "pending" });
  expect(
    gateMetric(v("5"), perfNeeds.netDeposit!, full, ["withdrawal"]),
  ).toEqual({ s: "incomplete" });
  expect(
    gateMetric(v("5"), perfNeeds.depositors!, full, ["withdrawal"]),
  ).toEqual(v("5"));
  expect(fmt({ s: "incomplete" })).toBe("数据不完整");
});

const pd = (o: Partial<PrivatePerf> = {}): PrivatePerf => ({
  metrics: {
    returnActive: v("820"),
    depositors: v("0"),
    depositAmount: v("18,400 BRL"),
    repeatDepositors: { s: "pending" },
    repeatRate: { s: "na" },
    netDeposit: { s: "incomplete" },
  },
  freshness: {
    latestBusinessDate: "2026-09-29",
    completeness: "partial",
    note: "缺提款数据",
  },
  trends: {},
  breakdown: [
    { platform: "P1", name: "P1", values: { depositAmount: v("100 BRL") } },
    { platform: "P2", name: "P2", values: { depositAmount: v("200 MXN") } },
  ],
  ...o,
});
const ops = (p: PrivatePerf | null) =>
  ({ privateDomain: p }) as unknown as OpsData;

it("私域成效: 6 frozen metrics with real 0 / 待接入 / 不适用 / 数据不完整; TG-linked wording", () => {
  render(<PerfPage data={ops(pd())} />);
  const cards = screen.getByLabelText("私域关联业绩指标");
  expect(cards.querySelectorAll(".ops-card").length).toBe(perfKeys.length);
  expect(
    within(cards).getByText("充值人数").closest("article")!.textContent,
  ).toContain("0");
  expect(
    within(cards).getByText("复充人数").closest("article")!.textContent,
  ).toContain("待接入");
  expect(
    within(cards).getByText("复充率").closest("article")!.textContent,
  ).toContain("不适用");
  expect(
    within(cards).getByText("充提差").closest("article")!.textContent,
  ).toContain("数据不完整");
  expect(screen.getByRole("status").textContent).toContain("部分缺失");
  expect(document.body.textContent).not.toMatch(/TG 带来|TG创收|ROI/);
});
it("Platform breakdown renders backend rows without a frontend total across currencies", () => {
  render(<PerfPage data={ops(pd())} />);
  const t = screen.getByLabelText("Platform Breakdown");
  expect(t.textContent).toContain("100 BRL");
  expect(t.textContent).toContain("200 MXN");
  expect(t.textContent).not.toMatch(/合计|300/);
  cleanup();
  render(<PerfPage data={ops(pd())} platformName="P1" />);
  expect(screen.queryByLabelText("Platform Breakdown")).toBeNull();
});
it("dashboard block without backend data is 待接入, not fake 0", () => {
  render(<PerfBlock data={ops(null)} />);
  expect(screen.getByText("私域关联业绩待接入")).toBeTruthy();
});

const pl = (code: string, caps?: Platform["capabilities"]): Platform => ({
  code,
  name: code,
  market: "AA",
  currency: "BRL",
  timezone: "UTC",
  status: "active",
  dataStatus: "ready",
  capabilities: caps,
  requiredDatasets: ["user", "deposit", "withdrawal"],
});
const cfg: SettingsData = {
  markets: [
    {
      code: "AA",
      name: "AA",
      currency: "BRL",
      timezone: "UTC",
      status: "active",
    },
  ],
  platforms: [pl("P1", full), pl("P2", { ...full, withdrawal: "pending" })],
  resources: [],
  rewards: [],
  imports: [
    {
      id: "1",
      market: "AA",
      platform: "P1",
      day: "2026-09-29",
      file: "f",
      status: "done",
      rows: "10",
      issues: "0",
      completeness: "complete",
      datasets: { user: true, deposit: true, withdrawal: true },
    },
    {
      id: "2",
      market: "AA",
      platform: "P2",
      day: "2026-09-29",
      file: "f",
      status: "review",
      rows: "5",
      issues: "1",
      completeness: "partial",
      datasets: { user: true, deposit: true, withdrawal: false },
      formatChanged: true,
    },
  ],
};
it("数据接入: complete/partial, required datasets, capability per Platform, format change fail-closed", () => {
  render(
    <Settings
      data={cfg}
      scope={{ market: "AA", platform: "" }}
      onScope={() => {}}
      tab="数据接入"
      onTab={() => {}}
      canEdit
    />,
  );
  expect(screen.getByText("完整")).toBeTruthy();
  expect(screen.getByText("部分缺失")).toBeTruthy();
  expect(screen.getAllByText("提款 ✕").length).toBe(1);
  expect(
    within(screen.getByLabelText("P2 数据能力")).getByText("提款")
      .parentElement!.textContent,
  ).toContain("待接入");
  expect(screen.getByText("数据格式发生变化，需要管理员处理")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/Parser Class|Fingerprint/);
});

const rw = (
  id: string,
  platform: string,
  cost: string,
  stock: Reward["stock"],
  status: Reward["status"] = "active",
): Reward => ({
  id,
  market: "AA",
  platform,
  label: "R$" + cost[0],
  faceValue: cost[0],
  currency: "BRL",
  status,
  cost,
  available: stock === "out" ? "0" : "50",
  assigned: "1",
  used: "1",
  stock,
  uploadedAt: null,
});
const rewards = [
  rw("a", "P1", "100", "ok"),
  rw("b", "P1", "200", "low"),
  rw("c", "P1", "300", "out"),
  rw("d", "P2", "100", "ok"),
  rw("e", "P2", "500", "ok", "disabled"),
];

it("Reward Catalog: face value / currency / Points cost separate; Platform isolated; disabled shown as 已停用", () => {
  render(<RewardCatalog rewards={rewards} market="AA" platform="P2" />);
  const t = screen.getByLabelText("奖励目录");
  expect(t.querySelectorAll("tbody tr").length).toBe(2);
  expect(t.textContent).toContain("已停用");
  expect(t.textContent).toContain("BRL");
  expect(redeemableRewards(rewards, "AA", "P2").map((r) => r.id)).toEqual([
    "d",
  ]);
});
it("redemption: single/multi/no Platform, insufficient Points, out of stock", () => {
  expect(redemptionMode([], [{ platform: "P1", available: true }]).kind).toBe(
    "bind",
  );
  expect(
    redemptionMode(
      [{ platform: "P1", status: "verified" }],
      [
        { platform: "P1", available: true },
        { platform: "P2", available: true },
      ],
    ),
  ).toEqual({ kind: "auto", platform: "P1", available: true });
  expect(
    redemptionMode(
      [
        { platform: "P1", status: "verified" },
        { platform: "P2", status: "verified" },
      ],
      [
        { platform: "P1", available: true },
        { platform: "P2", available: false },
      ],
    ).kind,
  ).toBe("choose");
  expect(shortfall("150", "200")).toBe("50");
  expect(shortfall("520", "200")).toBeNull();
  expect(shortfall(null, "200")).toBeNull();
});
it("inventory: restock needs only code; batch uses standard template; preview shows duplicate & invalid breakdown", () => {
  expect(
    restockTemplate({ market: "AA", platform: "P1", reward: "a" }),
  ).toEqual(["code"]);
  expect(restockTemplate({ market: "AA", platform: "P1" })).toEqual(
    standardTemplate,
  );
  expect(restockTemplate({})).toEqual(crossMarketTemplate);
  render(<Inventory rewards={rewards} market="AA" platform="P1" preview />);
  expect(screen.getByText("库存低")).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "补充库存" })[1]!);
  const dlg = screen.getByRole("dialog", { name: "补充库存" });
  expect(dlg.textContent).toContain("兑换码");
  fireEvent.click(
    within(dlg).getByRole("button", { name: "模拟选择文件（预览）" }),
  );
  expect(dlg.textContent).toContain("文件内重复6");
  fireEvent.click(within(dlg).getByRole("button", { name: "查看问题行" }));
  expect(screen.getByLabelText("问题行（模拟）")).toBeTruthy();
  expect(
    (
      within(dlg).getByRole("button", {
        name: "确认导入（待接入）",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(within(dlg).getByRole("button", { name: "关闭" }));
  fireEvent.click(screen.getByRole("button", { name: "批量导入兑换码" }));
  expect(
    screen.getByRole("dialog", { name: "批量导入兑换码" }).textContent,
  ).toContain("平台代码、奖励面额、币种、积分成本、兑换码");
});

it("inventory supplement: all-platform summary, batch precheck blocks on reward/cost mismatch, template has no market_code", () => {
  expect(standardTemplate).toEqual([
    "platform_code",
    "reward_amount",
    "currency",
    "points_cost",
    "code",
  ]);
  expect(crossMarketTemplate[0]).toBe("market_code");
  expect(
    templateCsv(standardTemplate, [
      "FUN66",
      "5",
      "BRL",
      "500",
      "EXAMPLE_CODE_001",
    ]),
  ).toContain('"FUN66","5","BRL","500","EXAMPLE_CODE_001"');
  expect(importBlocked({ total: 10, importable: 10 })).toEqual([]);
  expect(importBlocked({ rewardMissing: 1, costMismatch: 2 })).toEqual([
    "rewardMissing",
    "costMismatch",
  ]);
  let picked = "";
  render(
    <Inventory
      rewards={rewards}
      market="AA"
      platform=""
      preview
      summary={[
        { platform: "P1", rewards: "3", available: "2,180", low: 1, out: 1 },
      ]}
      batches={[]}
      onPlatform={(id) => (picked = id)}
    />,
  );
  expect(screen.getByText("1 个低库存")).toBeTruthy();
  expect(screen.getByText("1 个缺货")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "查看详情" }));
  expect(picked).toBe("P1");
  fireEvent.click(screen.getByRole("button", { name: "批量导入兑换码" }));
  const dlg = screen.getByRole("dialog", { name: "批量导入兑换码" });
  fireEvent.click(
    within(dlg).getByRole("button", { name: "模拟选择文件（预览）" }),
  );
  expect(dlg.textContent).toContain("未找到对应奖励");
  expect(dlg.textContent).toContain("积分成本与现有奖励不一致");
  expect(
    (
      within(dlg).getByRole("button", {
        name: "确认导入（存在阻断问题）",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
