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
      await expect.poll(async () => (await archive.boundingBox())!.width).toBe(64)
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
  await expect(rejected.getByRole("button", { name: "Open Rejected with 0 cards" })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect.poll(() => rejected.evaluate(element => getComputedStyle(element, "::before").content)).toBe("none")
  await expect(archive.getByRole("button", { name: "Open Archive with 0 cards" })).toBeVisible()
  await expect(archive.getByRole("button", { name: "Open Archive with 0 cards" })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect.poll(() => archive.evaluate(element => getComputedStyle(element, "::before").content)).toBe("none")
  await archive.getByRole("button", { name: "Open Archive with 0 cards" }).click()
  await expect(archive.getByText("No leads")).toBeVisible()
  await expect(rejected.getByRole("button", { name: "Open Rejected with 0 cards" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("region", { name: "Rejected", exact: true }).getByRole("button", { name: "Open Rejected with 0 cards" })).toBeVisible()
})

test("Given a collapsible column on desktop or mobile, when it closes and reopens, then width animates both ways", async ({ page }) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const rejected = page.getByRole("region", { name: "Rejected", exact: true })
  const width = async () => (await rejected.boundingBox())!.width

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await rejected.scrollIntoViewIfNeeded()
    const collapse = rejected.getByRole("button", { name: "Collapse Rejected" })
    await expect(collapse).toBeVisible()
    const expandedWidth = await width()
    await collapse.click()
    await page.waitForTimeout(60)
    const closingWidth = await width()
    expect(closingWidth).toBeGreaterThan(80)
    expect(closingWidth).toBeLessThan(expandedWidth - 8)
    await expect.poll(width).toBe(64)

    const open = rejected.getByRole("button", { name: /Open Rejected with/ })
    await open.click()
    await page.waitForTimeout(60)
    const openingWidth = await width()
    expect(openingWidth).toBeGreaterThan(84)
    expect(openingWidth).toBeLessThan(expandedWidth - 8)
    await expect.poll(width).toBeGreaterThan(200)
  }
})

test("Given archive role moves, when the board updates, then old preset bindings do not keep old column styled as Archive", async ({ page }) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const oldArchive = page.getByRole("region", { name: "Archive", exact: true })
  const nextArchive = page.getByRole("region", { name: "Rejected", exact: true })
  await expect(oldArchive).toHaveClass(/column-archived/)

  await page.evaluate(async () => {
    const { useTincanban } = await import("/src/state.ts")
    const { projectWorkspaceSettings } = await import("/src/domain/workspaceSettings.ts")
    const tincanban = useTincanban()
    const doc = tincanban.getActiveDoc()
    if (!doc) throw new Error("Workspace document unavailable")
    const settings = projectWorkspaceSettings(doc)
    const old = settings.board.columns.find(column => column.archive)
    const next = settings.board.columns.find(column => column.title === "Rejected")
    if (!old || !next) throw new Error("Expected old and new Archive columns")
    delete old.archive
    next.archive = true
    await tincanban.executeCommandAsync({ kind: "updateWorkspaceSettings", settings })
  })

  await expect(oldArchive).not.toHaveClass(/column-archived|bin-column/)
  await expect(nextArchive).toHaveClass(/bin-column/)
  await expect(nextArchive).toHaveClass(/column-rejected/)
  await nextArchive.getByRole("button", { name: "Open Rejected with 0 cards" }).click()
  await expect(nextArchive).toHaveClass(/bin-column-open/)
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


test.describe("Folded board motion", () => {

  test("Given a folded board, when opened, then paper appears before contents and reduced motion opens immediately", async ({ page }, info) => {
    await page.setViewportSize({ width: 1920, height: 900 })
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    const archive = page.getByRole("region", { name: "Archive", exact: true })
    await archive.getByRole("button", { name: /Open Archive with/ }).scrollIntoViewIfNeeded()
    await page.waitForTimeout(600)
    const ink = await archive.locator(".column-spine-mark").evaluate(element => getComputedStyle(element).backgroundColor)
    const frames = await archive.evaluate(async element => {
      const open = element.querySelector<HTMLButtonElement>(".column-closed")!
      const samples: { time: number; width: number; paper: number; contents: number; spineInk?: string; headerInk?: string }[] = []
      open.click()
      const start = performance.now()
      await new Promise<void>(resolve => {
        function sample() {
          const time = performance.now() - start
          const contents = element.querySelector(".card-stack")
          const mark = element.querySelector(".column-spine-mark")
          const header = element.querySelector(".column-header")
          samples.push({ time, width: element.getBoundingClientRect().width,
            paper: Number(getComputedStyle(element.querySelector(".column-paper")!).opacity),
            contents: contents ? Number(getComputedStyle(contents).opacity) : 0,
            spineInk: mark ? getComputedStyle(mark).backgroundColor : undefined,
            headerInk: header ? getComputedStyle(header, "::before").backgroundColor : undefined })
          if (time < 480) requestAnimationFrame(sample)
          else resolve()
        }
        requestAnimationFrame(sample)
      })
      return samples
    })
    expect(frames.filter(frame => frame.spineInk).every(frame => frame.spineInk === ink)).toBe(true)
    expect(frames.filter(frame => frame.headerInk).every(frame => frame.headerInk === ink)).toBe(true)
    const early = frames.find(frame => frame.time >= 60)!
    const paper = frames.find(frame => frame.time >= 180)!
    expect(early.width).toBeGreaterThan(64)
    expect(early.contents).toBe(0)
    expect(paper.paper).toBeGreaterThan(0)
    expect(paper.contents).toBe(0)
    expect(frames.at(-1)!.contents).toBe(1)
    await expect(archive.getByText("No leads", { exact: true })).toBeVisible()
    await page.waitForTimeout(700)
    await archive.getByRole("button", { name: "Collapse Archive", exact: true }).click()
    await expect.poll(async () => (await archive.boundingBox())!.width).toBe(64)
    await page.waitForTimeout(600)
    await expect(archive.locator(".column-spine-mark")).toHaveCSS("background-color", ink)
    await expect(archive.locator(".column-spine-mark")).toHaveCSS("opacity", "0.34")
    const edges = archive.locator(".column-spine-edges")
    const bounds = await edges.evaluate(element => {
      const box = element.getBoundingClientRect()
      return ["::before", "::after"].map(pseudo => {
        const style = getComputedStyle(element, pseudo)
        const height = parseFloat(style.height)
        const width = parseFloat(style.width)
        const matrix = new DOMMatrix(style.transform)
        const rotatedHeight = Math.abs(matrix.b * width) + Math.abs(matrix.d * height)
        const inset = parseFloat(pseudo === "::before" ? style.top : style.bottom)
        return inset > Math.abs(matrix.b * width) + 1 && inset + rotatedHeight < box.height
      })
    })
    expect(bounds).toEqual([true, true])
    await page.screenshot({ path: info.outputPath("folded-board.png") })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await archive.getByRole("button", { name: /Open Archive with/ }).click()
    await expect(archive.locator(".card-stack")).toHaveCSS("opacity", "1")
    await expect(archive.locator(".column-paper")).toHaveCSS("opacity", "1")
  })
})
