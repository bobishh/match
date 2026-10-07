import { expect, test } from "./support/coverage"

test("a legacy orphaned workspace reappears and survives another tab saving", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "TINCANBAN // Untitled" })).toBeVisible()
  const older = await page.context().newPage()
  await older.goto("/")
  await expect(older.getByRole("heading", { name: "TINCANBAN // Untitled" })).toBeVisible()
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title", { exact: true }).fill("Twang recovery")
  await create.getByRole("button", { name: "Create", exact: true }).click()
  await expect(page.getByRole("heading", { name: "TINCANBAN // Twang recovery" })).toBeVisible()
  const id = await page.evaluate(() => localStorage.getItem("tincanban.active_workspace_id")!)
  // Simulate the already-deployed bug without deleting the document itself.
  await page.evaluate(id => {
    localStorage.removeItem(`tincanban.workspace-meta.${id}`)
    localStorage.setItem("tincanban.workspaces", "[]")
  }, id)
  await page.reload()
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await expect(page.locator(".workspace-switch").filter({ hasText: "Twang recovery" })).toBeVisible()

  await older.getByRole("button", { name: "Add item to To do" }).click()
  const item = older.getByRole("dialog", { name: "Item details" })
  await item.getByLabel("Title *").fill("Saved from old tab")
  await item.getByRole("button", { name: "Save item" }).click()
  await expect(older.getByRole("button", { name: "Open Saved from old tab" })).toBeVisible()
  await page.reload()
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await expect(page.locator(".workspace-switch").filter({ hasText: "Twang recovery" })).toBeVisible()
  await older.close()
})
