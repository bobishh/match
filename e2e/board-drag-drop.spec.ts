import { expect, test, type Page } from "@playwright/test"

async function createBlankWorkspace(page: Page, title: string) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const dialog = page.getByRole("dialog", { name: "Create workspace" })
  await dialog.getByLabel("Title").fill(title)
  await dialog.getByRole("radio", { name: "Blank board" }).check()
  await dialog.getByRole("button", { name: "Create" }).click()
}

async function createItem(page: Page, title: string, column: string) {
  await page.getByRole("button", { name: /Add item to/ }).first().click()
  const dialog = page.getByRole("dialog", { name: "Item details" })
  await dialog.getByLabel("Title *").fill(title)
  await dialog.getByLabel("Status *").selectOption({ label: column })
  await dialog.getByRole("button", { name: "Save item" }).click()
}

async function drag(page: Page, sourceSelector: string, targetSelector: string) {
  const source = page.locator(sourceSelector)
  const target = page.locator(targetSelector)
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error("Drag target missing")
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + Math.min(28, targetBox.height / 2), { steps: 12 })
  await page.mouse.up()
}

test.describe("Trello-like board dragging", () => {
  test("Given ordered cards, when a card crosses columns, then exact placement persists", async ({ page }) => {
    await createBlankWorkspace(page, "Drag board")
    await createItem(page, "First", "To do")
    await createItem(page, "Second", "To do")

    const source = '.lead-card[data-task-id]:has-text("Second")'
    const target = '[role="region"][aria-label="Doing"] .card-stack'
    await drag(page, source, target)

    await expect(page.getByRole("region", { name: "Doing" }).getByText("Second")).toBeVisible()
    await page.reload()
    await expect(page.getByRole("region", { name: "Doing" }).getByText("Second")).toBeVisible()
  })

  test("Given cards in one column, when one is dropped before another, then exact order persists", async ({ page }) => {
    await createBlankWorkspace(page, "Card order board")
    await createItem(page, "First", "To do")
    await createItem(page, "Second", "To do")
    await createItem(page, "Third", "To do")

    const source = await page.locator('.lead-card[data-task-id]:has-text("Third")').boundingBox()
    const target = await page.locator('.lead-card[data-task-id]:has-text("First")').boundingBox()
    if (!source || !target) throw new Error("Card drag target missing")
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(target.x + target.width / 2, target.y + 5, { steps: 16 })
    await page.mouse.up()

    const cards = page.getByRole("region", { name: "To do" }).locator(".lead-card")
    await expect(cards.nth(0)).toContainText("Third")
    await page.reload()
    await expect(page.getByRole("region", { name: "To do" }).locator(".lead-card").nth(0)).toContainText("Third")
  })

  test("Given persistence fails, when a card is dragged, then board restores and reports failure", async ({ page }) => {
    await createBlankWorkspace(page, "Failed drag board")
    await createItem(page, "Keep here", "To do")
    await page.evaluate(() => { (window as any).__MATCH_INJECT_STORAGE_FAILURE__ = true })

    await drag(page, '.lead-card[data-task-id]:has-text("Keep here")', '[role="region"][aria-label="Doing"] .card-stack')

    await expect(page.getByRole("status")).toContainText("Move failed")
    await expect(page.getByRole("region", { name: "To do" }).getByText("Keep here")).toBeVisible()
  })

  test("Given edit mode, when a column header is dragged, then column order persists", async ({ page }) => {
    await createBlankWorkspace(page, "Column drag board")
    await page.getByRole("button", { name: "Edit board" }).click()

    const source = await page.locator('[role="region"][aria-label="Done"] .column-header').boundingBox()
    const target = await page.locator('[role="region"][aria-label="To do"] .column-header').boundingBox()
    if (!source || !target) throw new Error("Column drag target missing")
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(target.x + 8, target.y + target.height / 2, { steps: 20 })
    await page.mouse.up()

    await expect(page.locator(".board > .column").first()).toHaveAttribute("aria-label", "Done")
    await page.reload()
    await expect(page.locator(".board > .column").first()).toHaveAttribute("aria-label", "Done")
  })
})
