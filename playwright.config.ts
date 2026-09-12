import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  // Multiple in-process Iroh meshes contend for browser/network resources.
  // Two workers preserve parallel coverage without producing false reconnect failures.
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://127.0.0.1:4244", trace: "retain-on-failure" },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4244",
    port: 4244,
    reuseExistingServer: false,
  },
})
