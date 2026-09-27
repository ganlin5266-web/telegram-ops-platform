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
  await expect(page.getByTestId("today-focus")).toContainText("等级即将开放");
  await expect(page.getByTestId("today-focus")).not.toContainText(
    "暂无积分账户",
  );
  await expect(
    page.getByTestId("today-focus").getByRole("button", { name: "会员" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "小游戏 即将开放" }).click();
  await expect(page.getByRole("heading", { name: "小游戏" })).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "首页", exact: true })
    .click();

  for (const width of [320, 430, 1000]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page
        .locator(".mini-shell")
        .evaluate((el) => el.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(620);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  if (process.env.MINI_UI_SCREENSHOT)
    await page.screenshot({
      path: process.env.MINI_UI_SCREENSHOT,
      fullPage: true,
    });
  for (const tab of ["会员", "活动", "小游戏", "奖励", "邀请", "我的"]) {
    if (tab === "奖励" || tab === "邀请") {
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "我的", exact: true })
        .click();
      await page
        .getByRole("button", {
          name: tab === "奖励" ? "我的积分" : "邀请记录",
          exact: true,
        })
        .click();
    } else
      await page
        .getByRole("navigation")
        .getByRole("button", { name: tab, exact: true })
        .click();
    await expect(
      page.getByRole("heading", { name: tab, exact: true }),
    ).toBeVisible();
    if (tab === "活动") {
      await expect(page.locator(".activity-card")).toHaveCount(4);
      await expect(
        page.locator(".activity-card button").first(),
      ).toBeDisabled();
    }
    if (tab === "奖励") {
      await expect(page.getByText("还没有积分记录")).toBeVisible();
      await page.getByRole("button", { name: "我的兑换", exact: true }).click();
      await expect(page.getByText("还没有兑换记录")).toBeVisible();
    }
    if (tab === "邀请") {
      await expect(page.getByText("还没有邀请记录")).toBeVisible();
      await expect(page.getByText("规则尚未发布")).toBeVisible();
    }
  }
  await expect(page.locator("body")).not.toContainText("Brand ID");
  await expect(page.locator("body")).not.toContainText("Staging Test Brand");
  await expect(page.locator("body")).not.toContainText("P1 Test Bot");
  await expect(page.locator("body")).not.toContainText(
    /\b[0-9a-f]{8}-[0-9a-f-]{27}\b/,
  );
  await expect(
    page.getByRole("button", { name: "平台账号", exact: true }),
  ).toBeVisible();

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

  await page.getByRole("button", { name: /语言 ·?|语言 简体中文/ }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.getByRole("navigation")).toContainText("Member");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Hello, 测试用户" }),
  ).toBeVisible();
  expect(exchanges).toBe(1);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Me", exact: true })
    .click();
  await page.getByRole("button", { name: /Language English/ }).click();
  await page
    .getByRole("button", { name: "Português (Brasil)", exact: true })
    .click();
  await expect(
    page.getByText(
      "Full translation is being prepared. English is shown for now.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "简体中文", exact: true }).click();
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
  await expect(page.getByRole("alert")).toContainText("请从所属 Bot");
  expect(requests).toBe(0);
});
