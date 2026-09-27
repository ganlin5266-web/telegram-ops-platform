import { test, expect } from "@playwright/test";

test("product shell preserves admin identity and contains the user table on narrow screens", async ({
  page,
}) => {
  const user = {
    id: "synthetic-user",
    telegram_user_id: "5000000000",
    username: "synthetic",
    first_name: "Synthetic User",
    last_name: null,
    status: "active",
    telegram_language_code: "en",
    preferred_language: null,
    first_started_at: null,
    last_interaction_at: null,
  };
  await page.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = { items: [], nextCursor: null };
    if (path === "/v1/me")
      data = {
        displayName: "验收管理员",
        uiLanguage: "zh-CN",
        csrfToken: "synthetic-browser-only",
      };
    else if (path === "/v1/me/brands")
      data = {
        items: [
          {
            brandId: "brand",
            name: "Synthetic Brand",
            status: "active",
            defaultLanguage: "pt-BR",
          },
        ],
      };
    else if (path === "/v1/me/brands/brand/bots")
      data = {
        items: [
          {
            botId: "bot",
            name: "Synthetic Bot",
            status: "active",
            defaultLanguage: "pt-BR",
          },
        ],
      };
    else if (path === "/v1/me/permissions")
      data = { permissions: ["users.read"], grants: [] };
    else if (path.endsWith("/users/count")) data = { total: "1" };
    else if (path.endsWith("/users"))
      data = { items: [user], nextCursor: null };
    else if (path.endsWith("/users/synthetic-user")) data = user;
    else if (path.endsWith("/points/summary"))
      data = { balance: "0", totalEarned: "0", totalSpent: "0" };
    else if (path.endsWith("/points")) data = { balance: "0" };
    return route.fulfill({ json: data });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByText("验收管理员", { exact: true })).toBeVisible();
  await page.getByLabel("打开导航").click();
  await page.getByRole("button", { name: "◎ 用户", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  for (const width of [320, 390, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "查看详情", exact: true }).click();
  await expect(page.getByText("内部 User ID", { exact: true })).toBeVisible();
  expect(
    await page
      .getByRole("dialog", { name: "用户详情" })
      .evaluate((el) => Math.round(el.getBoundingClientRect().width)),
  ).toBe(390);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
