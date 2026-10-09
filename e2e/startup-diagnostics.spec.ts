import { expect, test } from "./support/coverage"

for (const status of [202, 503]) test(`Given startup debug and intake ${status}, When a mobile page reloads, Then phase checkpoints identify startup and the board stays usable`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const events: Array<{ event: string; operation: string; device_id: string; attrs: Record<string, unknown> }> = []
  await page.route("https://telemetry.invalid/events", async route => {
    const batch = route.request().postDataJSON()
    events.push(...batch.events)
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ accepted: batch.events.length }) })
  })
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30000 })
  await expect.poll(() => events.some(event => event.event === "startup.phase.completed" && event.attrs.stage === "start-sync")).toBe(true)
  const before = events.length
  await page.reload()
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30000 })
  await expect.poll(() => events.slice(before).some(event => event.event === "startup.phase.completed" && event.attrs.stage === "start-sync")).toBe(true)
  for (const stage of ["entry", "policy-wasm", "admission-worker-init", "automerge-wasm", "identity-load", "initial-workspace-load", "history-reclassification", "reclassify-admit-history", "workspace-projection", "personal-root-load", "start-sync", "access-active-workspace", "access-serialize", "access-policy", "access-current-owner", "access-ui-commit"]) {
    expect(events.slice(before).some(event => event.event === "startup.phase.started" && event.operation === stage)).toBe(true)
  }
  expect(events.slice(before).find(event => event.event === "startup.phase.completed" && event.operation === "access-serialize")?.attrs.bytes).toBeGreaterThan(0)
  expect(events.slice(before).find(event => event.attrs.stage === "entry")?.device_id).toBeTruthy()
  expect(JSON.stringify(events)).not.toContain("Safari/")
})
