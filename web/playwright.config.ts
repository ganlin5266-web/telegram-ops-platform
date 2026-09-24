import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
// Random credentials exist only in this test process and the isolated test server.
process.env.UI_TEST_PASSWORD ??= randomUUID() + randomUUID();
process.env.UI_TEST_LOGIN ??= `ui-${randomUUID()}`;
export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 45000,
  use: { baseURL: "http://127.0.0.1:5173", trace: "off", screenshot: "off" },
  webServer: [
    {
      command: "node --import tsx web/e2e/server.ts",
      cwd: "..",
      url: "http://127.0.0.1:3000/health",
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: "npm run dev -- --port 5173",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
    },
  ],
  reporter: "list",
});
