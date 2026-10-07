import { expect, test } from "./support/coverage"

test("Given the keeper details route, when Rusty appears on desktop and narrow mobile, then Rusty keeps TinCanBan visual size without horizontal overflow", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => {
    const { mountLighthouseDialog } = await import("/e2e/support/lighthouseDialog.ts")
    mountLighthouseDialog()
  })

  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await dialog.getByRole("list", { name: "Keeper services" }).getByRole("button", { name: /Lighthouse service/ }).click()
  const device = dialog.locator(".keeper-devices li").filter({ hasText: "Renamed worker" })
  const rusty = device.getByRole("img", { name: "Rusty", exact: true })
  await expect(rusty).toBeVisible()

  for (const viewport of [{ width: 1280, height: 800 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport)
    await expect.poll(async () => rusty.evaluate(image => image.getBoundingClientRect().width)).toBeGreaterThan(0)
    const sizes = await page.evaluate(() => {
      const rustyImage = document.querySelector<HTMLElement>('.keeper-devices li img[alt="Rusty"]')!
      const tinCanMark = document.querySelector<HTMLElement>(".brand-mark")!
      const row = rustyImage.closest("li")!
      const dialogElement = rustyImage.closest('[role="dialog"]')!
      const bounds = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect()
        return { width: rect.width, height: rect.height }
      }
      return {
        rusty: bounds(rustyImage),
        tinCan: bounds(tinCanMark),
        rowFits: row.scrollWidth <= row.clientWidth,
        dialogFits: dialogElement.scrollWidth <= dialogElement.clientWidth,
      }
    })

    expect(sizes.rusty.width).toBeGreaterThanOrEqual(sizes.tinCan.width)
    expect(sizes.rusty.height).toBeGreaterThanOrEqual(sizes.tinCan.height)
    expect(sizes.rowFits).toBe(true)
    expect(sizes.dialogFits).toBe(true)
  }
})
