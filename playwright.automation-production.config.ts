import { defineConfig } from "@playwright/test"
import { homedir } from "node:os"
import { join } from "node:path"

export default defineConfig({
  testDir: "./e2e",
  testMatch: "automation-production.spec.ts",
  outputDir: join(homedir(), ".local/share/tincanban-automation/production-acceptance/playwright-results"),
  workers: 1,
  retries: 0,
  timeout: 180_000,
  use: {
    baseURL: "https://match.meta-uber-engineer.dev",
    trace: "retain-on-failure",
  },
  reporter: "list",
})
