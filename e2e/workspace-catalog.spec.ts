import { expect, test } from "@playwright/test"

test("a legacy orphaned workspace reappears and survives another tab saving", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "MATCH // Untitled" })).toBeVisible()
  const older = await page.context().newPage()
  await older.goto("/")
  await expect(older.getByRole("heading", { name: "MATCH // Untitled" })).toBeVisible()
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title", { exact: true }).fill("Twang recovery")
  await create.getByRole("button", { name: "Create", exact: true }).click()
  await expect(page.getByRole("heading", { name: "MATCH // Twang recovery" })).toBeVisible()
  const id = await page.evaluate(() => localStorage.getItem("match.active_workspace_id")!)
  // Simulate the already-deployed bug without deleting the document itself.
  await page.evaluate(id => {
    localStorage.removeItem(`match.workspace-meta.${id}`)
    localStorage.setItem("match.workspaces", "[]")
  }, id)
  await page.reload()
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await expect(page.getByRole("button", { name: /Twang recovery/ })).toBeVisible()

  await older.getByRole("button", { name: "Add item to To do" }).click()
  const item = older.getByRole("dialog", { name: "Item details" })
  await item.getByLabel("Title *").fill("Saved from old tab")
  await item.getByRole("button", { name: "Save item" }).click()
  await expect(older.getByRole("button", { name: "Open Saved from old tab" })).toBeVisible()
  await page.reload()
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await expect(page.getByRole("button", { name: /Twang recovery/ })).toBeVisible()
  await older.close()
})
