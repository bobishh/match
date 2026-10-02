import { expect, test } from "./support/coverage"
import { writeFile } from "node:fs/promises"
import { populatedBoard, moveFirst } from "./support/detailedBoard"

// Trace snapshots walk this detailed board on the measured main thread.
// Keep the CPU profile, but measure application work without that recorder.
test.use({ trace: "off" })

test("Given 55 detailed cards, when a card moves, then persistence does not stall the next board interaction", async ({ page }, testInfo) => {
  await populatedBoard(page)
  const session = await page.context().newCDPSession(page)
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  await session.send("Profiler.enable")
  await session.send("Profiler.start")
  await page.evaluate(() => {
    const tasks: number[] = []
    new PerformanceObserver(list => { for (const entry of list.getEntries()) tasks.push(entry.duration) }).observe({ type: "longtask" })
    Object.assign(window, { moveTasks: tasks })
  })
  await page.evaluate(() => Object.assign(window, {
    beforeMoveBoard: document.querySelector(".board"), beforeMoveNeighbor: document.querySelector('[data-item-id="performance-card-1"]'),
  }))
  await moveFirst(page)
  await expect(page.getByRole("region", { name: "Doing", exact: true }).getByText("Performance card 0", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Open Performance card 0", exact: true }).click({ position: { x: 20, y: 20 } })
  await expect(page.getByRole("dialog", { name: "Item overview" })).toBeVisible()
  const { profile } = await session.send("Profiler.stop")
  await writeFile(testInfo.outputPath("move.cpuprofile"), JSON.stringify(profile))
  expect(await page.evaluate(() => {
    const before = window as unknown as { beforeMoveBoard: Element; beforeMoveNeighbor: Element }
    return before.beforeMoveBoard === document.querySelector(".board") &&
      before.beforeMoveNeighbor === document.querySelector('[data-item-id="performance-card-1"]')
  })).toBe(true)
  const tasks = await page.evaluate(() => (window as unknown as { moveTasks: number[] }).moveTasks)
  console.info(`Card move, 55 detailed cards, 4x CPU: longest main-thread task ${Math.round(Math.max(0, ...tasks))}ms`)
  expect(Math.max(0, ...tasks)).toBeLessThan(200)
  // Cold startup is a durability check, separate from the throttled interaction.
  await session.send("Emulation.setCPUThrottlingRate", { rate: 1 })
  await page.reload()
  await expect(page.getByRole("region", { name: "Doing", exact: true }).getByText("Performance card 0", { exact: true })).toBeVisible({ timeout: 15000 })
})

