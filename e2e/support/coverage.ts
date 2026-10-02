import { test as base } from "@playwright/test"
import { writeFile } from "node:fs/promises"

export * from "@playwright/test"

// Opt-in collection changes timing. Keep performance benchmarks uninstrumented.
export const test = process.env.MATCH_E2E_COVERAGE === "1" ? base.extend<{ sourceCoverage: void }>({
  sourceCoverage: [async ({ page, browserName }, use, info) => {
    if (browserName !== "chromium" || info.file.endsWith("card-move-performance.spec.ts")) {
      await use()
      return
    }
    await page.coverage.startJSCoverage({ resetOnNavigation: false })
    await use()
    const unavailable = page.isClosed() ? "Fixture page closed before collection" : undefined
    const entries = (unavailable ? [] : await page.coverage.stopJSCoverage()).filter(entry => {
      const path = new URL(entry.url).pathname
      return path.startsWith("/src/") && !path.startsWith("/src/vendor/")
    })
    const path = info.outputPath("source-coverage.json")
    await writeFile(path, JSON.stringify({ title: info.titlePath.join(" > "), status: info.status, unavailable, entries }))
    await info.attach("source-coverage", { path, contentType: "application/json" })
  }, { auto: true }],
}) : base
