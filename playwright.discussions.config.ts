import { defineConfig } from "@playwright/test"
import config from "./playwright.config"

const testMatch = ["**/discussion-entry-points.spec.ts", "**/object-discussions.spec.ts", "**/conversation-windows.spec.ts", "**/root-message-links.spec.ts"]

export default defineConfig({
  ...config,
  projects: [
    { name: "discussion-chromium", testMatch, use: { browserName: "chromium" } },
    { name: "discussion-webkit", testMatch, use: { browserName: "webkit" } },
  ],
})
