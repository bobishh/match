import { expect, test } from "@playwright/test"

test("Given a connected keeper, when owner removes it, then access removal waits for completion and keeper leaves the list", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/keeperRemoval.ts")).mountKeeperRemoval())

  const keepers = page.getByRole("list", { name: "Keeper services" })
  await keepers.getByRole("button", { name: /Old Lighthouse/ }).click()
  await page.getByRole("button", { name: "Remove keeper" }).click()
  await expect(page.getByText("Remove access from all owned boards?")).toBeVisible()
  await page.getByRole("button", { name: "Remove access from all boards" }).click()
  await expect(page.getByRole("button", { name: "Removing keeper…" })).toBeDisabled()
  await page.evaluate(() => (window as typeof window & { keeperRemoval: { complete(): void } }).keeperRemoval.complete())
  await expect(keepers.getByRole("button", { name: /Old Lighthouse/ })).toHaveCount(0)
})

test("Given keeper removal fails, when owner retries, then error stays visible and keeper remains selectable", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/keeperRemoval.ts")).mountKeeperRemoval())

  await page.getByRole("list", { name: "Keeper services" }).getByRole("button", { name: /Old Lighthouse/ }).click()
  await page.getByRole("button", { name: "Remove keeper" }).click()
  await page.getByRole("button", { name: "Remove access from all boards" }).click()
  await page.evaluate(() => (window as typeof window & { keeperRemoval: { fail(): void } }).keeperRemoval.fail())
  await expect(page.getByRole("alert")).toContainText("Could not revoke keeper")
  await expect(page.getByRole("button", { name: "Remove access from all boards" })).toBeEnabled()
  await page.getByRole("button", { name: "Back" }).click()
  await expect(page.getByRole("list", { name: "Keeper services" })).toContainText("Old Lighthouse")
})
