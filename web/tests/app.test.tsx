import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  act,
} from "@testing-library/react";
import App from "../src/App";
import { ApiError, json, message, operation, request } from "../src/api";
// Fixtures are confined to tests. The shipped application has no mock provider.
const user = {
  id: "u1",
  telegram_user_id: "90071992547409930",
  first_name: "Ana",
  last_name: "Silva",
  username: "ana",
  preferred_language: null,
  telegram_language_code: "pt-BR",
  first_started_at: null,
  last_interaction_at: null,
  status: "active",
};
const brand = (id: string) => ({
  brandId: id,
  name: `品牌 ${id}`,
  defaultLanguage: "pt-BR",
  status: "active",
});
const bot = (id: string) => ({
  botId: id,
  name: `Bot ${id}`,
  username: id,
  defaultLanguage: "pt-BR",
  status: "active",
});
let calls: { path: string; options: RequestInit }[],
  grants: string[],
  signed: boolean,
  emptyBrands: boolean,
  emptyBots: boolean;
let custom:
  | ((
      path: string,
      options: RequestInit,
    ) => Response | Promise<Response> | undefined)
  | undefined;
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
  calls = [];
  grants = ["users.read", "points.adjust"];
  signed = true;
  emptyBrands = false;
  emptyBots = false;
  custom = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit) => {
      calls.push({ path, options });
      const override = custom?.(path, options);
      if (override) return override;
      if (path === "/v1/auth/login") {
        signed = true;
        return response({ csrfToken: "test-csrf" });
      }
      if (!signed) return response({ error: "unauthorized" }, 401);
      if (path === "/v1/me")
        return response({
          displayName: "测试管理员",
          uiLanguage: "zh-CN",
          csrfToken: "test-csrf",
        });
      if (path.startsWith("/v1/me/permissions"))
        return response({ permissions: grants, grants: [] });
      if (path === "/v1/me/brands")
        return response({ items: emptyBrands ? [] : [brand("a"), brand("b")] });
      if (path.includes("/v1/me/brands/"))
        return response({
          items: emptyBots
            ? []
            : path.includes("/a/")
              ? [bot("a1"), bot("a2")]
              : [bot("b1")],
        });
      if (path.includes("/users?"))
        return response({ items: [user], nextCursor: null });
      if (path.endsWith("/points"))
        return response({ balance: "90071992547409930" });
      if (path.endsWith("/adjustments"))
        return response({
          ledgerId: "ledger-test",
          balance: "90071992547409931",
        });
      if (path === "/v1/auth/logout")
        return new Response(null, { status: 204 });
      throw new Error(`Unhandled test route ${path}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function ready() {
  render(<App />);
  await screen.findByText("工作台总览");
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Telegram Bot") as HTMLSelectElement).value,
    ).toBe("a1"),
  );
  await screen.findByText("users.read、points.adjust").catch(() => {});
}
async function users() {
  render(<App />);
  await screen.findByText("工作台总览");
  fireEvent.click(screen.getByRole("button", { name: /Telegram 用户/ }));
  await screen.findByText("Ana Silva");
}
async function detail() {
  await users();
  fireEvent.click(screen.getByText("查看积分"));
  await screen.findByText("90071992547409930", { selector: "strong" });
}
async function confirm() {
  await detail();
  fireEvent.change(screen.getByLabelText("调整数量"), {
    target: { value: "1" },
  });
  fireEvent.change(screen.getByLabelText("原因"), {
    target: { value: "补偿" },
  });
  fireEvent.change(screen.getByLabelText("补充备注"), {
    target: { value: "测试操作" },
  });
  fireEvent.click(screen.getByText("调整积分 · 下一步"));
}
it("loads real-shaped me, brand, bot and scoped permission endpoints", async () => {
  await ready();
  expect(
    calls.some((x) => x.path === "/v1/me/permissions?brandId=a&botId=a1"),
  ).toBe(true);
  expect(screen.getAllByText("测试管理员").length).toBeGreaterThan(0);
});
it("login success uses cookie credentials and login CSRF header without retaining password", async () => {
  signed = false;
  render(<App />);
  await screen.findByLabelText("密码");
  fireEvent.change(screen.getByLabelText("账号"), {
    target: { value: "operator" },
  });
  fireEvent.change(screen.getByLabelText("密码"), {
    target: { value: "only-in-test-input" },
  });
  fireEvent.click(screen.getByText("登录工作台 →"));
  await screen.findByText("工作台总览");
  const c = calls.find((x) => x.path === "/v1/auth/login")!;
  expect(c.options.credentials).toBe("include");
  expect(c.options.headers).toHaveProperty("X-CSRF-Protection", "1");
  expect(screen.queryByLabelText("密码")).toBeNull();
});
it("login failure is generic and clears password input", async () => {
  signed = false;
  custom = (p) =>
    p === "/v1/auth/login"
      ? response({ error: "invalid_credentials" }, 401)
      : undefined;
  render(<App />);
  await screen.findByLabelText("密码");
  fireEvent.change(screen.getByLabelText("账号"), {
    target: { value: "unknown" },
  });
  fireEvent.change(screen.getByLabelText("密码"), {
    target: { value: "wrong" },
  });
  fireEvent.click(screen.getByText("登录工作台 →"));
  await screen.findByText("登录信息错误或账号不可用");
  expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe("");
});
it("session expiry clears identity, scope and user details without retry", async () => {
  await detail();
  custom = (p) =>
    p.endsWith("/points")
      ? response({ error: "session_expired" }, 401)
      : undefined;
  fireEvent.click(screen.getByLabelText("关闭详情"));
  fireEvent.click(screen.getByText("查看积分"));
  await screen.findByText("登录已过期，请重新登录");
  expect(screen.queryByLabelText("品牌")).toBeNull();
  expect(screen.queryByText("Ana Silva")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("shows authorized brands only and brand empty state", async () => {
  emptyBrands = true;
  render(<App />);
  await screen.findByText("当前账号暂无可访问品牌，请联系管理员。");
  expect(calls.some((x) => x.path.includes("/bots/"))).toBe(false);
});
it("shows bot empty state", async () => {
  emptyBots = true;
  render(<App />);
  await screen.findByText("当前品牌暂无可访问Bot。");
});
it("brand switch immediately removes previous user and balance", async () => {
  await detail();
  fireEvent.change(screen.getByLabelText("品牌"), { target: { value: "b" } });
  expect(screen.queryByText("Ana Silva")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Telegram Bot") as HTMLSelectElement).value,
    ).toBe("b1"),
  );
});
it("bot switch rejects late user response from old scope", async () => {
  let resolve!: (r: Response) => void;
  custom = (p) =>
    p.includes("/a1/users?")
      ? new Promise((r) => (resolve = r))
      : p.includes("/a2/users?")
        ? response({ items: [], nextCursor: null })
        : undefined;
  render(<App />);
  await screen.findByText("工作台总览");
  fireEvent.click(screen.getByRole("button", { name: /Telegram 用户/ }));
  await waitFor(() => expect(resolve).toBeTypeOf("function"));
  fireEvent.change(screen.getByLabelText("Telegram Bot"), {
    target: { value: "a2" },
  });
  await screen.findByText("当前批次暂无用户");
  await act(async () => resolve(response({ items: [user], nextCursor: null })));
  expect(screen.queryByText("Ana Silva")).toBeNull();
});
it("late balance response does not leak into another bot", async () => {
  await users();
  let resolve!: (r: Response) => void;
  custom = (p) =>
    p.endsWith("/points") ? new Promise((r) => (resolve = r)) : undefined;
  fireEvent.click(screen.getByText("查看积分"));
  await waitFor(() => expect(resolve).toBeTypeOf("function"));
  fireEvent.change(screen.getByLabelText("Telegram Bot"), {
    target: { value: "a2" },
  });
  await act(async () => resolve(response({ balance: "123456789" })));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("123456789")).toBeNull();
});
it("user list preserves exact Telegram IDs and language fields", async () => {
  await users();
  expect(screen.getByText(user.telegram_user_id)).toBeTruthy();
  expect(screen.getByText("pt-BR")).toBeTruthy();
  expect(screen.queryByRole("searchbox")).toBeNull();
});
it("cursor next and previous preserve server cursor, without fabricated totals", async () => {
  custom = (p) =>
    p.includes("/users?")
      ? response({
          items: [
            { ...user, first_name: p.includes("after=") ? "Second" : "Ana" },
          ],
          nextCursor: p.includes("after=") ? null : "cursor-a",
        })
      : undefined;
  await users();
  fireEvent.click(screen.getByText("下一批"));
  await screen.findByText("Second Silva");
  expect(calls.some((x) => x.path.endsWith("limit=50&after=cursor-a"))).toBe(
    true,
  );
  fireEvent.click(screen.getByText("上一批"));
  await screen.findByText("Ana Silva");
  expect(calls.at(-1)?.path).toMatch(/limit=50$/);
});
it("reads exact points strings above safe integer limit", async () => {
  await detail();
  expect(
    screen.getByText("90071992547409930", { selector: "strong" }),
  ).toBeTruthy();
});
it("Viewer cannot see adjustment UI", async () => {
  grants = ["users.read"];
  await detail();
  expect(screen.queryByText("人工调整积分")).toBeNull();
});
it("actual points.adjust permission enables adjustment with exact BigInt preview", async () => {
  await confirm();
  expect(screen.getByText("90071992547409931")).toBeTruthy();
  expect(screen.getByText("请再次确认积分调整")).toBeTruthy();
});
it("successful adjustment sends CSRF and rereads real balance", async () => {
  await confirm();
  fireEvent.click(screen.getByText("确认提交"));
  await screen.findByText("积分调整成功，服务端已记录流水。");
  const c = calls.find((x) => x.path.endsWith("/adjustments"))!;
  expect(c.options.headers).toHaveProperty("X-CSRF-Token", "test-csrf");
  expect(JSON.parse(c.options.body as string).note).toBe(
    "原因：补偿\n备注：测试操作",
  );
  await waitFor(() =>
    expect(calls.filter((x) => x.path.endsWith("/points")).length).toBe(2),
  );
});
it("adjustment conflict displays safe error, never false success", async () => {
  await confirm();
  custom = (p) =>
    p.endsWith("/adjustments")
      ? response({ error: "insufficient_points", sql: "private" }, 409)
      : undefined;
  fireEvent.click(screen.getByText("确认提交"));
  await screen.findByText("操作冲突，请刷新后重试");
  expect(screen.queryByText(/积分调整成功/)).toBeNull();
  expect(screen.queryByText("private")).toBeNull();
});
it("network retry retains eventId and Idempotency-Key", async () => {
  await confirm();
  let failed = false;
  custom = (p) => {
    if (p.endsWith("/adjustments") && !failed) {
      failed = true;
      return Promise.reject(new TypeError("network"));
    }
  };
  fireEvent.click(screen.getByText("确认提交"));
  await screen.findByText("网络连接失败，请检查网络后重试");
  fireEvent.click(screen.getByText("使用原操作重试"));
  await screen.findByText("积分调整成功，服务端已记录流水。");
  const attempts = calls.filter((x) => x.path.endsWith("/adjustments"));
  expect(attempts).toHaveLength(2);
  expect(attempts[0].options.body).toBe(attempts[1].options.body);
  expect(attempts[0].options.headers).toEqual(attempts[1].options.headers);
});
it("403 users endpoint shows permission error", async () => {
  custom = (p) =>
    p.includes("/users?") ? response({ error: "forbidden" }, 403) : undefined;
  render(<App />);
  await screen.findByText("工作台总览");
  fireEvent.click(screen.getByRole("button", { name: /Telegram 用户/ }));
  await screen.findByText("你没有权限执行此操作");
  expect(screen.queryByText("Ana Silva")).toBeNull();
});
it("no users.read permission prevents user endpoint calls", async () => {
  grants = [];
  render(<App />);
  await screen.findByText("工作台总览");
  fireEvent.click(screen.getByRole("button", { name: /Telegram 用户/ }));
  await screen.findByText("你没有权限查看当前 Bot 用户。");
  expect(calls.some((x) => x.path.includes("/users?"))).toBe(false);
});
it("network failure exits loading into retryable error", async () => {
  custom = (p) =>
    p.includes("/users?")
      ? Promise.reject(new TypeError("offline"))
      : undefined;
  render(<App />);
  await screen.findByText("工作台总览");
  fireEvent.click(screen.getByRole("button", { name: /Telegram 用户/ }));
  await screen.findByText("网络连接失败，请检查网络后重试");
  expect(screen.queryByText("正在加载…")).toBeNull();
});
it("empty users are shown explicitly", async () => {
  custom = (p) =>
    p.includes("/users?")
      ? response({ items: [], nextCursor: null })
      : undefined;
  render(<App />);
  await screen.findByText("工作台总览");
  fireEvent.click(screen.getByRole("button", { name: /Telegram 用户/ }));
  await screen.findByText("当前批次暂无用户");
});
it("Chinese UI never writes bot or user language", async () => {
  await ready();
  expect(screen.getAllByText(/pt-BR/).length).toBeGreaterThan(0);
  expect(
    calls.every((x) => !x.options.method || x.options.method === "GET"),
  ).toBe(true);
  expect(screen.getByText(/Telegram 发送语言由服务端/)).toBeTruthy();
});
it("mobile navigation has functioning open and close controls", async () => {
  await ready();
  fireEvent.click(screen.getByLabelText("打开导航"));
  expect(document.querySelector(".sidebar.open")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("关闭导航"));
  expect(document.querySelector(".sidebar.open")).toBeNull();
});
it.each([400, 401, 403, 404, 409, 429, 500])(
  "HTTP %s is mapped to safe Chinese text",
  async (status) => {
    custom = () =>
      response({ error: "internal", stack: "secret stack" }, status);
    await expect(request("/failure")).rejects.toThrow(message(status));
    expect(message(status)).not.toContain("stack");
  },
);
it("operation validates backend delta and note rules and makes fresh IDs only for new actions", () => {
  const a = operation("u", "1", "原因", "备注"),
    b = operation("u", "1", "原因", "备注");
  expect(a.key).not.toBe(b.key);
  expect(a.body.eventId).not.toBe(b.body.eventId);
  for (const delta of ["0", "01", "1.2", "+1", "-0"])
    expect(() => operation("u", delta, "原因", "")).toThrow();
  expect(() => operation("u", "1", "x".repeat(500), "")).toThrow();
});
