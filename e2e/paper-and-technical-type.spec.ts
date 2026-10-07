import { expect, test, type Locator } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

async function angle(locator: Locator) {
  return locator.evaluate(element => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform)
    return Math.atan2(matrix.b, matrix.a) * 180 / Math.PI
  })
}

test("Given paper buttons and cards, when hovered, then rotation is visible and clicking still opens the card", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto("/")
  await page.getByRole("button", { name: "Add item to To do", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Item details", exact: true })
  await form.getByLabel("Title *").fill("Paper card")
  const save = form.getByRole("button", { name: "Save item", exact: true })
  await save.hover()
  await expect.poll(async () => Math.abs(await angle(save))).toBeGreaterThan(2)
  await save.click()
  const card = page.locator(".lead-card").filter({ hasText: "Paper card" })
  await card.hover()
  await expect.poll(async () => Math.abs(await angle(card))).toBeGreaterThan(1)
  await page.screenshot({ path: info.outputPath("paper-card-hover.png") })
  await card.getByRole("button", { name: "Open Paper card", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Item overview", exact: true })).toBeVisible()

  await page.getByRole("button", { name: "Close detail", exact: true }).click()
  await page.emulateMedia({ reducedMotion: "reduce" })
  await card.hover()
  expect(await angle(card)).toBe(0)
})

test("Given archive, when expanded and collapsed, then open archive keeps strokes and collapsed columns stay white", async ({ page }, info) => {
  await page.setViewportSize({ width: 1920, height: 950 })
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const archive = page.getByRole("region", { name: "Archive", exact: true })
  const closed = archive.getByRole("button", { name: "Open Archive with 0 cards", exact: true })
  await expect(closed).toHaveCSS("color", "rgb(23, 23, 23)")
  await expect(closed).toHaveCSS("background-color", "rgb(255, 255, 255)")
  expect(await closed.evaluate(element => getComputedStyle(element, "::before").maskImage)).toBe("none")
  await closed.click()
  await expect(archive.getByText("No leads", { exact: true })).toBeVisible()
  const header = archive.locator(".column-header")
  await expect(header).toHaveCSS("color", "rgb(23, 23, 23)")
  expect(await header.evaluate(element => getComputedStyle(element, "::before").maskImage)).toContain("archive-hatch.svg")
  await page.screenshot({ path: info.outputPath("archive-crossed.png") })
  await archive.getByRole("button", { name: "Collapse Archive", exact: true }).click()
  await expect(closed).toBeVisible()
  await expect(closed).toHaveCSS("background-color", "rgb(255, 255, 255)")
  expect(await closed.evaluate(element => getComputedStyle(element, "::before").maskImage)).toBe("none")
})

test("Given mesh devices or an offline board and recovery words, when viewed or restore fails, then technical text remains readable in Fira Code", async ({ page }, info) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const sync = page.getByRole("dialog", { name: "Device sync", exact: true })
  const members = sync.getByRole("list", { name: "Mesh members" })
  const memberButtons = members.getByRole("button")
  if (await memberButtons.count()) {
    await memberButtons.first().click()
    const deviceId = sync.locator(".mesh-device-head code")
    await expect(deviceId).toHaveCSS("font-family", /Fira Code/)
    await expect(deviceId).toHaveCSS("font-variant-ligatures", "none")
  } else {
    await expect(members.getByText("No people connected to this board.", { exact: true })).toBeVisible()
  }
  await expect.poll(() => page.evaluate(() => document.fonts.check('400 15px "Fira Code"'))).toBe(true)
  await sync.getByRole("button", { name: "Close", exact: true }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await settings.getByRole("tab", { name: "Identity", exact: true }).click()
  await settings.getByRole("button", { name: "Recovery backup", exact: true }).click()
  const recovery = page.getByRole("dialog", { name: "Identity recovery", exact: true })
  const words = recovery.getByRole("textbox", { name: "Recovery words", exact: true })
  await words.fill("IIl10 O0 abcdef0123456789")
  await expect(words).toHaveCSS("font-family", /Fira Code/)
  const restore = recovery.getByRole("button", { name: "Restore identity", exact: true })
  await restore.hover({ force: true })
  expect(await angle(restore)).toBe(0)
  await recovery.getByRole("checkbox").check()
  await restore.click()
  await expect(recovery.getByRole("alert")).toBeVisible()
  await expect(words).toHaveValue("IIl10 O0 abcdef0123456789")
  await page.screenshot({ path: info.outputPath("technical-type-failure.png") })
})
