import { expect, test, type Page } from "@playwright/test"

async function createBlankBoard(page: Page, title: string) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const dialog = page.getByRole("dialog", { name: "Create workspace" })
  await dialog.getByLabel("Title").fill(title)
  await dialog.getByRole("radio", { name: "Blank board" }).check()
  await dialog.getByRole("button", { name: "Create" }).click()
}

async function addTask(page: Page, title: string) {
  await page.getByRole("region", { name: "To do" }).getByRole("button", { name: "Add item to To do" }).click()
  const dialog = page.getByRole("dialog", { name: "Item details" })
  await dialog.getByLabel("Title *").fill(title)
  await dialog.getByRole("button", { name: "Save item" }).click()
  await expect(page.getByRole("button", { name: `Open ${title}` })).toBeVisible()
}

test("Given an archived task, when Undo is pressed, then it returns to its original column and position", async ({ page }) => {
  await createBlankBoard(page, "Archive undo board")
  await addTask(page, "First task")
  await addTask(page, "Second task")

  await page.getByRole("button", { name: "Open First task" }).click()
  await page.getByRole("dialog", { name: "Task overview" }).getByRole("button", { name: "Archive task" }).click()
  const notice = page.getByRole("status").filter({ hasText: "Item archived" })
  await expect(notice.getByRole("button", { name: "Undo" })).toBeVisible()
  await notice.getByRole("button", { name: "Undo" }).click()

  const cards = page.getByRole("region", { name: "To do" }).locator(".lead-card")
  await expect(cards).toHaveCount(2)
  await expect(cards.first()).toContainText("First task")
})

test("Given archive persistence fails, when a task is archived, then the task remains visible and the failure is honest", async ({ page }) => {
  await createBlankBoard(page, "Archive failure board")
  await addTask(page, "Durable task")
  await page.getByRole("button", { name: "Open Durable task" }).click()
  await page.evaluate(() => { (window as any).__MATCH_INJECT_STORAGE_FAILURE__ = true })
  await page.getByRole("dialog", { name: "Task overview" }).getByRole("button", { name: "Archive task" }).click()

  await expect(page.getByRole("dialog", { name: "Task overview" }).getByRole("alert")).toContainText("Archive failed")
})

test("Given a mobile board, when navigating columns, then the next column peeks and the switcher changes the active column", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  const board = page.locator(".board")
  await expect(page.locator(".mobile-column-switcher")).toBeVisible()
  const layout = await board.evaluate((element) => {
    const first = element.querySelector<HTMLElement>(".column")!
    return { boardWidth: element.clientWidth, columnWidth: first.getBoundingClientRect().width, scrollWidth: element.scrollWidth }
  })
  expect(layout.columnWidth).toBeLessThan(layout.boardWidth)
  expect(layout.scrollWidth).toBeGreaterThan(layout.boardWidth)

  await page.getByRole("button", { name: "Next column" }).click()
  await expect(page.locator(".mobile-column-switcher")).toContainText("Applied")
  await expect(page.getByRole("region", { name: "Lead" }).getByRole("button", { name: "Add lead to Lead" })).toBeVisible()
})

test("Given a Job search lead, when Archive status is selected, then Undo stays available inside Lead details", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("region", { name: "Lead" }).getByRole("button", { name: "Add lead to Lead" }).click()
  const form = page.getByRole("dialog", { name: "Add item" })
  await form.getByLabel(/Company/).fill("Undo Corp")
  await form.getByLabel(/Role/).fill("Undo role")
  await form.getByRole("button", { name: "Create item" }).click()
  const detail = page.getByRole("dialog", { name: "Lead details" })
  await detail.getByRole("button", { name: "Archive" }).click()
  await expect(detail.getByRole("button", { name: "Undo archive" })).toBeVisible()
  await detail.getByRole("button", { name: "Undo archive" }).click()
  await expect(detail.getByRole("button", { name: "Undo archive" })).toHaveCount(0)
  await expect(detail.getByRole("button", { name: "Lead" })).toHaveClass(/active/)
})

for (const width of [360, 390, 430]) {
  test(`Given ${width}px mobile, when the board opens, then the next column peeks and Add follows the header`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/")
    const values = await page.getByRole("region", { name: "Job search", exact: true }).evaluate((board) => {
      const column = board.querySelector<HTMLElement>(".column:not(.bin-column)")!
      const add = column.querySelector<HTMLElement>(".column-add-button")!
      const header = column.querySelector<HTMLElement>(".column-header")!
      const next = column.nextElementSibling!.getBoundingClientRect()
      return { board: board.clientWidth, column: column.getBoundingClientRect().width, addTop: add.getBoundingClientRect().top, headerBottom: header.getBoundingClientRect().bottom, nextLeft: next.left, nextRight: next.right, viewport: innerWidth }
    })
    expect(values.column).toBeLessThan(values.board)
    expect(values.addTop - values.headerBottom).toBeGreaterThanOrEqual(0)
    expect(values.addTop - values.headerBottom).toBeLessThanOrEqual(16)
    expect(values.nextLeft).toBeLessThan(values.viewport)
    expect(values.nextRight).toBeGreaterThan(values.viewport)
  })
}

test("Given a lead dragged to Archive, when Undo fails then retries, then its original position survives reload", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.setViewportSize({ width: 1920, height: 1000 })
  await page.goto("/")
  for (const company of ["First", "Second"]) {
    await page.getByRole("button", { name: "Add lead to Lead", exact: true }).click()
    const form = page.getByRole("dialog", { name: "Add item", exact: true })
    await form.getByLabel("Company *", { exact: true }).fill(company)
    await form.getByLabel("Role *", { exact: true }).fill("Engineer")
    await form.getByRole("button", { name: "Create item", exact: true }).click()
    await page.getByRole("button", { name: "Close detail", exact: true }).click()
  }
  await page.getByRole("button", { name: "Open Archive with 0 cards", exact: true }).click()
  const archive = page.getByRole("region", { name: "Archive", exact: true })
  await expect.poll(async () => Math.abs((await archive.boundingBox())!.width - (await page.getByRole("region", { name: "Lead", exact: true }).boundingBox())!.width)).toBeLessThan(1)
  const source = page.getByRole("button", { name: "Open First — Engineer", exact: true })
  const from = (await source.boundingBox())!
  const to = (await archive.locator(".card-stack").boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + 24, { steps: 18 })
  await expect(archive.locator(".lead-card").filter({ hasText: "First" })).toHaveCount(1)
  await page.mouse.up()
  await expect(archive.getByRole("button", { name: "Open First — Engineer", exact: true })).toBeVisible()
  await page.evaluate(() => { (window as any).__MATCH_INJECT_STORAGE_FAILURE__ = true })
  await page.getByRole("button", { name: "Undo", exact: true }).click()
  await expect(page.getByRole("status").filter({ hasText: "Restore failed" })).toBeVisible()
  await expect(archive.getByRole("button", { name: "Open First — Engineer", exact: true })).toBeVisible()
  await page.evaluate(() => { (window as any).__MATCH_INJECT_STORAGE_FAILURE__ = false })
  await page.getByRole("button", { name: "Undo", exact: true }).click()
  const cards = page.getByRole("region", { name: "Lead", exact: true }).locator(".lead-card")
  await expect(cards).toHaveCount(2)
  await expect(cards.first()).toContainText("First")
  await page.reload()
  await expect(cards.first()).toContainText("First")
})

test("Given an archived item, when the workspace changes, then its Undo cannot act on the new board", async ({ page }) => {
  await createBlankBoard(page, "Undo source")
  await addTask(page, "Archived here")
  await page.getByRole("button", { name: "Open Archived here", exact: true }).click()
  await page.getByRole("button", { name: "Archive task", exact: true }).click()
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Open workspaces", exact: true }).click()
  await page.getByRole("dialog", { name: "Workspaces", exact: true }).getByRole("button", { name: "jobs", exact: true }).click()
  await expect(page.getByRole("region", { name: "Job search", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: /Undo/ })).toHaveCount(0)
})
