import { expect, test } from "@playwright/test";

test("Batch 3 admin previews, creates, publishes and disables an invite campaign", async ({
  page,
}) => {
  let rules: any[] = [];
  const posts: string[] = [];
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data: any = { items: [] };
    if (path === "/v1/me")
      data = {
        displayName: "活动管理员",
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
            name: "Staging Bot",
            username: "StagingBot",
            status: "active",
            defaultLanguage: "zh-CN",
          },
        ],
      };
    else if (path === "/v1/me/permissions")
      data = {
        permissions: [
          "referrals.read",
          "referrals.rules.manage",
          "referrals.rules.publish",
          "platforms.read",
        ],
        grants: [],
      };
    else if (path.endsWith("/platforms"))
      data = {
        items: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            code: "FUN66",
            display_name: "FUN66",
            timezone: "America/Sao_Paulo",
            status: "active",
          },
        ],
      };
    else if (path.endsWith("/referral-rules") && request.method() === "POST") {
      posts.push(request.postData() || "");
      const body = request.postDataJSON();
      rules = [
        {
          id: "22222222-2222-4222-8222-222222222222",
          platform_id: body.platformId,
          campaign_key: body.campaignKey,
          version: 1,
          status: "draft",
          effective_from: body.effectiveFrom,
          effective_until: body.effectiveUntil,
          inviter_points: "50",
          invitee_points: "20",
          invitee_enabled: body.inviteeEnabled,
        },
      ];
      data = rules[0];
    } else if (path.endsWith("/publish")) {
      rules[0].status = "published";
      data = rules[0];
    } else if (path.endsWith("/disable")) {
      rules[0].status = "disabled";
      data = rules[0];
    } else if (path.endsWith("/referral-rules")) data = { items: rules };
    await route.fulfill({ json: data });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "活动", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "邀请活动", level: 2 }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新建邀请活动" }).click();
  const dialog = page.getByRole("dialog", { name: "新建邀请活动" });
  await dialog
    .getByLabel("平台")
    .selectOption("11111111-1111-4111-8111-111111111111");
  await dialog.getByLabel("活动标识").fill("STAGING-LAUNCH");
  await dialog.getByLabel("开始日期").fill("2026-10-24");
  await dialog.getByLabel("长期有效").check();
  await dialog.getByLabel("合格后同时奖励被邀请人 20 Points").check();
  await dialog.getByRole("button", { name: "预览" }).click();
  await expect(dialog.getByTestId("referral-rule-preview")).toContainText(
    "邀请人 50 Points · 被邀请人 20 Points",
  );
  await dialog.getByRole("button", { name: "创建草稿" }).click();
  await expect(page.getByText("STAGING-LAUNCH")).toBeVisible();
  page.once("dialog", (item) => item.accept());
  await page.getByRole("button", { name: "发布" }).click();
  await expect(page.getByText("邀请活动已发布。")).toBeVisible();
  page.once("dialog", (item) => item.accept());
  await page.getByRole("button", { name: "停用" }).click();
  await expect(page.getByText("邀请活动已停用。")).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(posts[0]).not.toContain("token");
});

test("Batch 3 admin sends no campaign requests without referral permission", async ({
  page,
}) => {
  let referralRequests = 0;
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes("referral-rules")) referralRequests++;
    let data: any = { items: [] };
    if (path === "/v1/me")
      data = { displayName: "访客", uiLanguage: "zh-CN", csrfToken: "csrf" };
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
            name: "Staging Bot",
            status: "active",
            defaultLanguage: "zh-CN",
          },
        ],
      };
    else if (path === "/v1/me/permissions")
      data = { permissions: [], grants: [] };
    await route.fulfill({ json: data });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "活动", exact: true }).click();
  await expect(page.getByText("你没有查看邀请活动的权限。")).toBeVisible();
  expect(referralRequests).toBe(0);
});
