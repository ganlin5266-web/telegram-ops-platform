import { defineConfig } from "@playwright/test";
// UI-only acceptance: all API traffic is intercepted by these fixtures.
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["mini-v1.spec.ts", "product-shell.spec.ts"],
  workers: 1,
  timeout: 45000,
  use: { baseURL: "http://127.0.0.1:5181", trace: "off", screenshot: "off" },
  reporter: "list",
});
