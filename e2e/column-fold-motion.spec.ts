import { writeFile } from "node:fs/promises"
import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

test.use({ video: { mode: "on", size: { width: 1600, height: 900 } } })

test("Given a wide board, when a column folds and opens, then its width and visible title move continuously", async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await page.evaluate(() => document.fonts.ready)
  const column = page.getByRole("region", { name: "Rejected", exact: true })
  await expect(column.locator(".column-fold-title")).toHaveText("Rejected")
  await expect(column.locator(".column-fold-count")).toHaveText("0")
  const directions: { time: number; width: number; angle: number }[][] = []
  for (const collapsed of [true, false]) {
    const frames = await column.evaluate(async (element, collapse) => {
      let motionStarted = false
      const read = () => {
        const title = element.querySelector<HTMLElement>(".column-fold-title")!
        const count = element.querySelector<HTMLElement>(".column-fold-count")!
        const surface = element.querySelector<HTMLElement>(".column-fold-cover")!
        const motion = surface.getAnimations()[0]
        if (motion) motionStarted = true
        const motionTime = typeof motion?.currentTime === "number" ? motion.currentTime : motionStarted ? 520 : 0
        const matrix = new DOMMatrix(getComputedStyle(surface).transform)
        return { motionTime, angle: Math.atan2(matrix.b, matrix.a) * 180 / Math.PI, time: performance.now(), width: element.getBoundingClientRect().width,
          titleY: title.getBoundingClientRect().top - element.getBoundingClientRect().top,
          countY: count.getBoundingClientRect().top - element.getBoundingClientRect().top,
          titleOpacity: Number(getComputedStyle(title).opacity), countOpacity: Number(getComputedStyle(count).opacity),
          ink: getComputedStyle(surface, "::before").backgroundColor,
          hatchOpacity: getComputedStyle(surface, "::before").opacity }
      }
      const frames = [read()]
      element.querySelector<HTMLButtonElement>(collapse ? ".bin-close" : ".column-closed")!.click()
      const start = performance.now()
      await new Promise<void>(resolve => {
        const sample = () => {
          frames.push(read())
          if (performance.now() - start < 650) requestAnimationFrame(sample)
          else resolve()
        }
        requestAnimationFrame(sample)
      })
      return frames
    }, collapsed)
    directions.push(frames.map(frame => ({ time: frame.motionTime, width: frame.width, angle: frame.angle })))
    expect(frames.every(frame => frame.titleOpacity === 1 && frame.countOpacity === 1)).toBe(true)
    expect(Math.max(...frames.map(frame => frame.titleY))).toBeLessThan(85)
    expect(Math.max(...frames.map(frame => frame.countY))).toBeLessThan(40)
    expect(new Set(frames.map(frame => frame.ink)).size).toBe(1)
    expect(new Set(frames.map(frame => frame.hatchOpacity)).size).toBe(1)
    expect(Math.abs(frames[1]!.width - frames[0]!.width)).toBeLessThan(4)
    const travel = Math.abs(frames.at(-1)!.width - frames[0]!.width)
    for (let i = 1; i < frames.length; i++) {
      if (frames[i]!.time - frames[i - 1]!.time < 25)
        expect(Math.abs(frames[i]!.width - frames[i - 1]!.width)).toBeLessThan(travel * .14)
    }
    await expect.poll(async () => column.evaluate(element => {
      const actual = element.querySelector(".column-fold-count")!.getBoundingClientRect()
      const target = element.querySelector(element.classList.contains("column-collapsed") ? ".column-closed .count" : ".column-header .count")!.getBoundingClientRect()
      return Math.max(Math.abs(actual.x - target.x), Math.abs(actual.y - target.y))
    })).toBeLessThan(1)
    await page.screenshot({ path: info.outputPath(collapsed ? "folded.png" : "open.png") })
  }
  const motionPath = info.outputPath("motion-frames.json")
  await writeFile(motionPath, JSON.stringify(directions))
  await info.attach("motion-frames", { path: motionPath, contentType: "application/json" })
  const [closing, opening] = directions
  const atTime = (frames: NonNullable<typeof closing>, time: number) => {
    const index = frames.findIndex(frame => frame.time >= time)
    const after = frames[index]!
    const before = frames[Math.max(0, index - 1)]!
    const progress = (time - before.time) / Math.max(1, after.time - before.time)
    return { angle: before.angle + (after.angle - before.angle) * progress,
      width: before.width + (after.width - before.width) * progress }
  }
  const travel = Math.abs(closing![0]!.width - closing!.at(-1)!.width)
  for (const time of [100, 180, 260, 340, 420]) {
    const folded = atTime(closing!, time)
    const unfolded = atTime(opening!, 520 - time)
    expect(Math.abs(folded.angle - unfolded.angle)).toBeLessThan(5)
    expect(Math.abs(folded.width - unfolded.width)).toBeLessThan(travel * .05)
  }
  await expect(column.getByText("No leads", { exact: true })).toBeVisible()
})
