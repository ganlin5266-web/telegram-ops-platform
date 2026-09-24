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
      if (/\/users\/u1$/.test(path))
        return response({
          ...user,
          created_at: "2025-01-01T00:00:00Z",
          updated_at: "2025-01-02T00:00:00Z",
          resolved_language: "pt-BR",
        });
      if (path.includes("/referrals?"))
        return response({
          items: [],
          nextCursor: null,
          invitedBy: null,
          invitedCount: "0",
        });
      if (path.includes("/audit-logs?"))
        return response({ items: [], nextCursor: null });
      if (path.includes("/users/count")) return response({ total: "1" });
      if (path.endsWith("/points/summary"))
        return response({
          balance: "90071992547409930",
          totalEarned: "90071992547410030",
          totalSpent: "100",
        });
      if (path.includes("/point-ledger?"))
        return response({ items: [], nextCursor: null });
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

// Batch two coverage extends the same app and auth fixture; first 31 cases remain intact.
const apiCalls = (part: string) => calls.filter((c) => c.path.includes(part));
async function changeFilter(label: string, value: string, param: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  await waitFor(() =>
    expect(apiCalls("/users?").at(-1)?.path).toContain(param),
  );
}
it("center: Telegram ID search sends the exact decimal string", async () => {
  await users();
  await changeFilter("搜索用户", "90071992547409930", "q=90071992547409930");
});
it("center: Username prefix search preserves @ input", async () => {
  await users();
  await changeFilter("搜索用户", "@ANA", "q=%40ANA");
  expect(screen.getByPlaceholderText(/Telegram ID 精确匹配/)).toBeTruthy();
});
it("center: name prefix search is server-side", async () => {
  await users();
  await changeFilter("搜索用户", "Ana", "q=Ana");
  expect(apiCalls("/users?").at(-1)?.options.body).toBeUndefined();
});
it("center: status filtering updates the server request", async () => {
  await users();
  await changeFilter("用户状态", "blocked", "status=blocked");
});
it("center: Telegram language is explicit", async () => {
  await users();
  await changeFilter("语言代码", "en", "language=en");
  expect(apiCalls("/users?").at(-1)?.path).not.toContain(
    "languageField=preferred",
  );
});
it("center: preferred language filter is distinct", async () => {
  await users();
  await changeFilter("语言来源", "preferred", "languageField=preferred");
  await changeFilter("语言代码", "pt-BR", "language=pt-BR");
});
it("center: first start dates use timezone-qualified ISO values", async () => {
  await users();
  await changeFilter("首次启动开始", "2025-01-02T10:00", "startedFrom=");
  const p = new URL(apiCalls("/users?").at(-1)!.path, "http://test")
    .searchParams;
  expect(p.get("startedFrom")).toBe(new Date("2025-01-02T10:00").toISOString());
});
it("center: last interaction date range reaches API", async () => {
  await users();
  await changeFilter("最后互动开始", "2025-02-01T10:00", "interactionFrom=");
  await changeFilter(
    "最后互动结束（不含）",
    "2025-02-02T10:00",
    "interactionTo=",
  );
});
it("center: sorting is restricted to supported fields and direction", async () => {
  await users();
  await changeFilter(
    "排序字段",
    "last_interaction_at",
    "sort=last_interaction_at",
  );
  await changeFilter("排序方向", "desc", "order=desc");
});
it("center: count tracks filters without pagination or sort arguments", async () => {
  custom = (p) =>
    p.includes("/users/count")
      ? response({ total: p.includes("status=blocked") ? "7" : "99" })
      : undefined;
  await users();
  await screen.findByText("共 99 位用户");
  await changeFilter("用户状态", "blocked", "status=blocked");
  await screen.findByText("共 7 位用户");
  expect(apiCalls("/users/count").at(-1)?.path).not.toMatch(
    /after=|limit=|sort=/,
  );
});
for (const [label, value, param] of [
  ["搜索用户", "Ana", "q=Ana"],
  ["用户状态", "blocked", "status=blocked"],
  ["排序字段", "first_started_at", "sort=first_started_at"],
])
  it(`center: ${label} resets cursor and clears stale results`, async () => {
    custom = (p) =>
      p.includes("/users?")
        ? response({ items: [user], nextCursor: "old-cursor" })
        : undefined;
    await users();
    fireEvent.click(screen.getByText("下一批"));
    await waitFor(() =>
      expect(apiCalls("/users?").at(-1)?.path).toContain("after=old-cursor"),
    );
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
    expect(screen.queryByText("Ana Silva")).toBeNull();
    await waitFor(() =>
      expect(apiCalls("/users?").at(-1)?.path).toContain(param),
    );
    expect(apiCalls("/users?").at(-1)?.path).not.toContain("after=");
  });
it("center: invalid cursor clears pagination and waits for explicit reload", async () => {
  custom = (p) =>
    p.includes("/users?")
      ? p.includes("after=")
        ? response({ error: "invalid_cursor" }, 400)
        : response({ items: [user], nextCursor: "expired" })
      : undefined;
  await users();
  fireEvent.click(screen.getByText("下一批"));
  await screen.findByText("查询条件已变化，请重新加载。");
  const count = apiCalls("/users?").length;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
  expect(apiCalls("/users?")).toHaveLength(count);
  fireEvent.click(screen.getByText("重新加载"));
  await screen.findByText("Ana Silva");
  expect(apiCalls("/users?").at(-1)?.path).not.toContain("after=");
});
it("center: overview loads full user profile including server resolved language", async () => {
  await users();
  fireEvent.click(screen.getByText("查看详情"));
  await screen.findByText("内部 User ID");
  expect(screen.getByText("u1", { selector: "dd" })).toBeTruthy();
  expect(screen.getByText("解析语言")).toBeTruthy();
  expect(screen.getByText("创建时间")).toBeTruthy();
});
it("center: point summary preserves exact strings and explains refunds", async () => {
  await detail();
  await screen.findByText("90071992547410030");
  expect(screen.getByText("100", { selector: "strong" })).toBeTruthy();
  expect(screen.getByText(/累计获得按所有正积分流水统计/)).toBeTruthy();
});
const ledger = {
  id: "ledger1",
  delta: "9007199254740993",
  direction: "credit",
  balance_before: "1",
  balance_after: "9007199254740994",
  source: "admin",
  business_type: "manual_adjustment",
  business_id: "business1",
  note: "测试备注",
  created_at: "2025-01-01T00:00:00Z",
};
it("center: ledger displays signed strings and before/after without rounding", async () => {
  custom = (p) =>
    p.includes("/point-ledger?")
      ? response({ items: [ledger], nextCursor: null })
      : undefined;
  await detail();
  await screen.findByText("+9007199254740993");
  expect(screen.getByText("1 → 9007199254740994")).toBeTruthy();
  expect(screen.getByText("测试备注")).toBeTruthy();
});
it("center: ledger filters combine direction source type and date", async () => {
  await detail();
  fireEvent.change(screen.getByLabelText("积分方向"), {
    target: { value: "debit" },
  });
  fireEvent.change(screen.getByLabelText("来源"), {
    target: { value: "refund" },
  });
  fireEvent.change(screen.getByLabelText("业务类型"), {
    target: { value: "refund" },
  });
  fireEvent.change(screen.getByLabelText("流水开始时间"), {
    target: { value: "2025-01-01T00:00" },
  });
  await waitFor(() =>
    expect(apiCalls("/point-ledger?").at(-1)?.path).toContain("from="),
  );
  const path = apiCalls("/point-ledger?").at(-1)!.path;
  expect(path).toContain("direction=debit");
  expect(path).toContain("source=refund");
  expect(path).toContain("businessType=refund");
});
it("center: ledger next and previous use actual cursors", async () => {
  custom = (p) =>
    p.includes("/point-ledger?")
      ? response({
          items: [
            {
              ...ledger,
              note: p.includes("after=") ? "下一批备注" : "首批备注",
            },
          ],
          nextCursor: p.includes("after=") ? null : "ledger-cursor",
        })
      : undefined;
  await detail();
  await screen.findByText("首批备注");
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.click(dialog.getByText("下一批"));
  await screen.findByText("下一批备注");
  fireEvent.click(dialog.getByText("上一批"));
  await screen.findByText("首批备注");
});
const inviter = {
  id: "inviter1",
  telegramUserId: "123",
  username: "inviter",
  firstName: "邀请人甲",
  lastName: null,
};
const referral = {
  id: "r1",
  boundAt: "2025-01-01T00:00:00Z",
  status: "bound",
  rewardStatus: "pending",
  inviter,
  invitee: {
    ...inviter,
    id: "child",
    firstName: "被邀请人乙",
    telegramUserId: "456",
  },
};
it("center: incoming inviter and outgoing invitees show factual states", async () => {
  custom = (p) =>
    p.includes("/referrals?")
      ? response({
          invitedBy: referral,
          invitedCount: "1",
          items: [referral],
          nextCursor: null,
        })
      : undefined;
  await detail();
  fireEvent.click(screen.getByRole("tab", { name: "邀请", exact: true }));
  await screen.findByText("被邀请人乙");
  expect(screen.getAllByText("邀请人甲").length).toBeGreaterThan(0);
  expect(screen.getByText(/有效邀请资格规则尚未启用/)).toBeTruthy();
});
it("center: missing inviter and no invited users are separate empty states", async () => {
  await detail();
  fireEvent.click(screen.getByRole("tab", { name: "邀请", exact: true }));
  await screen.findByText("该用户暂无邀请人");
  await screen.findByText("该用户暂未邀请其他用户");
});
it("center: outgoing referral pagination uses cursor", async () => {
  custom = (p) =>
    p.includes("/referrals?")
      ? response({
          invitedBy: null,
          invitedCount: "2",
          items: [{ ...referral, id: p.includes("after=") ? "r2" : "r1" }],
          nextCursor: p.includes("after=") ? null : "ref-cursor",
        })
      : undefined;
  await detail();
  fireEvent.click(screen.getByRole("tab", { name: "邀请", exact: true }));
  await screen.findByText("被邀请人乙");
  fireEvent.click(within(screen.getByRole("dialog")).getByText("下一批"));
  await waitFor(() =>
    expect(apiCalls("/referrals?").at(-1)?.path).toContain("after=ref-cursor"),
  );
});
it("center: Bot referral secondary view requests scoped API with search", async () => {
  await users();
  fireEvent.click(
    screen.getByRole("button", { name: "邀请关系", exact: true }),
  );
  await screen.findByText("当前 Bot 邀请关系");
  fireEvent.change(screen.getByLabelText("邀请人搜索"), {
    target: { value: "@inviter" },
  });
  await waitFor(() =>
    expect(apiCalls("/referrals?").at(-1)?.path).toContain(
      "/bots/a1/referrals?inviter=%40inviter",
    ),
  );
});
it("center: audit.read reveals explicitly Bot scoped logs", async () => {
  grants.push("audit.read");
  custom = (p) =>
    p.includes("/audit-logs?")
      ? response({
          items: [
            {
              id: "audit1",
              created_at: "2025-01-01T00:00:00Z",
              admin_name: "管理员甲",
              action: "points.adjust",
              object_type: "point_ledger",
              object_id: "ledger1",
              summary: "安全摘要",
              result: "committed",
            },
          ],
          nextCursor: null,
        })
      : undefined;
  await detail();
  fireEvent.click(screen.getByRole("tab", { name: "操作记录" }));
  await screen.findByText("安全摘要");
  expect(screen.getByText("当前 Bot 操作日志")).toBeTruthy();
  expect(apiCalls("/audit-logs?").at(-1)?.path).not.toContain("userId=");
});
it("center: without audit.read no audit tab or request exists", async () => {
  await detail();
  expect(screen.queryByRole("tab", { name: "操作记录" })).toBeNull();
  expect(apiCalls("/audit-logs?")).toHaveLength(0);
});
it("center: audit 403 is local and overview remains usable", async () => {
  grants.push("audit.read");
  custom = (p) =>
    p.includes("/audit-logs?")
      ? response({ error: "forbidden" }, 403)
      : undefined;
  await detail();
  fireEvent.click(screen.getByRole("tab", { name: "操作记录" }));
  await screen.findByText("你没有权限执行此操作");
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "概览" }));
  await screen.findByText("内部 User ID");
});
it("center: Brand switch clears loaded summary and drawer", async () => {
  await detail();
  await screen.findByText("90071992547410030");
  fireEvent.change(screen.getByLabelText("品牌"), { target: { value: "b" } });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("90071992547410030")).toBeNull();
  await waitFor(() =>
    expect(apiCalls("/users/count").at(-1)?.path).toContain("/bots/b1/"),
  );
});
it("center: late detail response cannot repopulate another Bot", async () => {
  let release!: (r: Response) => void;
  custom = (p) =>
    /\/users\/u1$/.test(p) ? new Promise((r) => (release = r)) : undefined;
  await users();
  fireEvent.click(screen.getByText("查看详情"));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  fireEvent.change(screen.getByLabelText("Telegram Bot"), {
    target: { value: "a2" },
  });
  await act(async () =>
    release(response({ ...user, first_name: "旧 Bot 秘密资料" })),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("旧 Bot 秘密资料")).toBeNull();
});
it("center: adjustment refreshes account summary and ledger", async () => {
  await confirm();
  const beforeSummary = apiCalls("/points/summary").length,
    beforeLedger = apiCalls("/point-ledger?").length;
  fireEvent.click(screen.getByText("确认提交"));
  await screen.findByText("积分调整成功，服务端已记录流水。");
  await waitFor(() =>
    expect(apiCalls("/points/summary").length).toBe(beforeSummary + 1),
  );
  await waitFor(() =>
    expect(apiCalls("/point-ledger?").length).toBe(beforeLedger + 1),
  );
});
it("center: detail 401 clears all authenticated state", async () => {
  custom = (p) =>
    /\/users\/u1$/.test(p)
      ? response({ error: "session_expired" }, 401)
      : undefined;
  await users();
  fireEvent.click(screen.getByText("查看详情"));
  await screen.findByText("登录已过期，请重新登录");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByLabelText("品牌")).toBeNull();
});
it("center: ledger 500 leaves balance and other tabs working", async () => {
  custom = (p) =>
    p.includes("/point-ledger?")
      ? response({ error: "internal_error" }, 500)
      : undefined;
  await detail();
  await screen.findByText("系统异常，请稍后重试");
  expect(
    screen.getByText("90071992547409930", { selector: "strong" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "邀请", exact: true }));
  await screen.findByText("该用户暂无邀请人");
});
it("center: search is debounced instead of requesting each keystroke", async () => {
  await users();
  const start = apiCalls("/users?").length;
  for (const value of ["A", "An", "Ana"])
    fireEvent.change(screen.getByLabelText("搜索用户"), { target: { value } });
  expect(apiCalls("/users?")).toHaveLength(start);
  await waitFor(() => expect(apiCalls("/users?")).toHaveLength(start + 1));
});
it("center: pagination and sorting do not repeat count", async () => {
  custom = (p) =>
    p.includes("/users?")
      ? response({ items: [user], nextCursor: "next" })
      : undefined;
  await users();
  await screen.findByText("共 1 位用户");
  const count = apiCalls("/users/count").length;
  fireEvent.click(screen.getByText("下一批"));
  await waitFor(() =>
    expect(apiCalls("/users?").at(-1)?.path).toContain("after=next"),
  );
  await changeFilter("排序字段", "first_started_at", "sort=first_started_at");
  expect(apiCalls("/users/count")).toHaveLength(count);
});
it("center: user list never performs per-row point requests", async () => {
  await users();
  expect(apiCalls("/points")).toHaveLength(0);
  expect(apiCalls("/point-ledger")).toHaveLength(0);
});
it("center: reset removes filters and pagination history", async () => {
  await users();
  await changeFilter("搜索用户", "Ana", "q=Ana");
  fireEvent.click(screen.getByText("重置筛选"));
  await waitFor(() =>
    expect(apiCalls("/users?").at(-1)?.path).toMatch(/users\?limit=50$/),
  );
  expect((screen.getByLabelText("搜索用户") as HTMLInputElement).value).toBe(
    "",
  );
});
it("center: mobile filter dialog exposes controls and closes", async () => {
  await users();
  fireEvent.click(screen.getByText("筛选与排序"));
  const dialog = within(screen.getByRole("dialog", { name: "筛选与排序" }));
  fireEvent.change(dialog.getByLabelText("用户状态"), {
    target: { value: "blocked" },
  });
  fireEvent.click(dialog.getByText("完成筛选"));
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() =>
    expect(apiCalls("/users?").at(-1)?.path).toContain("status=blocked"),
  );
});
