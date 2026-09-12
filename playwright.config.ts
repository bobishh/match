import { defineConfig } from "@playwright/test"

const networkSpecs = [
  "**/chat.spec.ts",
  "**/durable-mesh.spec.ts",
  "**/scoped-sync.spec.ts",
  "**/succession.spec.ts",
  "**/sync.spec.ts",
  "**/workspace-roles.spec.ts",
  "**/workspace-sync-data.spec.ts",
]

const groupedNetworkSpecs = networkSpecs.filter(spec =>
  !spec.endsWith("scoped-sync.spec.ts") && !spec.endsWith("succession.spec.ts"))
const scopedIsolated = [
  { name: "scoped-enrollment", grep: /requires mutual approval/ },
  { name: "scoped-existing-board", grep: /visitor already has the owner's board/ },
  { name: "scoped-existing-identity", grep: /existing data under another identity/ },
  { name: "scoped-delegated-owner", grep: /delegated owner device/ },
]
const scopedIsolatedPattern = new RegExp(scopedIsolated.map(item => item.grep.source).join("|"))

export default defineConfig({
  testDir: "./e2e",
  // Iroh relay sessions can outlive a closed browser context briefly. Network specs
  // get distinct projects so each group owns a fresh browser/network process.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  projects: [
    { name: "core", testIgnore: networkSpecs },
    ...groupedNetworkSpecs.map(spec => ({
      name: spec.match(/([^/]+)\.spec\.ts$/)?.[1] ?? spec,
      testMatch: spec,
    })),
    { name: "scoped-sync", testMatch: "**/scoped-sync.spec.ts", grepInvert: scopedIsolatedPattern },
    ...scopedIsolated.map(project => ({ ...project, testMatch: "**/scoped-sync.spec.ts" })),
    { name: "succession-named", testMatch: "**/succession.spec.ts", grep: /owner names an editor successor/ },
    { name: "succession-quorum", testMatch: "**/succession.spec.ts", grep: /editor quorum recovery/ },
  ],
  use: { baseURL: "http://127.0.0.1:4244", trace: "retain-on-failure" },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4244",
    port: 4244,
    reuseExistingServer: false,
  },
})
