import { test, expect } from "@playwright/test";
test("P3 Mini account UI: pending is not verified, Reload recovery and masked verification", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let linked = false,
    verified = false;
  const token = "d".repeat(64);
  await page.route("https://telegram.org/js/telegram-web-app.js", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.Telegram={WebApp:{initData:"synthetic-p3-test",ready(){}}}',
    }),
  );
  await page.route("**/v1/mini/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const identity = {
      id: "test-id",
      platformName: "FUN66",
      uidMasked: "BR****01",
      status: verified ? "verified" : "pending",
      submittedAt: new Date().toISOString(),
    };
    if (path.endsWith("/recover") || path.endsWith("/exchange"))
      return route.fulfill({ json: { token, tokenType: "Bearer" } });
    if (path.endsWith("/home"))
      return route.fulfill({
        json: {
          profile: {
            displayName: "P3 用户",
            projectName: "Test",
            botName: "Test",
            uiLanguage: "zh-CN",
          },
          points: { accountExists: false, balance: null },
          invitedCount: "0",
          redemptionCount: "0",
          activities: { participationEnabled: false },
        },
      });
    if (path.endsWith("/platforms"))
      return route.fulfill({
        json: {
          items: [
            {
              id: "platform",
              display_name: "FUN66",
              status: "active",
              verification_method: "manual_admin",
              identity: linked ? identity : null,
            },
          ],
        },
      });
    if (path.endsWith("/platform-identities")) {
      if (route.request().method() === "POST") {
        expect(route.request().postDataJSON()).toEqual({
          platformId: "platform",
          uid: "BRTEST10001",
        });
        expect(route.request().headers()["idempotency-key"]).toBeTruthy();
        expect(route.request().headers()["x-mini-csrf"]).toBe("1");
        linked = true;
        return route.fulfill({ json: identity });
      }
      return route.fulfill({
        json: { items: linked ? [identity] : [], nextCursor: null },
      });
    }
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto("/mini.html");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "我的", exact: true })
    .click();
  await page.getByRole("button", { name: "平台账号", exact: true }).click();
  await page.getByRole("button", { name: "绑定账号", exact: true }).click();
  await page.getByRole("textbox").fill("BRTEST10001");
  await page.getByRole("button", { name: "提交验证" }).click();
  await expect(page.getByText("待验证", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("已验证", { exact: true })).toHaveCount(0);
  await expect(page.getByText("BRTEST10001", { exact: true })).toHaveCount(0);
  verified = true;
  await page.reload();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "我的", exact: true })
    .click();
  await page.getByRole("button", { name: "平台账号", exact: true }).click();
  await expect(page.getByText("已验证", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("BR****01").first()).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("P3 ordinary admin remains denied review and platform management by default", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("账号", { exact: true })
    .fill(process.env.UI_TEST_LOGIN!);
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.UI_TEST_PASSWORD!);
  await page.getByRole("button", { name: "登录工作台 →" }).click();
  await expect(page.getByRole("heading", { name: "工作台总览" })).toBeVisible();
  await page.getByRole("button", { name: "◎ 用户", exact: true }).click();
  await page
    .getByRole("button", { name: "UID绑定审核", exact: true })
    .first()
    .click();
  await expect(page.getByText("你没有权限查看此页面。")).toBeVisible();
  await page.getByRole("button", { name: "⚙ 设置", exact: true }).click();
  await page
    .getByRole("button", { name: "平台管理", exact: true })
    .first()
    .click();
  await expect(page.getByText("你没有权限查看此页面。")).toBeVisible();
});
