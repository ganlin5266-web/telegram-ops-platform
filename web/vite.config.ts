import { defineConfig } from "vitest/config";
export default defineConfig({
  build: {
    rollupOptions: {
      input: { admin: "index.html", miniTest: "p1-mini-test.html" },
    },
  },
  server: { strictPort: true, proxy: { "/v1": "http://127.0.0.1:3000" } },
  test: {
    include: ["tests/**/*.test.tsx"],
    environment: "jsdom",
    restoreMocks: true,
  },
});
