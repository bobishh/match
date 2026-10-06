import { defineConfig } from "@playwright/test"

const port = Number(process.env.TINCANBAN_E2E_PORT ?? 4344)
const remoteBaseURL = process.env.TINCANBAN_E2E_BASE_URL

// Packaging boundaries must hold in the emitted production assets.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/policy-transport-startup.spec.ts",
  workers: 1,
  retries: 0,
  use: { baseURL: remoteBaseURL ?? `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  webServer: remoteBaseURL ? undefined : {
    command: `npm run preview -- --host 127.0.0.1 --port ${port}`,
    port,
    reuseExistingServer: false,
  },
})
