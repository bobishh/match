import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

test("Given a job-search board, when archive opens and closes at four widths, then columns retain geometry and archive styling", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 })
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
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

  for (const width of [1920, 1440, 1024, 390]) {
    await test.step(`${width}px: expand, inspect, and collapse archive`, async () => {
      await page.setViewportSize({ width, height: 900 })
      await expectSingleRow()
      await archive.getByRole("button", { name: "Open archive with 0 cards" }).click()
      await expect(archive.getByText("No leads")).toBeVisible()
      await expect(archive.locator('.column-header')).toHaveCSS('background-color', 'rgb(255, 253, 247)')
      await expect(archive.locator('.column-header')).toHaveCSS('color', 'rgb(23, 23, 23)')
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
})

test("Given collapsible Rejected and Archive columns, when each is toggled, then their local states stay independent", async ({ page }) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const rejected = page.getByRole("region", { name: "Rejected", exact: true })
  const archive = page.getByRole("region", { name: "Archive", exact: true })
  await rejected.getByRole("button", { name: "Collapse Rejected" }).click()
  await expect(rejected.getByRole("button", { name: "Open Rejected with 0 cards" })).toBeVisible()
  await expect(archive.getByRole("button", { name: "Open Archive with 0 cards" })).toBeVisible()
  await archive.getByRole("button", { name: "Open Archive with 0 cards" }).click()
  await expect(archive.getByText("No leads")).toBeVisible()
  await expect(rejected.getByRole("button", { name: "Open Rejected with 0 cards" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("region", { name: "Rejected", exact: true }).getByRole("button", { name: "Open Rejected with 0 cards" })).toBeVisible()
})

test("Given invalid local collapse preferences, when the board loads, then preferences recover and collapse controls remain usable", async ({ page }) => {
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem
    Storage.prototype.getItem = function (key: string) {
      return key.startsWith("tincanban:collapsed-columns:") ? "{" : getItem.call(this, key)
    }
  })
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const rejected = page.getByRole("region", { name: "Rejected", exact: true })
  await expect(rejected.getByRole("button", { name: "Collapse Rejected" })).toBeVisible()
  await rejected.getByRole("button", { name: "Collapse Rejected" }).click()
  await expect(rejected.getByRole("button", { name: "Open Rejected with 0 cards" })).toBeVisible()
})
