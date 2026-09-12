import { expect, test, type Page } from "@playwright/test"

async function blankBoard(page: Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const dialog = page.getByRole("dialog", { name: "Create workspace" })
  await dialog.getByLabel("Title", { exact: true }).fill("Interaction board")
  await dialog.getByRole("button", { name: "Create", exact: true }).click()
  await expect(dialog).toBeHidden()
}

test("Given mobile navigation, when settings open and close, then focus stays in the dialog and returns to Menu", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  const menu = page.getByRole("button", { name: "Menu", exact: true })
  await menu.click()
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Workspace settings", exact: true })
  await expect(dialog).toBeVisible()
  await expect.poll(() => dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
  await page.keyboard.press("Shift+Tab")
  await expect.poll(() => dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(menu).toBeFocused()
})

test("Given an empty form, when Escape is pressed, then it closes; a dirty draft survives a backdrop click", async ({ page }) => {
  await blankBoard(page)
  const add = page.getByRole("button", { name: "Add item to To do", exact: true })
  await add.click()
  const form = page.getByRole("dialog", { name: "Item details", exact: true })
  await page.keyboard.press("Escape")
  await expect(form).toBeHidden()
  await expect(add).toBeFocused()
  await add.click()
  await form.getByLabel("Title *", { exact: true }).fill("Keep this draft")
  await page.locator(".overlay").last().click({ position: { x: 5, y: 5 } })
  await expect(form).toBeVisible()
  await expect(form.getByLabel("Title *", { exact: true })).toHaveValue("Keep this draft")
  await form.getByRole("button", { name: "Save item", exact: true }).click()
  await expect(page.getByRole("button", { name: "Open Keep this draft", exact: true })).toBeVisible()
})

test("Given mobile save failure, when retry succeeds, then draft persists exactly once and save status recovers", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await blankBoard(page)
  await page.getByRole("button", { name: "Add item to To do", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Item details", exact: true })
  await form.getByLabel("Title *", { exact: true }).fill("Retry safely")
  await page.evaluate(() => { (window as any).__MATCH_INJECT_STORAGE_FAILURE__ = true })
  await form.getByRole("button", { name: "Save item", exact: true }).click()
  await expect(form.getByRole("alert")).toBeVisible()
  await expect(page.locator(".save-state:visible")).toContainText("Not saved")
  await expect(form.getByLabel("Title *", { exact: true })).toHaveValue("Retry safely")
  await expect(page.locator(".task-card")).toHaveCount(0)
  await page.evaluate(() => { (window as any).__MATCH_INJECT_STORAGE_FAILURE__ = false })
  await form.getByRole("button", { name: "Retry save", exact: true }).click()
  await expect(form).toBeHidden()
  await expect(page.getByRole("button", { name: "Open Retry safely", exact: true })).toHaveCount(1)
  await expect(page.getByLabel("Workspace presence")).toHaveText("1 card · 0 docs · 1 device")
  await expect(page.getByText("On this device", { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("button", { name: "Open Retry safely", exact: true })).toHaveCount(1)
})

test("Given a filtered mobile board, when no cards match, then result count and reset explain the empty state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await blankBoard(page)
  await page.getByRole("button", { name: "Add item to To do", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Item details", exact: true })
  await form.getByLabel("Title *", { exact: true }).fill("Visible again")
  await form.getByRole("button", { name: "Save item", exact: true }).click()
  await page.getByRole("button", { name: "Filters", exact: true }).click()
  await page.getByRole("group", { name: "Filters", exact: true }).getByRole("combobox", { name: "Status", exact: true }).selectOption({ label: "Doing" })
  await page.getByRole("button", { name: "Filters · 1", exact: true }).click()
  await page.getByRole("searchbox", { name: "Search cards", exact: true }).fill("no match")
  await expect(page.getByLabel("Workspace presence")).toContainText("0 of 1 cards")
  await expect(page.getByText("No matching cards", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Clear search and filters", exact: true }).click()
  await expect(page.getByRole("searchbox", { name: "Search cards", exact: true })).toHaveValue("")
  await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Open Visible again", exact: true })).toBeVisible()
})

test("Given slow startup, when data is not ready, then a stable shell shows delayed progress and recovers", async ({ page }) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route(/automerge.*\.wasm/, async route => {
    if (route.request().resourceType() === "fetch") await gate
    await route.continue()
  })
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await expect(page.locator(".boot-placeholder")).toBeVisible()
  await expect(page.getByText("Loading your cards", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeDisabled()
  release()
  await expect(page.locator(".boot-placeholder")).toBeHidden()
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
})

test("Given reduced motion, when mobile navigation opens and closes, then transitions do not delay interaction", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await page.getByRole("button", { name: "Menu", exact: true }).click()
  const drawer = page.getByRole("dialog", { name: "Navigation menu", exact: true })
  await expect(drawer).toBeVisible()
  expect(await drawer.evaluate(el => parseFloat(getComputedStyle(el).transitionDuration))).toBeLessThanOrEqual(0.001)
  await page.keyboard.press("Escape")
  await expect(drawer).toBeHidden()
  await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeFocused()
})

test("Given a pending save, when the user tries to edit or submit again, then the form waits and publishes one card", async ({ page }) => {
  await blankBoard(page)
  await page.getByRole("button", { name: "Add item to To do", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Item details", exact: true })
  await form.getByLabel("Title *", { exact: true }).fill("One durable card")
  await page.evaluate(async () => {
    const path = "/src/storage.ts"
    const { defaultStorage } = await import(path)
    const commit = defaultStorage.commitTransaction.bind(defaultStorage)
    defaultStorage.commitTransaction = async (...args: unknown[]) => {
      await new Promise<void>(resolve => { (window as any).__MATCH_RELEASE_SAVE__ = resolve })
      defaultStorage.commitTransaction = commit
      return commit(...args)
    }
  })
  await form.getByRole("button", { name: "Save item", exact: true }).click()
  await expect(form.getByRole("button", { name: "Saving…", exact: true })).toBeDisabled()
  await expect(form.getByLabel("Title *", { exact: true })).toBeDisabled()
  await expect(form.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled()
  await expect(page.locator(".save-state:visible")).toHaveText("Saving…")
  await page.keyboard.press("Escape")
  await expect(form).toBeVisible()
  await expect(page.locator(".task-card")).toHaveCount(0)
  await page.evaluate(() => (window as any).__MATCH_RELEASE_SAVE__())
  await expect(form).toBeHidden()
  await expect(page.getByRole("button", { name: "Open One durable card", exact: true })).toHaveCount(1)
})

test("Given fast startup, when data arrives before the progress delay, then no loading indicator flashes", async ({ page }) => {
  await page.clock.install()
  await page.clock.pauseAt(new Date())
  await page.addInitScript(() => {
    ;(window as any).__MATCH_SAW_LOADING__ = false
    new MutationObserver(() => {
      if (document.querySelector(".loading-indicator")) (window as any).__MATCH_SAW_LOADING__ = true
    }).observe(document, { childList: true, subtree: true })
  })
  await page.goto("/")
  await expect(page.getByRole("region", { name: "Untitled", exact: true })).toBeVisible()
  await page.clock.runFor(250)
  expect(await page.evaluate(() => (window as any).__MATCH_SAW_LOADING__)).toBe(false)
})
