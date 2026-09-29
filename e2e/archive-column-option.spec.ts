import { expect, test } from "@playwright/test"

async function createBlankBoard(page: import("@playwright/test").Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const dialog = page.getByRole("dialog", { name: "Create workspace" })
  await dialog.getByLabel("Title").fill("Archive option")
  await dialog.getByRole("radio", { name: "Blank board" }).check()
  await dialog.getByRole("button", { name: "Create" }).click()
}

test("Given a blank board, when Archive column is enabled and item archived, then one collapsible Archive contains item after reload", async ({ page }) => {
  await createBlankBoard(page)
  await page.getByRole("button", { name: "Edit board" }).click()
  const addArchive = page.getByRole("button", { name: "Add archive column" })
  await expect(addArchive).toBeVisible()
  await addArchive.click()
  await expect(addArchive).toHaveCount(0)
  await page.getByRole("button", { name: "Done" }).click()

  await page.getByRole("button", { name: "Add item to To do" }).click()
  const form = page.getByRole("dialog", { name: "Item details" })
  await form.getByLabel("Title *").fill("Keep this card")
  await form.getByRole("button", { name: "Save item" }).click()
  await page.getByRole("button", { name: "Open Keep this card" }).click()
  await page.getByRole("dialog", { name: "Item overview" }).getByRole("button", { name: "Archive item" }).click()

  await expect(page.getByRole("region", { name: "To do" }).getByRole("button", { name: "Open Keep this card" })).toHaveCount(0)
  await page.getByRole("button", { name: "Open Archive with 1 cards" }).click()
  await expect(page.getByRole("region", { name: "Archive" }).getByRole("button", { name: "Open Keep this card" })).toBeVisible()
  await page.reload()
  await page.getByRole("button", { name: "Open Archive with 1 cards" }).click()
  await expect(page.getByRole("region", { name: "Archive" }).getByRole("button", { name: "Open Keep this card" })).toBeVisible()
})

test("Given archive column save fails, when Add archive column is clicked, then option remains and board has no Archive", async ({ page }) => {
  await createBlankBoard(page)
  await page.getByRole("button", { name: "Edit board" }).click()
  await page.evaluate(() => { (window as any).__MATCH_INJECT_STORAGE_FAILURE__ = true })
  await page.getByRole("button", { name: "Add archive column" }).click()
  await expect(page.getByRole("button", { name: "Add archive column" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Archive", exact: true })).toHaveCount(0)
  await expect(page.getByRole("status").filter({ hasText: "Archive column failed" })).toBeVisible()
})

test("Given item archived before Archive column exists, when column is enabled, then item appears and restores", async ({ page }) => {
  await createBlankBoard(page)
  await page.getByRole("button", { name: "Add item to To do" }).click()
  const form = page.getByRole("dialog", { name: "Item details" })
  await form.getByLabel("Title *").fill("Earlier card")
  await form.getByRole("button", { name: "Save item" }).click()
  await page.getByRole("button", { name: "Open Earlier card" }).click()
  await page.getByRole("dialog", { name: "Item overview" }).getByRole("button", { name: "Archive item" }).click()

  await page.getByRole("button", { name: "Edit board" }).click()
  await page.getByRole("button", { name: "Add archive column" }).click()
  await page.getByRole("button", { name: "Done" }).click()
  await page.getByRole("button", { name: "Open Archive with 1 cards" }).click()
  await page.getByRole("region", { name: "Archive", exact: true }).getByRole("button", { name: "Open Earlier card" }).click()
  await page.getByRole("dialog", { name: "Item overview" }).getByRole("button", { name: "Restore item" }).click()
  await expect(page.getByRole("region", { name: "To do" }).getByRole("button", { name: "Open Earlier card" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Archive", exact: true }).getByRole("button", { name: "Open Earlier card" })).toHaveCount(0)
})
