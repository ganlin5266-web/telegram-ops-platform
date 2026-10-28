import { afterEach, describe, it, expect, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemberCard, CheckinAction } from "../src/mini/MemberCard";
import { translate } from "../src/mini/i18n";
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
    const history = vi.fn().mockResolvedValue({
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
    expect(screen.getByText("你的会员等级已保留")).toBeTruthy();
    fireEvent.click(screen.getByText(translate("zh-CN", "p0GrowthHistory")));
    await screen.findByText(/-60 Growth/);
    expect(history).toHaveBeenCalledOnce();
  });
  it("max level localized Portuguese without fake next threshold", () => {
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
    expect(screen.getByText(translate("pt-BR", "p0HighestLevel"))).toBeTruthy();
  });
  it("checkin refreshes summary and handles failure safely", async () => {
    const checkin = vi.fn().mockRejectedValue(new Error("hidden")),
      refresh = vi.fn();
    render(
      <CheckinAction
        locale="en"
        checkin={checkin}
        onUpdated={refresh}
        title="Check in today"
        body="b"
      />,
    );
    fireEvent.click(screen.getByText(translate("en", "p0CheckinGrowth")));
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
