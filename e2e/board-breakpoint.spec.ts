import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

test("Given a 640px board, when resizing to a phone, then compact columns become a navigable single column only at 560px", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 640, height: 900 })
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await expect(page.locator(".mobile-column-switcher")).toBeHidden()
  const columns = page.locator(".board > .column")
  const first = (await columns.nth(0).boundingBox())!
  const second = (await columns.nth(1).boundingBox())!
  expect(first.width).toBeLessThan(300)
  expect(second.x + second.width).toBeLessThanOrEqual(640)
  await page.screenshot({ path: testInfo.outputPath("compact-board-640.png"), fullPage: true })
  await page.setViewportSize({ width: 560, height: 900 })
  await expect(page.locator(".mobile-column-switcher")).toBeVisible()
  await expect(page.getByRole("button", { name: "Previous column" })).toBeDisabled()
  await page.getByRole("button", { name: "Next column" }).click()
  await expect(page.locator(".mobile-column-switcher")).toContainText("Applied")
  await page.setViewportSize({ width: 561, height: 900 })
  await expect(page.locator(".mobile-column-switcher")).toBeHidden()
  expect((await columns.nth(0).boundingBox())!.width).toBeLessThan(300)
})

test("Given a compact board with no search matches, when clearing search, then columns return without phone navigation", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 900 })
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await page.getByRole("searchbox", { name: "Search cards" }).fill("No matching vacancy")
  await expect(page.locator(".board-empty")).toBeVisible()
  await page.getByRole("button", { name: "Clear search and filters" }).click()
  await expect(page.locator(".board > .column").first()).toBeVisible()
  await expect(page.locator(".mobile-column-switcher")).toBeHidden()
})
