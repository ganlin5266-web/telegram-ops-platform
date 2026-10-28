import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
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

test("real local API draft, preview, publish and disable with independent Bot scope", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "内容", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Bot 欢迎内容" }),
  ).toBeVisible();
  await page.getByLabel("内容语言").selectOption("fil");
  await page
    .getByLabel("新用户欢迎语")
    .fill("Maligayang pagdating sa pitong araw na pagsubok.");
  await expect(page.getByRole("button", { name: "发布内容" })).toBeDisabled();
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByText("草稿已保存，请预览后发布。")).toBeVisible();
  await page.getByRole("button", { name: "手机预览" }).click();
  await expect(page.getByLabel("手机预览", { exact: true })).toContainText(
    "Maligayang pagdating sa pitong araw na pagsubok.",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "发布内容" }).click();
  await expect(
    page.getByText("内容已发布。请用测试账号从 Bot 进入验证实际显示。"),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "内容", exact: true }).click();
  await expect(page.getByText(/状态：已发布/)).toBeVisible();
  await page
    .getByLabel("Telegram Bot", { exact: true })
    .selectOption({ label: "验收 Bot A2" });
  await expect(page.getByText(/状态：未启用/)).toBeVisible();
  await page.getByLabel("内容语言").selectOption("fil");
  await expect(page.getByLabel("新用户欢迎语")).not.toHaveValue(
    "Maligayang pagdating sa pitong araw na pagsubok.",
  );
  await page
    .getByLabel("Telegram Bot", { exact: true })
    .selectOption({ label: "验收 Bot A1" });
  await expect(page.getByText(/状态：已发布/)).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "停用内容" }).click();
  await expect(page.getByText("内容已停用。")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("real metrics retain independent permission and pending-collection states", async ({
  page,
}) => {
  await login(page);
  await expect(
    page.getByRole("heading", { name: "近 7 天运营数据" }),
  ).toBeVisible();
  await expect(
    page.getByTestId("operation-metric-mini_participants"),
  ).toContainText("0");
  await expect(page.getByTestId("operation-metric-uid_verified")).toContainText(
    "无权限",
  );
  await expect(page.getByTestId("operation-metric-checkins")).toContainText(
    "无权限",
  );
  await expect(page.getByText(/不作为严格转化漏斗/)).toBeVisible();
});

// Explicit browser-only contract fixture; not Telegram or Staging authentication evidence.
test("Bot invitation navigation opens the invite page after authentication and ignores scope query hints", async ({
  page,
}) => {
  await page.route("https://telegram.org/js/telegram-web-app.js", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.Telegram={WebApp:{initData:"synthetic-navigation-fixture",ready(){}}};',
    }),
  );
  const paths: string[] = [];
  await page.route("**/v1/mini/**", async (route) => {
    const u = new URL(route.request().url());
    paths.push(u.pathname + u.search);
    if (u.pathname.endsWith("/recover") || u.pathname.endsWith("/me"))
      return route.fulfill({
        status: 401,
        json: { error: "mini_unauthorized" },
      });
    if (u.pathname.endsWith("/exchange"))
      return route.fulfill({
        json: { token: "c".repeat(64), tokenType: "Bearer" },
      });
    if (u.pathname.endsWith("/home"))
      return route.fulfill({
        json: {
          profile: { displayName: "Synthetic", preferredLanguage: "en" },
          points: { accountExists: true, balance: "0" },
          invitedCount: "0",
          redemptionCount: "0",
          activities: { participationEnabled: false },
          primaryAction: { kind: "bind_uid" },
          referral: {
            shareUrl: "https://t.me/TestBot?start=ref_SYNTHETIC",
            rewardAvailability: "disabled",
            rewardEligible: false,
            rewardedToday: "0",
            pendingCount: "0",
            pointsEarned: "0",
          },
        },
      });
    if (u.pathname.endsWith("/referrals"))
      return route.fulfill({ json: { items: [], nextCursor: null } });
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.goto("/mini.html?view=invite&brandId=foreign&botId=foreign");
  await expect(
    page.getByRole("heading", { name: "Invitation history" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy invite link" }),
  ).toBeVisible();
  expect(paths.some((p) => p.endsWith("/referrals"))).toBe(true);
  expect(paths.some((p) => p.includes("foreign"))).toBe(false);
});
