import { expect, test } from "./support/coverage"

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

test("Given keeper removal fails, when owner retries, then error stays visible and successful retry removes the keeper", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/keeperRemoval.ts")).mountKeeperRemoval())

  const keepers = page.getByRole("list", { name: "Keeper services" })
  await keepers.getByRole("button", { name: /Old Lighthouse/ }).click()
  await page.getByRole("button", { name: "Remove keeper" }).click()
  await page.getByRole("button", { name: "Remove access from all boards" }).click()
  await expect(page.getByRole("button", { name: "Removing keeper…" })).toBeDisabled()
  await page.evaluate(() => (window as typeof window & { keeperRemoval: { fail(): void } }).keeperRemoval.fail())
  await expect(page.getByRole("alert")).toContainText("Could not revoke keeper")
  await expect(page.getByRole("button", { name: "Remove access from all boards" })).toBeEnabled()
  await page.getByRole("button", { name: "Back" }).click()
  await expect(keepers.getByRole("button", { name: /Old Lighthouse/ })).toBeVisible()
  await keepers.getByRole("button", { name: /Old Lighthouse/ }).click()
  await page.getByRole("button", { name: "Remove keeper" }).click()
  await page.getByRole("button", { name: "Remove access from all boards" }).click()
  await expect(page.getByRole("button", { name: "Removing keeper…" })).toBeDisabled()
  await page.evaluate(() => (window as typeof window & { keeperRemoval: { complete(): void } }).keeperRemoval.complete())
  await expect(keepers.getByRole("button", { name: /Old Lighthouse/ })).toHaveCount(0)
  expect(await page.evaluate(() => (window as typeof window & { keeperRemoval: { attempts(): number } }).keeperRemoval.attempts())).toBe(2)
})
