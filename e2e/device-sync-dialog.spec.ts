import { expect, test } from "@playwright/test"

test("Given Match is open in development, when the footer renders, then it shows the tower and honest dev build label", async ({ page }) => {
  await page.goto("/")

  const footer = page.getByRole("contentinfo", { name: "Match build information" })
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

  await page.getByRole("button", { name: "Menu", exact: true }).click()
  const drawer = page.getByRole("dialog", { name: "Navigation menu" })
  await drawer.getByRole("button", { name: "Sync, import & export" }).click()
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await dialog.evaluate(root => {
    const scopeAttribute = [...root.attributes].find(attribute => attribute.name.startsWith("data-v-"))?.name
    const devices = document.createElement("ul")
    devices.className = "mesh-device-list"
    devices.setAttribute("role", "list")
    devices.setAttribute("aria-label", "Devices for mobile test")
    if (scopeAttribute) devices.setAttribute(scopeAttribute, "")
    for (let index = 1; index <= 20; index += 1) {
      const device = document.createElement("li")
      device.className = "mesh-device"
      device.textContent = `Phone ${index}`
      if (scopeAttribute) device.setAttribute(scopeAttribute, "")
      devices.appendChild(device)
    }
    root.appendChild(devices)
  })
  const devices = dialog.getByRole("list", { name: "Devices for mobile test" })
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
