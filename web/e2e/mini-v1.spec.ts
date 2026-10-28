import { test, expect } from "@playwright/test";
test("Mini V1 mobile navigation, empty data, reload recovery and logout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("https://telegram.org/js/telegram-web-app.js", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.Telegram={WebApp:{initData:"synthetic-browser-only",ready(){},openTelegramLink(u){window.__inviteLink=u}}};',
    }),
  );
  let connected = false,
    revoked = false,
    exchanges = 0,
    recoveries = 0,
    redemptionCreates = 0,
    redemptionClaims = 0;
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
          member: {
            enabled: false,
            available: false,
            canCheckin: false,
            checkinStatus: "unavailable",
          },
          primaryAction: { kind: "view_records" },
          points: { accountExists: false, balance: null },
          invitedCount: "0",
          redemptionCount: "0",
          activities: { participationEnabled: false },
          referral: {
            qualifiedToday: "0",
            qualifiedTotal: "0",
            pointsEarned: "0",
            shareUrl: "https://t.me/P1TestBot?start=ref_SAFE_CURRENT_BOT",
          },
        },
      });
    if (p.endsWith("/redemption-tiers"))
      return route.fulfill({
        json: {
          items: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              platform_id: "22222222-2222-4222-8222-222222222222",
              tier_key: "brl_10",
              name: "BRL 10",
              points_cost: "100",
              face_value: "10",
              face_currency: "BRL",
              display_name: "FUN66",
              redemption_url: "https://example.test/redeem",
              available: 1,
              balance: "100",
              pointsGap: "0",
              canRedeem: true,
              unavailableReason: null,
              usedToday: 0,
              pointsUsedToday: "0",
              dailyCountLimit: 1,
              dailyPointsLimit: "300",
            },
          ],
        },
      });
    if (
      p.endsWith("/redemption-orders") &&
      route.request().method() === "POST"
    ) {
      redemptionCreates++;
      return route.fulfill({
        json: { id: "order-1", status: "code_assigned", points_cost: "100" },
      });
    }
    if (p.endsWith("/redemption-orders/order-1/claim")) {
      redemptionClaims++;
      return route.fulfill({
        json: {
          id: "order-1",
          status: "code_claimed",
          code: "SAFE-CODE-ONE",
          redemptionUrl: "https://example.test/redeem",
        },
      });
    }
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto("/mini.html");
  await expect(
    page.getByRole("heading", { name: "你好，测试用户" }),
  ).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCSS("position", "fixed");
  const expectMemberGrowthDisabled = async () => {
    const card = page.locator(".member-pass");
    await expect(
      card.getByRole("heading", { name: "会员成长尚未启用", exact: true }),
    ).toBeVisible();
    await expect(card).not.toContainText(/LV\s*\d+/);
    await expect(card).not.toContainText(/\d+\s*Growth/);
    await expect(card.locator(".pass-top")).toHaveCount(0);
    await expect(card.getByRole("progressbar")).toHaveCount(0);
  };
  // P0 keeps unopened games/tasks out of navigation and moves membership to Me.
  await expect(page.getByRole("navigation").getByRole("button")).toHaveCount(4);
  await expect(page.getByRole("navigation")).not.toContainText("小游戏");
  await expect(page.getByTestId("today-focus")).toContainText("Points");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "我的", exact: true })
    .click();
  await page.getByRole("button", { name: "会员 · Growth" }).click();
  await expectMemberGrowthDisabled();
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
  for (const tab of ["奖励", "邀请", "我的"]) {
    await page
      .getByRole("navigation")
      .getByRole("button", { name: tab, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: tab, exact: true }),
    ).toBeVisible();
    if (tab === "奖励") {
      await page.getByRole("button", { name: "积分明细", exact: true }).click();
      await expect(page.getByText("还没有积分记录")).toBeVisible();
      await page.getByRole("button", { name: "我的兑换", exact: true }).click();
      await expect(page.getByText("还没有兑换记录")).toBeVisible();
      await expect(page.getByText(/FUN66/)).toBeVisible();
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: "立即兑换" }).click();
      await expect(page.getByText("SAFE-CODE-ONE")).toBeVisible();
      await expect(
        page.getByRole("link", { name: "前往游戏平台" }),
      ).toHaveAttribute("href", "https://example.test/redeem");
      expect(redemptionCreates).toBe(1);
      expect(redemptionClaims).toBe(1);
    }
    if (tab === "邀请") {
      await expect(page.getByText("还没有邀请记录")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "分享给好友" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "分享给好友" }).click();
      expect(await page.evaluate(() => (window as any).__inviteLink)).toContain(
        "https://t.me/share/url?url=https%3A%2F%2Ft.me%2FP1TestBot%3Fstart%3Dref_SAFE_CURRENT_BOT",
      );
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
  await expect(page.getByRole("navigation")).toContainText("Rewards");
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
  await expect(page.getByRole("navigation")).toContainText("Convites");
  await expect(
    page.getByText(
      "Full translation is being prepared. English is shown for now.",
    ),
  ).toHaveCount(0);
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
