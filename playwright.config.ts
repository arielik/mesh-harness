import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e-web",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:7799", headless: true },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "node dist/main.mjs hub --config test/e2e-web/hub.yaml",
    url: "http://127.0.0.1:7799/health",
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
