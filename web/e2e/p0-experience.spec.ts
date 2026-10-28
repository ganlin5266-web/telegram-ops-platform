import { test, expect, type Page } from "@playwright/test";
// Browser contract fixtures only. Actual SQL/authorization and no-write behavior
// are exercised independently by p0-mini-experience against PGlite and PG17.
const platform = {
  id: "22222222-2222-4222-8222-222222222222",
  displayName: "Synthetic BR",
  timezone: "America/Sao_Paulo",
};
const member = {
  enabled: true,
  available: true,
  level: 1,
  levelName: "Starter",
  growth: "0",
  nextThreshold: "500",
  progress: 0,
  todayCheckedIn: false,
  actualGrowthEarned: "0",
  checkinStatus: "available",
  canCheckin: true,
  checkinReward: "5",
  businessTimezone: "America/Sao_Paulo",
  nextAvailableAt: "2030-01-02T03:00:00.000Z",
};
const referral = {
  shareUrl: "https://t.me/SyntheticBot?start=ref_BROWSER_ONLY",
  rewardedToday: "5",
  qualifiedToday: "6",
  pendingCount: "1",
  capExceededCount: "1",
  dailyCap: 5,
  pointsEarned: "250",
  activity: { inviterPoints: "50", inviteePoints: "20", inviteeEnabled: true },
  rewardEligible: false,
  rewardAvailability: "disabled",
  businessDate: "2030-01-01",
  businessTimezone: "America/Sao_Paulo",
};
async function setup(
  page: Page,
  action = "checkin",
  locale = "zh-CN",
  greeting = "你好，P0",
) {
  let checked = false,
    checks = 0,
    creates = 0;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("https://telegram.org/js/telegram-web-app.js", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.Telegram={WebApp:{initData:"isolated-browser-fixture",ready(){},openTelegramLink(u){window.__share=u}}}',
    }),
  );
  await page.route("**/v1/mini/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/recover"))
      return route.fulfill({
        status: 401,
        json: { error: "mini_unauthorized" },
      });
    if (path.endsWith("/exchange"))
      return route.fulfill({
        json: { token: "d".repeat(64), tokenType: "Bearer" },
      });
    if (path.endsWith("/home"))
      return route.fulfill({
        json: {
          profile: {
            displayName: "P0",
            uiLanguage: locale,
            preferredLanguage: locale,
          },
          points: { accountExists: true, balance: "100" },
          member: {
            ...member,
            ...(checked
              ? {
                  todayCheckedIn: true,
                  actualGrowthEarned: "0",
                  canCheckin: false,
                  checkinStatus: "checked_in",
                }
              : {}),
          },
          platforms: [platform],
          currentPlatform: platform,
          identity: {
            status: action === "view_identity" ? "pending" : "verified",
          },
          primaryAction: {
            kind: checked ? "view_records" : action,
            platformId: platform.id,
          },
          recommendedRedemption: null,
          recentOrders: [],
          referral,
          invitedCount: "7",
          redemptionCount: "0",
          activities: { participationEnabled: false },
        },
      });
    if (path.endsWith("/member/checkin")) {
      checks++;
      checked = true;
      return route.fulfill({ json: { status: "complete" } });
    }
    if (path.endsWith("/referrals"))
      return route.fulfill({
        json: {
          items: [
            {
              id: "safe-1",
              created_at: "2030-01-01T12:00:00Z",
              displayStatus: "cap_exceeded",
              status: "bound",
              reward_status: "pending",
            },
          ],
          nextCursor: null,
        },
      });
    if (path.endsWith("/redemption-tiers"))
      return route.fulfill({ status: 403, json: { error: "forbidden" } });
    if (path.endsWith("/redemption-orders")) creates++;
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto("/mini.html");
  await expect(page.getByRole("heading", { name: greeting })).toBeVisible();
  return { checks: () => checks, creates: () => creates };
}
test("P0 one primary action, check-in actual zero, reload keeps done and Points unchanged", async ({
  page,
}) => {
  const f = await setup(page);
  await expect(page.locator("main .primary-action")).toHaveCount(1);
  await page
    .getByTestId("checkin-panel")
    .getByRole("button", { name: "立即签到" })
    .click();
  await expect(page.getByTestId("daily-done")).toContainText("0 Growth");
  await expect(page.getByTestId("today-focus")).toContainText("100");
  expect(f.checks()).toBe(1);
  await page.reload();
  await expect(page.getByTestId("daily-done")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "立即签到", exact: true }),
  ).toHaveCount(0);
  expect(f.checks()).toBe(1);
});
test("P0 gated invitation shares without promising reward; rewarded five differs from qualified six", async ({
  page,
}) => {
  await setup(page, "view_identity");
  await expect(page.getByTestId("primary-action")).toContainText("审核");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "邀请", exact: true })
    .click();
  await expect(page.getByTestId("invite-hero")).toContainText("5 / 5");
  await expect(page.locator(".invite-offer")).toHaveCount(0);
  await expect(page.locator(".record")).toContainText("超额");
  await page.getByRole("button", { name: "分享给好友" }).click();
  expect(await page.evaluate(() => (window as any).__share)).toContain(
    "SyntheticBot",
  );
});
test("P0 forbidden catalogue is an error, never a zero-stock display or create request", async ({
  page,
}) => {
  const f = await setup(page, "view_records");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "奖励", exact: true })
    .click();
  await page.getByRole("button", { name: "我的兑换", exact: true }).click();
  await expect(page.locator(".redemption-centre")).toContainText("权限");
  await expect(page.locator(".redemption-tier")).toHaveCount(0);
  expect(f.creates()).toBe(0);
});

for (const c of [
  [
    "zh-CN",
    "你好，P0",
    "每日签到 · 获得Growth",
    "邀请",
    "分享给好友",
    "奖励",
    "我的兑换",
    "你没有执行此操作的权限。",
  ],
  [
    "en",
    "Hello, P0",
    "Daily check-in · earn Growth",
    "Invite",
    "Share with friends",
    "Rewards",
    "My redemptions",
    "You do not have permission to perform this action.",
  ],
  [
    "pt-BR",
    "Olá, P0",
    "Check-in diário · ganhar Growth",
    "Convites",
    "Compartilhar com amigos",
    "Recompensas",
    "Minhas trocas",
    "Você não tem permissão para realizar esta ação.",
  ],
  [
    "es-MX",
    "Hola, P0",
    "Registro diario · ganar Growth",
    "Invitaciones",
    "Compartir con amigos",
    "Recompensas",
    "Mis canjes",
    "No tienes permiso para realizar esta acción.",
  ],
  [
    "fil",
    "Kumusta, P0",
    "Araw-araw na pag-check in · kumita ng Growth",
    "Mga imbitasyon",
    "Ibahagi sa mga kaibigan",
    "Mga gantimpala",
    "Aking mga redemption",
    "Wala kang pahintulot na gawin ito.",
  ],
]) {
  test(`P0 ${c[0]} renders home, check-in, invitation and permission error without fallback`, async ({
    page,
  }) => {
    const f = await setup(page, "checkin", c[0], c[1]);
    await expect(page.getByTestId("checkin-panel")).toContainText(c[2]);
    await page
      .getByRole("navigation")
      .getByRole("button", { name: c[3], exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: c[4], exact: true }),
    ).toBeVisible();
    await page
      .getByRole("navigation")
      .getByRole("button", { name: c[5], exact: true })
      .click();
    await page.getByRole("button", { name: c[6], exact: true }).click();
    await expect(page.locator(".redemption-centre")).toContainText(c[7]);
    await expect(
      page.getByText(
        "Full translation is being prepared. English is shown for now.",
      ),
    ).toHaveCount(0);
    expect(f.creates()).toBe(0);
  });
}
