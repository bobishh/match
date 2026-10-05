import { expect, test } from "./support/coverage"

async function createBoard(page: import("@playwright/test").Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const dialog = page.getByRole("dialog", { name: "Create workspace" })
  await dialog.getByLabel("Title").fill("Reading List")
  await dialog.getByRole("radio", { name: "Blank board" }).check()
  await dialog.getByRole("button", { name: "Create" }).click()
  await page.getByRole("button", { name: "Add item to To do" }).click()
  const form = page.getByRole("dialog", { name: "Item details" })
  await form.getByLabel("Title *").fill("Read Dune")
  await form.getByRole("button", { name: "Save item" }).click()
  await page.getByRole("button", { name: "Open Read Dune" }).click()
  return page.getByRole("dialog", { name: "Item overview" })
}

test("Given a generic card, when stage shortcut is clicked, then card moves and selection persists", async ({ page }) => {
  const detail = await createBoard(page)
  await expect(detail.getByRole("button", { name: "To do" })).toHaveClass(/active/)
  await detail.getByRole("button", { name: "Doing" }).click()
  await expect(detail.getByRole("button", { name: "Doing" })).toHaveClass(/active/)
  await detail.getByRole("button", { name: "Close detail" }).click()
  await expect(page.getByRole("region", { name: "Doing" }).getByRole("button", { name: "Open Read Dune" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("region", { name: "Doing" }).getByRole("button", { name: "Open Read Dune" })).toBeVisible()
})

test("Given a generic card, when stage move fails, then card stays put and error appears", async ({ page }) => {
  const detail = await createBoard(page)
  await page.evaluate(() => { (window as any).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })
  await detail.getByRole("button", { name: "Doing" }).click()
  await expect(detail.getByRole("alert")).toContainText("Storage failure injected")
  await expect(detail.getByRole("button", { name: "To do" })).toHaveClass(/active/)
  await detail.getByRole("button", { name: "Close detail" }).click()
  await expect(page.getByRole("region", { name: "To do" }).getByRole("button", { name: "Open Read Dune" })).toBeVisible()
})

test("Given board JSON, when stage buttons are configured, then card shows configured buttons and order", async ({ page }) => {
  await createBoard(page)
  await page.getByRole("dialog", { name: "Item overview" }).getByRole("button", { name: "Close detail" }).click()
  await page.getByRole("button", { name: "Settings" }).click()
  const settings = page.getByRole("dialog", { name: "Settings" })
  await settings.getByRole("tab", { name: "JSON" }).click()
  const editor = settings.getByLabel("Workspace settings JSON")
  const config = JSON.parse(await editor.inputValue())
  expect(config.board.cardStageButtons).toHaveLength(3)
  config.board.cardStageButtons = [
    { columnId: config.board.columns[2].id, label: "Finished" },
    { columnId: config.board.columns[0].id },
  ]
  await editor.fill(JSON.stringify(config, null, 2))
  await settings.getByRole("button", { name: "Apply JSON" }).click()
  await page.getByRole("button", { name: "Open Read Dune" }).click()
  const detail = page.getByRole("dialog", { name: "Item overview" })
  await expect(detail.locator(".status-strip button")).toHaveText(["Finished", "To do"])
  await expect(detail.getByRole("button", { name: "Doing" })).toHaveCount(0)
  await detail.getByRole("button", { name: "Finished" }).click()
  await detail.getByRole("button", { name: "Close detail" }).click()
  await page.reload()
  await expect(page.getByRole("region", { name: "Done" }).getByRole("button", { name: "Open Read Dune" })).toBeVisible()
  await page.getByRole("button", { name: "Open Read Dune" }).click()
  await expect(page.getByRole("dialog", { name: "Item overview" }).locator(".status-strip button")).toHaveText(["Finished", "To do"])
})

test("Given board JSON, when a button targets an absent column, then settings reject it", async ({ page }) => {
  await createBoard(page)
  await page.getByRole("dialog", { name: "Item overview" }).getByRole("button", { name: "Close detail" }).click()
  await page.getByRole("button", { name: "Settings" }).click()
  const settings = page.getByRole("dialog", { name: "Settings" })
  await settings.getByRole("tab", { name: "JSON" }).click()
  const editor = settings.getByLabel("Workspace settings JSON")
  const config = JSON.parse(await editor.inputValue())
  config.board.cardStageButtons = [{ columnId: "missing" }]
  await editor.fill(JSON.stringify(config, null, 2))
  await expect(settings.getByText("/board/cardStageButtons/0/columnId")).toBeVisible()
  await expect(settings.getByRole("button", { name: "Apply JSON" })).toBeDisabled()
})
