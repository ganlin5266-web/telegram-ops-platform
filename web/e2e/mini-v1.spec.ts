import { test, expect } from "@playwright/test";
test("Mini V1 mobile navigation, empty data, reload recovery and logout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("https://telegram.org/js/telegram-web-app.js", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.Telegram={WebApp:{initData:"synthetic-browser-only",ready(){}}};',
    }),
  );
  let connected = false,
    revoked = false,
    exchanges = 0,
    recoveries = 0;
  const token = "c".repeat(64);
  await page.route("**/v1/mini/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p.endsWith("/recover")) {
      recoveries++;
      return route.fulfill({
        status: connected && !revoked ? 200 : 401,
        json:
          connected && !revoked
            ? { token, tokenType: "Bearer" }
            : { error: "mini_unauthorized" },
      });
    }
    if (p.endsWith("/exchange")) {
      exchanges++;
      connected = true;
      return route.fulfill({ json: { token, tokenType: "Bearer" } });
    }
    if (p.endsWith("/logout")) {
      revoked = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (p.endsWith("/me"))
      return route.fulfill({
        status: 401,
        json: { error: "mini_unauthorized" },
      });
    if (p.endsWith("/home"))
      return route.fulfill({
        json: {
          profile: {
            displayName: "测试用户",
            projectName: "Staging Test Brand",
            botName: "P1 Test Bot",
            uiLanguage: "zh-CN",
          },
          points: { accountExists: false, balance: null },
          invitedCount: "0",
          redemptionCount: "0",
          activities: { participationEnabled: false },
        },
      });
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto("/mini.html");
  await expect(
    page.getByRole("heading", { name: "你好，测试用户" }),
  ).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCSS("position", "fixed");
  for (const tab of ["活动", "奖励", "邀请", "我的"]) {
    await page
      .getByRole("navigation")
      .getByRole("button", { name: tab, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: tab, exact: true }),
    ).toBeVisible();
  }
  await expect(page.locator("body")).not.toContainText("Brand ID");
  await expect(page.locator("body")).not.toContainText(token);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({ local: 0, session: 0 });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "你好，测试用户" }),
  ).toBeVisible();
  expect(exchanges).toBe(1);
  expect(recoveries).toBe(2);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "我的", exact: true })
    .click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "已安全退出" })).toBeVisible();
});
test("Mini V1 outside Telegram does not impersonate a user", async ({
  page,
}) => {
  await page.route("https://telegram.org/js/telegram-web-app.js", (r) =>
    r.fulfill({ body: "", contentType: "application/javascript" }),
  );
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/v1/mini")) requests++;
  });
  await page.goto("/mini.html");
  await expect(page.getByRole("alert")).toContainText(
    "请从 FUN_Club_Staging_bot",
  );
  expect(requests).toBe(0);
});
