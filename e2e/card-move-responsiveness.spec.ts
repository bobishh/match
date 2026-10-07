import { expect, test } from "./support/coverage"
import { writeFile } from "node:fs/promises"
import { populatedBoard } from "./support/detailedBoard"
import { installWorkspacePhaseProbe, readWorkspacePhaseProbe } from "./support/workspacePhaseProbe"

// Trace snapshots walk this detailed board on the measured main thread.
// Keep the CPU profile, but measure application work without that recorder.
test.use({ trace: "off", reducedMotion: "no-preference" })

test("Given 55 detailed cards, when a card moves, then persistence does not stall the next board interaction", async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  await installWorkspacePhaseProbe(page)
  await populatedBoard(page)
  const session = await page.context().newCDPSession(page)
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  await session.send("Profiler.enable")
  await page.evaluate(() => {
    const tasks: number[] = []
    const taskObserver = new PerformanceObserver(list => { for (const entry of list.getEntries()) tasks.push(entry.duration) })
    taskObserver.observe({ type: "longtask" })
    Object.assign(window, { moveTasks: tasks, moveTaskObserver: taskObserver })
  })
  const points = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-item-id="performance-card-0"]')!
    const stack = [...document.querySelectorAll<HTMLElement>(".card-stack")].find(element => {
      const title = element.closest(".column")?.querySelector(".column-title h2")?.textContent
      return title === "Doing"
    })!
    const cardRect = card.getBoundingClientRect()
    const stackRect = stack.getBoundingClientRect()
    Object.assign(window, { beforeMoveBoard: document.querySelector(".board"), beforeMoveNeighbor: document.querySelector('[data-item-id="performance-card-1"]') })
    return { sourceX: cardRect.x + 4, sourceY: cardRect.y + 4, targetX: stackRect.x + stackRect.width / 2, targetY: stackRect.y + 28 }
  })
  await session.send("Profiler.start")
  await page.mouse.move(points.sourceX, points.sourceY)
  await page.mouse.down()
  await page.mouse.move(points.targetX, points.targetY, { steps: 15 })
  await expect(page.locator(".board-drop-marker")).toHaveAttribute("data-target-id", await page.getByRole("region", { name: "Doing", exact: true }).getAttribute("data-column-id"))
  await page.mouse.up()
  await page.waitForFunction(() => {
    const movedCard = document.querySelector('[data-item-id="performance-card-0"]')
    return movedCard?.closest(".card-stack")?.closest(".column")?.querySelector(".column-title h2")?.textContent === "Doing" &&
      [...document.querySelectorAll("[role=status]")].some(element => element.textContent?.includes("Item moved"))
  }, undefined, { timeout: 15_000 })
  await page.getByRole("button", { name: "Open Performance card 0", exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[role="dialog"][aria-label="Item overview"]'))
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const { profile } = await session.send("Profiler.stop")
  const measured = await page.evaluate(() => {
    const windowState = window as unknown as { moveTasks: number[]; moveTaskObserver: PerformanceObserver; beforeMoveBoard: Element; beforeMoveNeighbor: Element }
    const tasks = [...windowState.moveTasks, ...windowState.moveTaskObserver.takeRecords().map(entry => entry.duration)]
    windowState.moveTaskObserver.disconnect()
    return {
      tasks,
      sameBoard: windowState.beforeMoveBoard === document.querySelector(".board"),
      sameNeighbor: windowState.beforeMoveNeighbor === document.querySelector('[data-item-id="performance-card-1"]'),
    }
  })
  await session.send("Emulation.setCPUThrottlingRate", { rate: 1 })
  await writeFile(testInfo.outputPath("move.cpuprofile"), JSON.stringify(profile))
  await writeFile(testInfo.outputPath("move.measurement.json"), JSON.stringify(measured))
  await expect(page.getByRole("dialog", { name: "Item overview" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("region", { name: "Doing", exact: true }).getByText("Performance card 0", { exact: true })).toBeVisible()
  expect(measured.sameBoard && measured.sameNeighbor).toBe(true)
  console.info(`Card move, 55 detailed cards, 4x CPU: ${measured.tasks.length ? `longest main-thread task ${Math.round(Math.max(...measured.tasks))}ms` : "no main-thread task reached 50ms"}`)
  expect(Math.max(0, ...measured.tasks)).toBeLessThan(200)
  // Cold startup is a durability check, separate from the throttled interaction.
  await page.reload()
  try {
    // Reload readiness waits for full-history admission; the 200ms interaction gate stays unchanged.
    await expect(page.getByRole("region", { name: "Doing", exact: true }).getByText("Performance card 0", { exact: true })).toBeVisible({ timeout: 60_000 })
  } catch (error) {
    console.info("Reload startup phase probe", JSON.stringify(await readWorkspacePhaseProbe(page, 60_000)))
    throw error
  }
})
