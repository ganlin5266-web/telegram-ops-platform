import { test, expect } from "@playwright/test";
async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page
    .getByLabel("账号", { exact: true })
    .fill(process.env.UI_TEST_LOGIN!);
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.UI_TEST_PASSWORD!);
  await page.getByRole("button", { name: "登录工作台 →" }).click();
  await expect(page.getByRole("heading", { name: "工作台总览" })).toBeVisible();
  await expect(
    page.getByLabel("Telegram Bot", { exact: true }),
  ).not.toHaveValue("");
}
test("real Session Cookie, me, scopes and no browser-stored credentials", async ({
  page,
  context,
}) => {
  const responses: Promise<void>[] = [];
  page.on("response", (response) => {
    if (!response.url().includes("/v1/") || response.status() === 204) return;
    responses.push(
      response.json().then((body) => {
        const visit = (value: unknown): void => {
          if (!value || typeof value !== "object") return;
          for (const [key, item] of Object.entries(value)) {
            expect(key).not.toMatch(
              /^(password|password_hash|token_hash|sessionToken|token_secret_ref|webhook_secret_ref|service_role)$/i,
            );
            visit(item);
          }
        };
        visit(body);
      }),
    );
  });
  await login(page);
  const cookies = await context.cookies();
  expect(cookies.find((x) => x.name === "telegram_ops_session")?.httpOnly).toBe(
    true,
  );
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
      cookie: document.cookie,
    })),
  ).toEqual({ local: 0, session: 0, cookie: "" });
  await expect(
    page.getByText("验收管理员", { exact: true }).first(),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "工作台总览" })).toBeVisible();
  await expect(page.getByText(/默认语言：pt-BR/).first()).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("desktop.png"),
    fullPage: true,
  });
  await Promise.all(responses);
});
test("real users cursor pagination, exact balance adjustment, CSRF and ledger transaction", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Telegram 用户" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(50);
  await page.getByRole("button", { name: "下一批" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "上一批" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(50);
  await page.getByRole("button", { name: "查看积分" }).first().click();
  await expect(page.locator(".balance strong")).toHaveText("0");
  await page.getByLabel("调整数量").fill("9007199254740993");
  await page.getByLabel("原因", { exact: true }).fill("隔离环境验收");
  await page.getByLabel("补充备注").fill("真实 API 浏览器联调");
  await page.getByRole("button", { name: "调整积分 · 下一步" }).click();
  await page.getByRole("button", { name: "确认提交" }).click();
  await expect(
    page.getByText("积分调整成功，服务端已记录流水。"),
  ).toBeVisible();
  await expect(page.locator(".balance strong")).toHaveText("9007199254740993");
});
test("real brand and bot switching clear detail and return scoped users", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Telegram 用户" }).click();
  await page.getByRole("button", { name: "查看积分" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("关闭详情").click();
  await page
    .getByLabel("Telegram Bot", { exact: true })
    .selectOption({ label: "验收 Bot A2" });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("tbody tr").first()).toContainText("验收 Bot A2");
  await page
    .getByLabel("品牌", { exact: true })
    .selectOption({ label: "验收品牌 B" });
  await expect(page.locator("tbody tr").first()).toContainText("验收 Bot B1");
  await expect(page.locator("tbody")).not.toContainText("验收 Bot A");
});
test("server unauthorized response clears session UI and logout revokes cookie", async ({
  page,
  context,
}) => {
  await login(page);
  await context.clearCookies();
  await page.getByRole("button", { name: "Telegram 用户" }).click();
  await expect(page.getByText("登录已过期，请重新登录")).toBeVisible();
  await expect(page.getByLabel("品牌", { exact: true })).toHaveCount(0);
  await login(page);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page.getByText("已安全退出")).toBeVisible();
  expect(
    (await context.cookies()).filter((x) => x.name === "telegram_ops_session"),
  ).toHaveLength(0);
});
test("mobile layout uses working drawer with no page-level overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(page.getByLabel("打开导航")).toBeVisible();
  await page.getByLabel("打开导航").click();
  await page.getByRole("button", { name: "Telegram 用户" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(50);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("mobile.png"),
    fullPage: false,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "查看积分" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
