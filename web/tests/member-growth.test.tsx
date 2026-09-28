import { afterEach, describe, it, expect, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemberCard } from "../src/mini/MemberCard";
import { MemberAdmin } from "../src/product/MemberAdmin";
import { MemberMetrics } from "../src/product/MemberMetrics";
vi.mock("../src/api", () => ({
  request: vi.fn(),
  json: (b: unknown) => ({ method: "POST", body: JSON.stringify(b) }),
}));
import { request } from "../src/api";
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
describe("Member Batch A UI", () => {
  it("disabled member does not invent LV1 or Growth", () => {
    render(
      <MemberCard
        locale="zh-CN"
        member={{ enabled: false, available: false }}
      />,
    );
    expect(screen.getByText("会员成长尚未启用")).toBeTruthy();
    expect(screen.queryByText(/LV1/)).toBeNull();
  });
  it("enabled member displays protected level, progress and real history", async () => {
    const history = vi
      .fn()
      .mockResolvedValue({
        items: [{ id: "a", business_date: "2026-10-01", delta: "-60" }],
        next: null,
      });
    render(
      <MemberCard
        locale="zh-CN"
        member={{
          enabled: true,
          available: true,
          level: 3,
          levelName: "Gold",
          growth: "1900",
          progress: 0,
          protected: true,
          nextThreshold: "6000",
          todayGrowth: "20",
          dailyCap: 350,
        }}
        history={history}
      />,
    );
    expect(screen.getByText("LV3 · Gold")).toBeTruthy();
    expect(screen.getByText("当前等级受到保护")).toBeTruthy();
    fireEvent.click(screen.getByText("成长记录"));
    await screen.findByText(/-60 Growth/);
    expect(history).toHaveBeenCalledOnce();
  });
  it("max level explicit English fallback without fake next threshold", () => {
    render(
      <MemberCard
        locale="pt-BR"
        member={{
          enabled: true,
          available: true,
          level: 5,
          levelName: "Legend",
          growth: "16000",
          progress: 100,
          nextThreshold: null,
          todayGrowth: "5",
          dailyCap: 350,
        }}
      />,
    );
    expect(
      screen.getByText(
        "Highest level reached. Growth continues to accumulate.",
      ),
    ).toBeTruthy();
  });
  it("checkin refreshes summary and handles failure safely", async () => {
    const checkin = vi.fn().mockRejectedValue(new Error("hidden")),
      refresh = vi.fn();
    render(
      <MemberCard
        locale="en"
        member={{ enabled: true, available: true, level: 1, growth: "0" }}
        checkin={checkin}
        onUpdated={refresh}
      />,
    );
    fireEvent.click(screen.getByText("Daily check-in"));
    await screen.findByRole("alert");
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByText("hidden")).toBeNull();
  });
  it("admin missing schema is an approval state, not fake members", async () => {
    vi.mocked(request).mockResolvedValue({
      schemaReady: false,
      enabled: false,
    });
    render(<MemberAdmin brandId="brand" csrf="test" />);
    await screen.findByText(/等待 Migration 审批/);
    expect(screen.queryByText("暂无初始化会员")).toBeNull();
  });
  it("admin enabled list reads real members", async () => {
    vi.mocked(request).mockImplementation(async (path) =>
      path.endsWith("/status")
        ? { schemaReady: true, enabled: true }
        : ({ items: [{ id: "member-id", level: 2, growth: "500" }] } as any),
    );
    render(<MemberAdmin brandId="brand" csrf="test" />);
    await screen.findByText(/LV2 · 500 Growth/);
  });
  it("unavailable analytics stays unavailable rather than zero", async () => {
    vi.mocked(request).mockResolvedValue({ available: false });
    render(<MemberMetrics brandId="brand" />);
    await screen.findByText("会员指标待接入");
    expect(screen.queryByText("Growth 发放")).toBeNull();
  });
  it("analytics uses server totals and period query", async () => {
    vi.mocked(request).mockResolvedValue({
      available: true,
      timezone: "America/Sao_Paulo",
      members: 2,
      issued: "150",
      net: "90",
      earners: 1,
      upgrades: 1,
      distribution: [
        { level: 1, n: 1 },
        { level: 2, n: 1 },
      ],
    });
    render(<MemberMetrics brandId="brand" />);
    await screen.findByText("150");
    fireEvent.change(screen.getByLabelText("会员统计周期"), {
      target: { value: "month" },
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/LV2：1/)).toBeTruthy();
  });
});
