import { expect, test } from "@playwright/test"

for (const unavailable of [false, true]) test(`Given workspace permissions ${unavailable ? "fail" : "load"}, when footer animation replays, then it completes without blocking controls`, async ({ page }) => {
  if (unavailable) await page.route("**/src/sync/workspaceAccessWorker.ts*", route => route.abort())
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto("/")
  const replay = page.getByRole("button", { name: "Replay tower animation", exact: true })
  await expect(replay).toBeVisible()
  if (unavailable) await expect(page.getByRole("alert").filter({ hasText: "permissions could not be verified" })).toBeVisible()
  else await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  await replay.click()
  await page.getByRole("button", { name: "Open workspaces", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Workspaces", exact: true })).toBeVisible()
  const tower = page.locator("berlin-tower")
  await expect(tower.locator("[data-tower-ball]")).toBeAttached()
  await expect.poll(() => tower.evaluate(element => element.shadowRoot!.querySelector("svg")!
    .getAnimations({ subtree: true }).every(animation => animation.playState === "finished"))).toBe(true)
  if (unavailable) await expect(page.getByRole("button", { name: /Add item to/ })).toHaveCount(0)
})
