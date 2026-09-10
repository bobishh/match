import { expect, test } from "@playwright/test"

for (const width of [1920, 1440, 1024, 390]) {
  test(`Given all job-search statuses at ${width}px, when archive opens and closes, then every column stays in one horizontal row`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/")
    const archive = page.getByRole("region", { name: "Archive", exact: true })
    await expect(archive).toBeAttached()

    async function expectSingleRow() {
      await expect.poll(async () => {
        const boxes = await page.locator(".board > .column").evaluateAll((columns) =>
          columns.map((column) => {
            const box = column.getBoundingClientRect()
            return { top: box.top, left: box.left, width: box.width }
          }),
        )
        return boxes.length === 6 && boxes.every((box, index) =>
          Math.abs(box.top - boxes[0]!.top) < 1 &&
          (index === 0 || box.left > boxes[index - 1]!.left) &&
          (index === boxes.length - 1 || box.width >= 200),
        )
      }).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }

    await expectSingleRow()
    await archive.getByRole("button", { name: "Open archive with 0 cards" }).click()
    await expect(archive.getByText("No cards")).toBeVisible()
    await expect(archive.locator('.column-header')).toHaveCSS('background-color', 'rgb(23, 23, 23)')
    await expect(archive.locator('.column-header')).toHaveCSS('color', 'rgb(255, 255, 255)')
    await expectSingleRow()
    await expect.poll(async () => {
      const archiveBox = await archive.boundingBox()
      const regularBox = await page.getByRole("region", { name: "Lead", exact: true }).boundingBox()
      return Math.abs(archiveBox!.width - regularBox!.width)
    }).toBeLessThan(1)
    await archive.getByRole("button", { name: "Collapse archive" }).click()
    await expectSingleRow()
    await expect.poll(async () => (await archive.boundingBox())!.width).toBe(76)
  })
}
