import { test, expect } from "@playwright/test";
test("P4 real API browser upload preflight explicit activate duplicate and revision", async ({
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
  await expect(
    page.getByLabel("Telegram Bot", { exact: true }),
  ).not.toHaveValue("");
  const brand = await page.getByLabel("品牌", { exact: true }).inputValue(),
    bot = await page.getByLabel("Telegram Bot", { exact: true }).inputValue();
  const me = await (await page.request.get("/v1/me")).json();
  const res = await page.request.post(
    `/v1/brands/${brand}/bots/${bot}/platforms`,
    {
      headers: {
        Origin: "http://127.0.0.1:5173",
        "X-CSRF-Token": me.csrfToken,
      },
      data: {
        code: "P4_UI",
        displayName: "P4 Synthetic",
        market: "BR",
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        verificationMethod: "manual_admin",
        uidFormat: "alphanumeric",
        uidCase: "upper",
        uidMinLength: 1,
        uidMaxLength: 64,
      },
    },
  );
  expect(res.ok()).toBeTruthy();
  await page.getByRole("button", { name: "▤ 平台数据" }).click();
  await expect(
    page.getByRole("heading", {
      name: "平台数据 · 用户日报",
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
  await page.getByLabel("业务日期", { exact: true }).fill("2026-09-26");
  await page
    .getByRole("combobox", { name: "完整性", exact: true })
    .selectOption("complete");
  await page
    .getByLabel("导入说明", { exact: true })
    .fill("STAGING SYNTHETIC UI");
  await page.getByText("列映射与格式说明", { exact: true }).click();
  await page
    .getByLabel("显式列映射 JSON")
    .fill(
      JSON.stringify({
        uid: "uid",
        deposit: "deposit",
        withdrawal: "withdrawal",
        source_net: "source_net",
      }),
    );
  const csv =
    "uid,deposit,withdrawal,source_net\nBRTEST10001,100.00,30.00,70.00\nBRTEST_UNKNOWN01,0,,\n";
  await page
    .getByLabel("Excel / CSV", { exact: true })
    .setInputFiles({
      name: "STAGING-SYNTHETIC.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
  await page.getByRole("button", { name: "上传并预检" }).click();
  await expect(
    page.getByRole("heading", { name: "批次详情", exact: true }),
  ).toBeVisible();
  const activate = page.getByRole("button", {
    name: "确认 Activate",
    exact: true,
  });
  await expect(activate).toBeDisabled();
  await page
    .getByLabel("我已核对业务日期、范围、完整性及差异，确认激活此批次")
    .check();
  await activate.click();
  await expect(page.getByText("v1 / 未关联 Telegram").first()).toBeVisible();
  await page.getByRole("button", { name: "上传并预检" }).click();
  await expect(page.getByRole("button", { name: "预检详情" })).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "事实与 Revision" }),
  ).toHaveCount(2);
  await page.getByLabel("这是同日、同范围修正版（仍需预检与确认）").check();
  await page
    .getByLabel("Excel / CSV", { exact: true })
    .setInputFiles({
      name: "STAGING-SYNTHETIC-revision.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        csv.replace("100.00,30.00,70.00", "110.00,30.00,80.00"),
      ),
    });
  await page.getByRole("button", { name: "上传并预检" }).click();
  await expect(activate).toBeDisabled();
  await page
    .getByLabel("我已核对业务日期、范围、完整性及差异，确认激活此批次")
    .check();
  await activate.click();
  await expect(page.getByText("v2 / 未关联 Telegram")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "事实与 Revision" }),
  ).toHaveCount(2);
});
