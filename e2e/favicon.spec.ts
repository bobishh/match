import { expect, test, type Page } from "@playwright/test"

async function faviconLoads(page: Page) {
  const href = await page.locator('link[rel="icon"][type="image/svg+xml"]').getAttribute("href")
  expect(href).toBe("/favicon.svg?v=5")

  const image = await page.evaluate(async (src) => {
    const icon = new Image()
    icon.src = src!
    await icon.decode()
    const canvas = document.createElement("canvas")
    canvas.width = 64
    canvas.height = 64
    const context = canvas.getContext("2d")!
    context.drawImage(icon, 0, 0)
    const pixel = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data]
    let crownPixels = 0
    for (let y = 0; y < 15; y++) {
      for (let x = 20; x < 44; x++) {
        const [red, green, blue, alpha] = pixel(x, y)
        if (alpha > 200 && red < 50 && green < 50 && blue < 50) crownPixels++
      }
    }
    return {
      width: icon.naturalWidth,
      height: icon.naturalHeight,
      corner: pixel(0, 0),
      center: pixel(32, 39),
      circleEdge: pixel(14, 39),
      crownPixels,
    }
  }, href)
  expect({ width: image.width, height: image.height }).toEqual({ width: 64, height: 64 })
  expect(image.corner[3]).toBe(0)
  for (const color of [image.center, image.circleEdge]) {
    expect(color[0]).toBeLessThan(160)
    expect(color[1]).toBeGreaterThan(180)
    expect(color[2]).toBeLessThan(180)
    expect(color[3]).toBe(255)
  }
  expect(image.crownPixels).toBeGreaterThan(10)
}

test("Given a ready board, when its tab opens, then Match icon loads", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
  await faviconLoads(page)
})

test("Given app startup fails, when its tab opens, then Match icon still loads", async ({ page }) => {
  await page.route("**/src/main.ts", route => route.abort())
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await faviconLoads(page)
})
