import { expect, test, type Page } from "@playwright/test"

async function createBoard(page: Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title").fill("Focused work")
  await create.getByRole("radio", { name: "Blank board" }).check()
  await create.getByRole("button", { name: "Create", exact: true }).click()

  await page.getByRole("button", { name: "Workspace settings" }).click()
  const settings = page.getByRole("dialog", { name: "Workspace settings" })
  await settings.getByRole("tab", { name: "JSON", exact: true }).click()
  const editor = settings.getByLabel("Workspace settings JSON")
  const json = JSON.parse(await editor.inputValue())
  json.board.fields.push({ title: "Owner", valueType: "text", required: false })
  await editor.fill(JSON.stringify(json))
  await settings.getByRole("button", { name: "Apply JSON" }).click()

  for (const [title, status] of [["Launch design", "To do"], ["Launch review", "Doing"], ["Housekeeping", "Done"]]) {
    await page.getByRole("region", { name: status, exact: true }).getByRole("button", { name: `Add item to ${status}` }).click()
    const form = page.getByRole("dialog", { name: "Item details" })
    await form.getByLabel("Title *", { exact: true }).fill(title)
    await form.getByLabel("Body", { exact: true }).fill(`Context for ${title}: decisions and next steps.`)
    await form.getByLabel("Owner", { exact: true }).fill("Alex")
    await form.getByRole("button", { name: "Save item" }).click()
  }
}

test("Given a status filter, when one state remains, then its column fills the board and cards expose context", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await createBoard(page)
  await page.getByRole("group", { name: "Filters" }).getByRole("combobox", { name: "Status", exact: true }).selectOption({ label: "Doing" })
  await expect(page.locator(".board > .column")).toHaveCount(1)
  const column = page.getByRole("region", { name: "Doing", exact: true })
  expect((await column.boundingBox())!.width).toBeGreaterThan(1250)
  const card = column.getByRole("button", { name: "Open Launch review", exact: true })
  await expect(card.getByText("Context for Launch review: decisions and next steps.")).toBeVisible()
  await expect(card.getByText("Owner", { exact: true })).toBeVisible()
  await expect(card.getByText("Alex", { exact: true })).toBeVisible()
  await page.locator(".board").evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {}))))
  await page.screenshot({ path: testInfo.outputPath("single-state.png"), fullPage: true })
  await card.click()
  await expect(page.getByRole("dialog", { name: "Task overview" })).toBeVisible()
})

test("Given search results across two states, when search finds nothing then reset restores all states", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await createBoard(page)
  await page.getByRole("searchbox", { name: "Search cards" }).fill("Launch")
  await expect(page.locator(".board > .column")).toHaveCount(2)
  for (const column of await page.locator(".board > .column").all()) {
    expect((await column.boundingBox())!.width).toBeGreaterThan(600)
  }
  await page.getByRole("searchbox", { name: "Search cards" }).fill("missing-result")
  await expect(page.locator(".board > .column")).toHaveCount(0)
  await expect(page.getByText("No matching cards", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Clear search and filters" }).click()
  await expect(page.locator(".board > .column")).toHaveCount(3)
  await expect(page.locator(".board .lead-card")).toHaveCount(3)
})

test("Given a mobile status filter, when one column remains then it uses the screen without redundant navigation", async ({ page }, testInfo) => {
  await createBoard(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: /^Filters/ }).click()
  await page.getByRole("group", { name: "Filters" }).getByRole("combobox", { name: "Status", exact: true }).selectOption({ label: "Doing" })
  await expect(page.locator(".board > .column")).toHaveCount(1)
  await expect(page.getByRole("navigation", { name: "Board columns" })).toHaveCount(0)
  const column = await page.locator(".board > .column").boundingBox()
  expect(column!.width).toBeGreaterThanOrEqual(356)
  expect(column!.x + column!.width).toBeLessThanOrEqual(390)
  await expect(page.getByRole("button", { name: "Open Launch review", exact: true })).toBeVisible()
  await page.locator(".filters-panel").evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {}))))
  await page.screenshot({ path: testInfo.outputPath("mobile-single-state.png"), fullPage: true })
  await page.getByRole("searchbox", { name: "Search cards" }).fill("missing-result")
  await expect(page.locator(".board > .column")).toHaveCount(1)
  await expect(page.getByText("No matches in this column", { exact: true })).toBeVisible()
})

test("Given two filtered states, when a card moves between them then hidden cards survive reset and reload", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await createBoard(page)
  await page.getByRole("searchbox", { name: "Search cards" }).fill("Launch")
  await expect(page.locator(".board > .column")).toHaveCount(2)
  const source = page.getByRole("button", { name: "Open Launch design", exact: true })
  const target = page.getByRole("region", { name: "Doing", exact: true }).locator(".card-stack")
  const from = (await source.boundingBox())!
  const to = (await target.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height - 24, { steps: 18 })
  await expect(target.locator(".lead-card")).toHaveCount(2)
  await page.mouse.up()
  await expect(page.locator(".board > .column")).toHaveCount(1)
  await page.getByRole("button", { name: "Clear search and filters" }).click()
  await expect(page.getByRole("region", { name: "Done", exact: true }).getByRole("button", { name: "Open Housekeeping", exact: true })).toBeVisible()
  await page.reload()
  await expect(target.locator(".lead-card")).toHaveCount(2)
  await expect(page.locator(".board .lead-card")).toHaveCount(3)
})
