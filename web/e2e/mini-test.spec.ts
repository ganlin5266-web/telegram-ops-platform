import { test, expect } from "@playwright/test";
test("P1 entry outside Telegram refuses authentication without any API request", async ({
  page,
}) => {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/v1/mini/")) requests++;
  });
  await page.goto("/p1-mini-test.html");
  await expect(
    page.getByText("STAGING / TEST ONLY", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "连接 Telegram 身份" }).click();
  await expect(page.getByRole("status")).toContainText("telegram_required");
  expect(requests).toBe(0);
  await expect(page.getByRole("button", { name: "读取 /me" })).toBeDisabled();
});
test("P1 synthetic browser contract keeps bearer private and verifies logout rejection", async ({
  page,
}) => {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'window.Telegram={WebApp:{initData:"synthetic-browser-only",ready(){}}};',
    }),
  );
  const token = "b".repeat(64);
  let revoked = false;
  await page.route("**/v1/mini/**", async (route) => {
    const req = route.request();
    expect(req.headers().cookie).toBeUndefined();
    if (req.url().endsWith("/auth/exchange")) {
      expect(req.postDataJSON()).toEqual({
        appKey: "p1-staging-auth",
        initData: "synthetic-browser-only",
      });
      await route.fulfill({ json: { token, tokenType: "Bearer" } });
    } else if (req.url().endsWith("/auth/logout")) {
      expect(req.headers().authorization).toBe(`Bearer ${token}`);
      revoked = true;
      await route.fulfill({ json: { ok: true } });
    } else {
      expect(req.headers().authorization).toBe(`Bearer ${token}`);
      await route.fulfill(
        revoked
          ? { status: 401, json: { error: "mini_unauthorized" } }
          : {
              json: {
                userId: "11111111-1111-4111-8111-111111111111",
                brandId: "22222222-2222-4222-8222-222222222222",
                botId: "33333333-3333-4333-8333-333333333333",
                expiresAt: "2030-01-01T00:00:00Z",
              },
            },
      );
    }
  });
  await page.goto("/p1-mini-test.html");
  await page.getByRole("button", { name: "连接 Telegram 身份" }).click();
  await expect(page.getByRole("status")).toContainText("Session 已认证");
  await expect(page.locator("body")).not.toContainText(token);
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({ local: 0, session: 0 });
  await page.getByRole("button", { name: "Logout", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("撤销后的 /me 返回 401");
  await page.reload();
  await expect(page.getByRole("button", { name: "读取 /me" })).toBeDisabled();
});
