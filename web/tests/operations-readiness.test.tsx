import { ApiError } from "../src/api";
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BotContent, { type ContentState } from "../src/operations/BotContent";

const base = "/v1/brands/brand/bots/bot";
const copy = {
  newUser: "Welcome",
  returningUser: "Welcome back",
  openLabel: "Open rewards",
  inviteLabel: "Invite",
  supportLabel: "Support",
};
function fixture(): ContentState {
  return {
    draft: {
      locales: {
        "zh-CN": { ...copy },
        en: { ...copy },
        "pt-BR": { ...copy },
        "es-MX": { ...copy },
        fil: { ...copy },
      },
      supportUrl: null,
    },
    draftVersion: 0,
    published: null,
    publishedVersion: 0,
    enabled: false,
    miniUrl: "https://mini.example.test/mini.html",
  };
}
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
let state: ContentState;
let calls: Array<{ path: string; options: RequestInit }>;
let failAction: string;
let failStatus: number;
beforeEach(() => {
  state = fixture();
  calls = [];
  failAction = "";
  failStatus = 409;
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit) => {
      calls.push({ path, options });
      if (failAction && path.endsWith(failAction)) {
        if (failStatus === 0) throw new Error("Offline");
        return response({ error: "operation_conflict" }, failStatus);
      }
      const body = options.body ? JSON.parse(String(options.body)) : {};
      if (path.endsWith("/draft")) {
        state.draft = body.config;
        state.draftVersion++;
      }
      if (path.endsWith("/preview"))
        return response({
          text: body.config.locales[body.language][
            body.audience === "new" ? "newUser" : "returningUser"
          ],
          buttons: [{ text: "Open rewards", web_app: { url: state.miniUrl } }],
          deliveryConfirmed: false,
        });
      if (path.endsWith("/publish")) {
        state.published = state.draft;
        state.publishedVersion++;
        state.enabled = true;
      }
      if (path.endsWith("/disable")) state.enabled = false;
      return response(state);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const props = {
  base,
  permissions: ["messages.publish"],
  csrf: "csrf-safe",
  onExpire: vi.fn(),
};

it("requests no content without independent permission", () => {
  render(<BotContent {...props} permissions={[]} />);
  expect(screen.getByText("你没有管理 Bot 内容的权限。")).toBeTruthy();
  expect(calls).toHaveLength(0);
});

it("saves versioned draft, previews without sending, publishes and disables", async () => {
  const user = userEvent.setup();
  render(<BotContent {...props} />);
  const input = await screen.findByLabelText("新用户欢迎语");
  await user.clear(input);
  await user.type(input, "新人欢迎");
  expect(
    (screen.getByRole("button", { name: "发布内容" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText("草稿已保存，请预览后发布。");
  await user.click(screen.getByRole("button", { name: "手机预览" }));
  await waitFor(() =>
    expect(screen.getByLabelText("手机预览").textContent).toContain("新人欢迎"),
  );
  await user.click(screen.getByRole("button", { name: "发布内容" }));
  await screen.findByText("内容已发布。请用测试账号从 Bot 进入验证实际显示。");
  await user.click(screen.getByRole("button", { name: "停用内容" }));
  await screen.findByText("内容已停用。");
  const draft = calls.find((c) => c.path.endsWith("/draft"))!;
  expect(JSON.parse(String(draft.options.body)).expectedVersion).toBe(0);
  expect(draft.options.headers).toHaveProperty("X-CSRF-Token", "csrf-safe");
  expect(
    JSON.parse(
      String(calls.find((c) => c.path.endsWith("/publish"))!.options.body),
    ),
  ).toEqual({ expectedVersion: 1 });
  expect(calls.some((c) => /telegram|sendMessage/.test(c.path))).toBe(false);
});

it("invalidates preview on edits and language/audience changes", async () => {
  const user = userEvent.setup();
  render(<BotContent {...props} />);
  await screen.findByLabelText("新用户欢迎语");
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText("草稿已保存，请预览后发布。");
  await user.click(screen.getByRole("button", { name: "手机预览" }));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "发布内容" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  await user.type(screen.getByLabelText("主按钮文案"), "!");
  expect(
    (screen.getByRole("button", { name: "发布内容" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.selectOptions(screen.getByLabelText("内容语言"), "fil");
  expect(
    (screen.getByLabelText("新用户欢迎语") as HTMLTextAreaElement).value,
  ).toBe("Welcome");
  await user.selectOptions(screen.getByLabelText("预览用户"), "returning");
  await user.click(screen.getByRole("button", { name: "手机预览" }));
  await waitFor(() =>
    expect(screen.getByLabelText("手机预览").textContent).toContain(
      "Welcome back",
    ),
  );
  expect(
    (screen.getByRole("button", { name: "发布内容" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it.each([
  [403, "你没有权限执行此操作"],
  [409, "操作冲突，请刷新后重试"],
  [0, "网络连接失败，请检查网络后重试"],
])("does not report save success after %s", async (status, text) => {
  const user = userEvent.setup();
  render(<BotContent {...props} />);
  await user.type(await screen.findByLabelText("新用户欢迎语"), "!");
  failAction = "/draft";
  failStatus = Number(status);
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  expect((await screen.findByRole("alert")).textContent).toBe(text);
  expect(screen.queryByText("草稿已保存，请预览后发布。")).toBeNull();
});

it("discards old scope responses after switching Bot", async () => {
  let resolveOld!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string) =>
      path.startsWith(base + "/")
        ? new Promise<Response>((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(response(fixture())),
    ),
  );
  const view = render(<BotContent {...props} />);
  view.rerender(<BotContent {...props} base="/v1/brands/other/bots/other" />);
  await screen.findByLabelText("新用户欢迎语");
  const old = fixture();
  old.draft.locales["zh-CN"].newUser = "OLD SCOPE SECRET";
  await act(async () => resolveOld(response(old)));
  expect(
    (screen.getByLabelText("新用户欢迎语") as HTMLTextAreaElement).value,
  ).toBe("Welcome");
  expect(screen.queryByText("OLD SCOPE SECRET")).toBeNull();
});

it("removes loaded content when permission is revoked", async () => {
  const view = render(<BotContent {...props} />);
  await screen.findByLabelText("新用户欢迎语");
  view.rerender(<BotContent {...props} permissions={[]} />);
  expect(screen.queryByLabelText("新用户欢迎语")).toBeNull();
  expect(calls).toHaveLength(1);
});

import OperationsMetrics, {
  type OperationsSummary,
} from "../src/operations/OperationsMetrics";
function metricFixture(): OperationsSummary {
  return {
    window: {
      start: "2026-10-22T00:00:00Z",
      end: "2026-10-29T00:00:00Z",
      timezone: "UTC",
      days: 7,
    },
    notAFunnel: true,
    metrics: [
      {
        key: "mini_participants",
        label: "Mini",
        status: "ok",
        value: "0",
        unit: "users",
        definition: "auth",
      },
      {
        key: "uid_verified",
        label: "UID",
        status: "forbidden",
        value: null,
        unit: "events",
        definition: "uid",
      },
      {
        key: "checkins",
        label: "Checkins",
        status: "pending_collection",
        value: null,
        unit: "events",
        definition: "missing scope",
      },
      {
        key: "reward_points",
        label: "Points",
        status: "ok",
        value: "9007199254740993",
        unit: "points",
        definition: "ledger",
      },
    ],
  };
}
it("requests no metrics without dashboard permission", () => {
  render(<OperationsMetrics {...props} permissions={[]} />);
  expect(screen.getByText("你没有查看运营数据的权限。")).toBeTruthy();
  expect(calls).toHaveLength(0);
});
it("preserves exact counts and distinguishes forbidden, pending collection and true zero", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response(metricFixture())),
  );
  render(<OperationsMetrics {...props} permissions={["dashboard.read"]} />);
  await screen.findByText("9007199254740993");
  expect(
    screen.getByTestId("operation-metric-mini_participants").textContent,
  ).toContain("0");
  expect(
    screen.getByTestId("operation-metric-uid_verified").textContent,
  ).toContain("无权限");
  expect(screen.getByTestId("operation-metric-checkins").textContent).toContain(
    "待采集",
  );
  expect(screen.getByText(/不作为严格转化漏斗/)).toBeTruthy();
});
it("metric network failures do not become fake zero", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("offline");
    }),
  );
  render(<OperationsMetrics {...props} permissions={["dashboard.read"]} />);
  await screen.findByRole("alert");
  expect(screen.queryByText("0")).toBeNull();
});
it("discards an old Bot metrics response after scope change", async () => {
  let oldResolve!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string) =>
      path.startsWith(base + "/")
        ? new Promise<Response>((resolve) => {
            oldResolve = resolve;
          })
        : Promise.resolve(response({ ...metricFixture(), metrics: [] })),
    ),
  );
  const view = render(
    <OperationsMetrics {...props} permissions={["dashboard.read"]} />,
  );
  view.rerender(
    <OperationsMetrics
      {...props}
      permissions={["dashboard.read"]}
      base="/v1/brands/new/bots/new"
    />,
  );
  await waitFor(() =>
    expect(screen.queryByText("正在加载运营数据…")).toBeNull(),
  );
  await act(async () => oldResolve(response(metricFixture())));
  expect(screen.queryByText("9007199254740993")).toBeNull();
});

it("allows saving default content as the first version but never publishing version zero", async () => {
  const user = userEvent.setup();
  render(<BotContent {...props} />);
  await screen.findByLabelText("新用户欢迎语");
  expect(
    (screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  await user.click(screen.getByRole("button", { name: "手机预览" }));
  await waitFor(() =>
    expect(screen.getByLabelText("手机预览").textContent).toContain("Welcome"),
  );
  expect(
    (screen.getByRole("button", { name: "发布内容" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText("草稿已保存，请预览后发布。");
  expect(state.draftVersion).toBe(1);
});

it("explains missing content grants as an approval prerequisite, not a network retry", () => {
  const issue = new ApiError(503, "bot_content_storage_unavailable");
  expect(issue.message).toContain("最小写权限");
  expect(issue.message).not.toContain("重新连接");
});
