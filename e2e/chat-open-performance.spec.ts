import { expect, test } from "./support/coverage"
import { writeFile } from "node:fs/promises"
import { populatedBoard } from "./support/detailedBoard"

test.use({ trace: "off" })

test("Given 55 detailed cards, when Chat opens, then pointer event timing stays below 200ms", async ({ page }, testInfo) => {
  await populatedBoard(page)
  await waitForDetailedBoardReady(page)
  const session = await page.context().newCDPSession(page)
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  const result = await measurePointerOpen(page, 'button[aria-label="Workspace chat"]', "Chat")
  await session.send("Emulation.setCPUThrottlingRate", { rate: 1 })
  expect(result.dialogVisible).toBe(true)
  await writeFile(testInfo.outputPath("chat-open-event-timing.json"), JSON.stringify(result, null, 2))
  const eventDuration = Math.max(0, ...result.events.map(entry => entry.duration))
  console.info(`Chat open, 55 detailed cards, 4x CPU: Event Timing ${Math.round(eventDuration)}ms; click to dialog paint ${Math.round(result.clickToPaintMs)}ms`)
  expect(eventDuration).toBeLessThan(200)
  expect(result.clickToPaintMs).toBeLessThan(200)
})

test("Given 55 detailed cards, when Sync opens, then pointer event timing stays below 200ms", async ({ page }, testInfo) => {
  await populatedBoard(page)
  await waitForDetailedBoardReady(page)
  const session = await page.context().newCDPSession(page)
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  const result = await measurePointerOpen(page, "button", "Sync")
  await session.send("Emulation.setCPUThrottlingRate", { rate: 1 })
  await expect(page.getByRole("dialog", { name: "Device sync" })).toBeVisible()
  await writeFile(testInfo.outputPath("sync-open-event-timing.json"), JSON.stringify(result, null, 2))
  const eventDuration = Math.max(0, ...result.events.map(entry => entry.duration))
  console.info(`Sync open, 55 detailed cards, 4x CPU: Event Timing ${Math.round(eventDuration)}ms; click to dialog paint ${Math.round(result.clickToPaintMs)}ms`)
  expect(eventDuration).toBeLessThan(200)
  expect(result.clickToPaintMs).toBeLessThan(200)
})

async function measurePointerOpen(page: import("@playwright/test").Page, selector: string, label: string) {
  const point = await page.evaluate(({ selector, label }) => {
    const button = [...document.querySelectorAll("button")].find(item => selector === "button"
      ? item.textContent?.trim() === label && item.getClientRects().length > 0
      : item.matches(selector) && item.getClientRects().length > 0)!
    const entries: Array<{ name: string; duration: number; interactionId: number; startTime: number; processingStart: number; processingEnd: number; targetTag: string; targetAriaLabel: string }> = []
    const eventObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries() as PerformanceEventTiming[]) {
        const target = entry.target as Element | null
        if (["pointerdown", "pointerup", "click"].includes(entry.name) && target?.closest("button") === button) {
          entries.push({ name: entry.name, duration: entry.duration, interactionId: entry.interactionId,
            startTime: entry.startTime, processingStart: entry.processingStart, processingEnd: entry.processingEnd,
            targetTag: target?.tagName ?? "", targetAriaLabel: target?.getAttribute("aria-label") ?? "" })
        }
        if (entry.name === "click" && target?.closest("button") === button) eventObserver.disconnect()
      }
    })
    eventObserver.observe({ type: "event", buffered: false, durationThreshold: 0 })
    button.addEventListener("click", () => {
      const clickedAt = performance.now()
      const recordPaint = () => requestAnimationFrame(() => requestAnimationFrame(() => {
        const dialog = label === "Chat"
          ? document.querySelector('[role="dialog"][aria-label="Workspace chat"]')
          : [...document.querySelectorAll('[role="dialog"]')].find(item => item.getAttribute("aria-label") === "Device sync")
        if (dialog && dialog.getBoundingClientRect().width > 0) {
          Object.assign(window, { measuredClickToPaintMs: performance.now() - clickedAt })
          observer.disconnect()
        }
      }))
      const observer = new MutationObserver(recordPaint)
      observer.observe(document.body, { childList: true, subtree: true })
      recordPaint()
    }, { once: true, capture: true })
    Object.assign(window, { measuredOpenEventEntries: entries, measuredClickToPaintMs: null })
    const rect = button.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  }, { selector, label })
  await page.mouse.click(point.x, point.y)
  if (label === "Chat") await page.waitForSelector(".chat-dialog")
  else await page.waitForSelector(".sync-dialog")
  return page.evaluate(async () => {
    const measured = window as unknown as {
      measuredOpenEventEntries: Array<{ name: string; duration: number; interactionId: number; startTime: number; processingStart: number; processingEnd: number; targetTag: string; targetAriaLabel: string }>
      measuredClickToPaintMs: number | null
    }
    const deadline = performance.now() + 1500
    while (measured.measuredClickToPaintMs === null && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return {
      events: measured.measuredOpenEventEntries.map(entry => ({ ...entry,
        inputDelayMs: entry.processingStart - entry.startTime,
        processingMs: entry.processingEnd - entry.processingStart,
        presentationMs: entry.startTime + entry.duration - entry.processingEnd,
      })),
      clickToPaintMs: measured.measuredClickToPaintMs ?? 1500,
      dialogVisible: Boolean(document.querySelector('[role="dialog"]')),
    }
  })
}

async function waitForDetailedBoardReady(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => document.querySelectorAll('[data-item-id^="performance-card-"]').length === 55)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

test("Given chat metadata becomes unavailable, when Chat opens, then failure appears and board remains usable", async ({ page }) => {
  await populatedBoard(page)
  await page.evaluate(async () => {
    const { configureChat } = await import("/src/chat/service.ts")
    configureChat(async () => "owner", async () => { throw new Error("Workspace metadata unavailable") })
  })
  await page.getByRole("button", { name: "Workspace chat", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Workspace chat", exact: true })
  await expect(dialog.getByRole("alert")).toContainText("Workspace metadata unavailable")
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await page.getByRole("button", { name: "Open Performance card 0", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Item overview" })).toBeVisible()
})
