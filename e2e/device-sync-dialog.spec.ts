import { expect, test } from "./support/coverage"

test("Given tincanban is open in development, when the footer renders, then it shows the tower and honest dev build label", async ({ page }) => {
  await page.goto("/")

  const footer = page.getByRole("contentinfo", { name: "tincanban build information" })
  await expect(footer.locator(".tower-mark")).toBeVisible()
  await expect(footer).toContainText("Berlin")
  await expect(footer).toContainText("Berlin · 2026")
  await expect(footer).toContainText("dev")
})

test("Given Device sync members are open, when the user wants to dismiss it, then only the header close control is shown", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Sync", exact: true }).click()

  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(1)
  await expect(dialog.getByText("Close", { exact: true })).toHaveCount(0)
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect(dialog).toBeHidden()
})

test("Given live sync is enabled without a connected peer, when Sync opens, then Stop remains available until explicitly stopped", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Sync", exact: true }).click()

  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog.getByRole("button", { name: "Stop live sync", exact: true })).toBeVisible()

  await dialog.getByRole("button", { name: "Stop live sync", exact: true }).click()
  await expect(dialog.getByRole("button", { name: "Start live sync", exact: true })).toBeVisible()

  await dialog.getByRole("button", { name: "Start live sync", exact: true }).click()
  await expect(dialog.getByRole("button", { name: "Stop live sync", exact: true })).toBeVisible()
})

test("Given Device sync shows an invalid-link failure, when it renders recovery actions, then Dismiss remains and Close is not duplicated", async ({ page }) => {
  await page.goto("/pair#invalid")

  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog.getByRole("alert")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(1)
  await expect(dialog.getByText("Close", { exact: true })).toHaveCount(0)
})

test("Given many devices on mobile, when their list is scrolled, then the list moves and the board stays locked", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 })
  await page.goto("/")
  const backgroundScroll = await page.evaluate(() => window.scrollY)

  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  await page.evaluate(async () => {
    const { mountMobileDeviceListDialog } = await import("/e2e/support/lighthouseDialog.ts")
    mountMobileDeviceListDialog()
  })
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await dialog.getByRole("button").filter({ hasText: "Mobile test participant" }).click()
  const devices = dialog.getByRole("list", { name: "Devices for Mobile test participant" })
  const boardTop = await page.locator(".board").evaluate(board => board.getBoundingClientRect().top)

  await expect.poll(() => devices.evaluate(list => list.scrollHeight > list.clientHeight)).toBe(true)
  await devices.hover()
  await page.mouse.wheel(0, 500)
  await expect.poll(() => devices.evaluate(list => list.scrollTop)).toBeGreaterThan(0)
  await expect(page.locator("body")).toHaveCSS("position", "fixed")
  expect(await page.locator(".board").evaluate(board => board.getBoundingClientRect().top)).toBe(boardTop)

  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(backgroundScroll)
})

test("Lighthouse uses its client marker for a beacon while a browser with the same name stays a browser", async ({ page }, testInfo) => {
  await page.goto("/")
  await page.evaluate(async () => {
    const { mountLighthouseDialog } = await import("/e2e/support/lighthouseDialog.ts")
    mountLighthouseDialog()
  })
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  const keepers = dialog.getByRole("list", { name: "Keeper services" })
  await expect(keepers).toContainText("Lighthouse service")
  await expect(dialog.getByRole("list", { name: "Mesh members" })).not.toContainText("Lighthouse service")
  await keepers.getByRole("button", { name: /Lighthouse service/ }).click()
  await dialog.screenshot({ path: testInfo.outputPath("tincanban-keeper-show.png"), animations: "disabled" })
  await expect(dialog.getByRole("heading", { name: "Lighthouse service" })).toBeVisible()
  await expect(dialog.getByRole("list", { name: "Mesh members" })).toHaveCount(0)
  const native = dialog.locator(".keeper-devices li").filter({ hasText: "Renamed worker" })
  await expect(native.getByRole("img", { name: "Rusty", exact: true })).toBeVisible()
  await expect(native).toContainText("Offline")
  await dialog.getByRole("button", { name: "Back" }).click()
  await dialog.getByRole("button").filter({ hasText: "Mesh participant" }).click()
  const browser = dialog.locator(".mesh-device").filter({ hasText: "Lighthouse" })
  await expect(browser.getByRole("img", { name: "Rusty", exact: true })).toHaveCount(0)
  await expect(browser).toContainText("Connected to this tab")
  await page.screenshot({ path: testInfo.outputPath("lighthouse-device.png") })
})

test("Given Device sync shows Keepers, when adding one, then compact form replaces other modal content and failure stays visible", async ({ page }, testInfo) => {
  await page.route("https://unreachable.invalid/**", route => route.fulfill({ status: 502, body: "Unavailable" }))
  await page.goto("/")
  await page.evaluate(async () => {
    const { mountLighthouseDialog } = await import("/e2e/support/lighthouseDialog.ts")
    mountLighthouseDialog()
  })
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await dialog.screenshot({ path: testInfo.outputPath("tincanban-keepers.png"), animations: "disabled" })
  await dialog.getByRole("button", { name: "Add keeper" }).click()
  await dialog.screenshot({ path: testInfo.outputPath("tincanban-keeper-create.png"), animations: "disabled" })
  await expect(dialog.getByRole("textbox", { name: "Keeper hostname" })).toBeVisible()
  await expect(dialog.getByRole("list", { name: "Mesh members" })).toHaveCount(0)
  await expect(dialog.getByRole("heading", { name: "Ownership succession" })).toHaveCount(0)
  await dialog.getByRole("textbox", { name: "Keeper hostname" }).fill("https://unreachable.invalid")
  await dialog.getByRole("button", { name: "Discover keeper" }).click()
  await expect(dialog.getByRole("alert")).toBeVisible()
  await dialog.getByRole("button", { name: "Back" }).click()
  await expect(dialog.getByRole("list", { name: "Keeper services" })).toContainText("Lighthouse service")
})
