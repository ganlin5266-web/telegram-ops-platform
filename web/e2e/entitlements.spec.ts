import { test, expect } from "@playwright/test";
test("qualification admin navigation is isolated and remains disabled before approval", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("账号", { exact: true })
    .fill(process.env.UI_TEST_LOGIN! + "-p4");
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.UI_TEST_PASSWORD!);
  await page.getByRole("button", { name: "登录工作台 →", exact: true }).click();
  await expect(page.getByRole("heading", { name: "工作台总览" })).toBeVisible();
  await page.getByRole("button", { name: "会员权益" }).click();
  await expect(page.getByText("资格计算关闭；草稿与预览可用")).toBeVisible();
  await expect(page.getByText(/不发积分或游戏次数/)).toBeVisible();
  await page.getByRole("button", { name: "新建规则版本" }).click();
  await expect(
    page.getByRole("button", { name: "预览，不写资格" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "执行最多20个到期任务" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "计算记录", exact: true }).click();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
