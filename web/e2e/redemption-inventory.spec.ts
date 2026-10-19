import { expect, test } from "@playwright/test";

test("Batch 2B admin keeps inventory safe and reports duplicate imports", async ({
  page,
}) => {
  const requests: string[] = [];
  let reviewRequests = 0;
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data: unknown = { items: [] };
    if (path === "/v1/me")
      data = {
        displayName: "库存管理员",
        uiLanguage: "zh-CN",
        csrfToken: "csrf",
      };
    else if (path === "/v1/me/brands")
      data = {
        items: [
          {
            brandId: "brand",
            name: "Staging",
            status: "active",
            defaultLanguage: "zh-CN",
          },
        ],
      };
    else if (path === "/v1/me/brands/brand/bots")
      data = {
        items: [
          {
            botId: "bot",
            name: "Test Bot",
            status: "active",
            defaultLanguage: "zh-CN",
          },
        ],
      };
    else if (path === "/v1/me/permissions")
      data = {
        permissions: [
          "redemptions.read",
          "redemptions.inventory.manage",
          "redemptions.rules.manage",
          "redemptions.review",
          "platforms.read",
        ],
        grants: [],
      };
    else if (path.endsWith("/platforms"))
      data = {
        items: [
          {
            id: "platform-1",
            code: "FUN66",
            display_name: "FUN66",
            currency: "BRL",
            timezone: "America/Sao_Paulo",
            status: "active",
          },
        ],
      };
    else if (path.endsWith("/redemption-rules"))
      data = {
        items: [
          {
            id: "rule-1",
            platform_id: "platform-1",
            tier_key: "brl_10",
            version: 1,
            status: "published",
            name: "BRL 10",
            points_cost: "100",
            face_value: "10.00000000",
            face_currency: "BRL",
            effective_from: "2026-10-18",
            effective_until: null,
            enabled: true,
          },
        ],
      };
    else if (path.endsWith("/redemption-inventory"))
      data = {
        items: [
          {
            platform_id: "platform-1",
            rule_id: "rule-1",
            total: 6,
            available: 3,
            expired: 1,
            disabled: 1,
            assigned: 1,
            claimed: 0,
          },
        ],
      };
    else if (
      path.endsWith("/redemptions/order-1/review") &&
      request.method() === "POST"
    ) {
      reviewRequests++;
      data = { id: "order-1", status: "review_required" };
    } else if (path.endsWith("/redemptions"))
      data = {
        items: [
          {
            id: "order-1",
            platform_id: "platform-1",
            points_cost: "100",
            status: "code_claimed",
            business_date: "2026-10-19",
            review_reason: null,
            created_at: "2026-10-19T00:00:00Z",
            tier_key: "brl_10",
            face_value: "10",
            face_currency: "BRL",
          },
        ],
      };
    else if (
      path.endsWith("/redemption-code-batches") &&
      request.method() === "POST"
    ) {
      requests.push(request.postData() || "");
      data = {
        status: "rejected",
        total_count: 2,
        imported_count: 0,
        duplicate_count: 2,
      };
    } else if (path.endsWith("/redemption-code-batches")) data = { items: [] };
    await route.fulfill({ json: data });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "积分", exact: true }).click();
  await page.getByRole("button", { name: "兑换码库存", exact: true }).click();
  await expect(page.getByText("固定兑换档位与兑换码库存")).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "3", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "1", exact: true })).toHaveCount(
    3,
  );
  await page.getByRole("button", { name: "批量导入兑换码" }).click();
  await page
    .getByLabel("兑换码（每行一个，最多 500 个）")
    .fill("PRIVATE-A\nPRIVATE-A");
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(
    page.getByText(/整批未导入：发现 2 个同平台重复码/),
  ).toBeVisible();
  await expect(page.getByLabel("兑换码（每行一个，最多 500 个）")).toHaveValue(
    "",
  );
  await expect(page.getByText("PRIVATE-A")).toHaveCount(0);
  expect(requests).toHaveLength(1);
  await page
    .getByRole("dialog", { name: "批量导入兑换码" })
    .getByRole("button", { name: "关闭" })
    .click();
  await expect(page.getByRole("cell", { name: "code_claimed" })).toBeVisible();
  await page.getByRole("button", { name: "标记待核实" }).click();
  await expect(page.getByText("订单已进入人工核实。")).toBeVisible();
  expect(reviewRequests).toBe(1);
  await expect(page.locator("body")).not.toContainText(
    /PRIVATE-CODE|code_secret/,
  );
});

test("Batch 2B admin does not request inventory without permission", async ({
  page,
}) => {
  let inventoryRequests = 0;
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes("redemption-")) inventoryRequests++;
    let data: unknown = { items: [] };
    if (path === "/v1/me")
      data = {
        displayName: "只读管理员",
        uiLanguage: "zh-CN",
        csrfToken: "csrf",
      };
    else if (path === "/v1/me/brands")
      data = {
        items: [
          {
            brandId: "brand",
            name: "Staging",
            status: "active",
            defaultLanguage: "zh-CN",
          },
        ],
      };
    else if (path === "/v1/me/brands/brand/bots")
      data = {
        items: [
          {
            botId: "bot",
            name: "Test Bot",
            status: "active",
            defaultLanguage: "zh-CN",
          },
        ],
      };
    else if (path === "/v1/me/permissions")
      data = { permissions: ["points.read"], grants: [] };
    await route.fulfill({ json: data });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "积分", exact: true }).click();
  await page.getByRole("button", { name: "兑换码库存", exact: true }).click();
  await expect(page.getByText(/没有查看兑换配置与库存的权限/)).toBeVisible();
  expect(inventoryRequests).toBe(0);
});
