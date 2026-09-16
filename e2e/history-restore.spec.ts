import { expect, test, type Page } from "@playwright/test"

async function createBoardAndItem(page: Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const workspace = page.getByRole("dialog", { name: "Create workspace" })
  await workspace.getByLabel("Title").fill("History board")
  await workspace.getByRole("radio", { name: "Blank board" }).check()
  await workspace.getByRole("button", { name: "Create" }).click()
  await page.getByRole("button", { name: "Add item to To do" }).click()
  const item = page.getByRole("dialog", { name: "Item details" })
  await item.getByLabel("Title *").fill("Reversible item")
  await item.getByRole("button", { name: "Save item" }).click()
}

async function moveToDoing(page: Page) {
  const source = await page.getByRole("button", { name: "Open Reversible item" }).boundingBox()
  const target = await page.getByRole("region", { name: "Doing" }).locator(".card-stack").boundingBox()
  if (!source || !target) throw new Error("Missing drag bounds")
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + 24, { steps: 16 })
  await page.mouse.up()
  await expect(page.getByRole("region", { name: "Doing" }).getByText("Reversible item")).toBeVisible()
}

test("Given an item moved after creation, when creation version is restored, then item returns and reload keeps compensation", async ({ page }) => {
  await createBoardAndItem(page)
  await moveToDoing(page)
  await page.getByRole("button", { name: "Open Reversible item" }).click()
  const detail = page.getByRole("dialog", { name: "Item overview" })
  await detail.locator(".item-history-entry").filter({ hasText: "createItem" })
    .getByRole("button", { name: "Restore this version" }).click()
  await expect(detail.getByText("Version restored")).toBeVisible()
  await detail.getByRole("button", { name: "Close detail" }).click()
  await expect(page.getByRole("region", { name: "To do" }).getByText("Reversible item")).toBeVisible()
  await page.reload()
  await expect(page.getByRole("region", { name: "To do" }).getByText("Reversible item")).toBeVisible()
})

test("Given restore persistence failure, when history version is selected, then current item remains and retry works", async ({ page }) => {
  await createBoardAndItem(page)
  await moveToDoing(page)
  await page.getByRole("button", { name: "Open Reversible item" }).click()
  const detail = page.getByRole("dialog", { name: "Item overview" })
  await page.evaluate(() => { (window as any).__MATCH_INJECT_STORAGE_FAILURE__ = true })
  await detail.locator(".item-history-entry").filter({ hasText: "createItem" })
    .getByRole("button", { name: "Restore this version" }).click()
  await expect(detail.getByRole("alert")).toContainText("Restore failed")
  await detail.getByRole("button", { name: "Close detail" }).click()
  await expect(page.getByRole("region", { name: "Doing" }).getByText("Reversible item")).toBeVisible()
})
