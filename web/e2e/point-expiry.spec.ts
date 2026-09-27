import { test, expect } from "@playwright/test";
test("P5-A real API draft preview publication without enabling lots", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("账号", { exact: true })
    .fill(process.env.UI_TEST_LOGIN! + "-p4");
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.UI_TEST_PASSWORD!);
  await page.getByRole("button", { name: "登录工作台 →" }).click();
  await expect(page.getByRole("heading", { name: "工作台总览" })).toBeVisible();
  await page.getByRole("button", { name: "积分有效期" }).click();
  await expect(page.getByText(/批次积分路径未启用/)).toBeVisible();
  await page.getByText("创建策略版本", { exact: true }).click();
  const name = "STAGING TEST ONLY browser policy";
  await page.getByLabel("策略名称").fill(name);
  await page.getByLabel("积分来源").fill("browser-test");
  await page.getByLabel("有效期模式").selectOption("fixed_deadline");
  await page.getByLabel("最后有效日期").fill("2099-12-31");
  await page.getByLabel("业务时区").fill("America/Sao_Paulo");
  await page.getByRole("button", { name: "预览策略" }).click();
  await expect(page.getByRole("heading", { name: "发布前预览" })).toBeVisible();
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByText(/v1 · 草稿/)).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "确认发布", exact: true }).click();
  await expect(page.getByText(/v1 · 已发布/)).toBeVisible();
  await expect(page.getByText(/有效至 2099/)).toBeVisible();
  await expect(page.getByText("暂无积分批次。")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "积分有效期" }).click();
  await expect(page.getByText(/v1 · 已发布/)).toBeVisible();
});
