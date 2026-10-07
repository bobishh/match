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
  await page.getByRole("dialog", { name: "Workspace chat", exact: true }).getByRole("button", { name: "Close", exact: true }).click()
  const warm = await measurePointerOpen(page, 'button[aria-label="Workspace chat"]', "Chat")
  await session.send("Emulation.setCPUThrottlingRate", { rate: 1 })
  expect(result.dialogVisible).toBe(true)
  await writeFile(testInfo.outputPath("chat-open-event-timing.json"), JSON.stringify(result, null, 2))
  const eventDuration = Math.max(0, ...result.events.map(entry => entry.duration))
  console.info(`Chat open, 55 detailed cards, 4x CPU: Event Timing ${Math.round(eventDuration)}ms; dialog ready ${Math.round(result.componentReadyMs)}ms`)
  expect(eventDuration).toBeLessThan(200)
  expect(result.pendingPaintMs).toBeLessThan(200)
  expect(Math.max(0, ...warm.events.map(entry => entry.duration))).toBeLessThan(200)
  expect(warm.componentReadyMs).toBeLessThan(200)
})

test("Given 55 detailed cards, when Sync opens, then pointer event timing stays below 200ms", async ({ page }, testInfo) => {
  await populatedBoard(page)
  await waitForDetailedBoardReady(page)
  const session = await page.context().newCDPSession(page)
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  const result = await measurePointerOpen(page, "button", "Sync")
  await session.send("Emulation.setCPUThrottlingRate", { rate: 1 })
  await page.waitForSelector(".sync-dialog")
  await writeFile(testInfo.outputPath("sync-open-event-timing.json"), JSON.stringify(result, null, 2))
  const eventDuration = Math.max(0, ...result.events.map(entry => entry.duration))
  console.info(`Sync open, 55 detailed cards, 4x CPU: Event Timing ${Math.round(eventDuration)}ms; pending paint ${Math.round(result.pendingPaintMs)}ms; dialog ready ${Math.round(result.componentReadyMs)}ms`)
  expect(eventDuration).toBeLessThan(200)
  expect(result.pendingPaintMs).toBeLessThan(200)
  expect(result.componentReadyMs).toBeLessThan(5_000)
})

async function measurePointerOpen(page: import("@playwright/test").Page, selector: string, label: string) {
  const point = await page.evaluate(({ selector, label }) => {
    const button = [...document.querySelectorAll("button")].find(item => selector === "button"
      ? item.textContent?.trim() === label && item.getClientRects().length > 0
      : item.matches(selector) && item.getClientRects().length > 0)!
    const entries: Array<{ name: string; duration: number; interactionId: number; startTime: number; processingStart: number; processingEnd: number; targetTag: string; targetAriaLabel: string }> = []
    const measuredOpen = { pendingPaintMs: null as number | null, componentReadyMs: null as number | null }
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
      let framePending = false
      const recordPaint = () => {
        if (framePending) return
        framePending = true
        requestAnimationFrame(() => requestAnimationFrame(() => {
          framePending = false
          const pending = label === "Chat" ? document.querySelector(".chat-open-pending") : document.querySelector(".sync-dialog-pending")
          const ready = label === "Chat" ? document.querySelector(".chat-dialog") : document.querySelector(".sync-dialog")
          const now = performance.now()
          if (pending && pending.getBoundingClientRect().width > 0 && measuredOpen.pendingPaintMs === null) {
            measuredOpen.pendingPaintMs = now - clickedAt
          }
          if (ready && ready.getBoundingClientRect().width > 0) {
            measuredOpen.componentReadyMs = now - clickedAt
            if (measuredOpen.pendingPaintMs === null) measuredOpen.pendingPaintMs = measuredOpen.componentReadyMs
            observer.disconnect()
          }
        }))
      }
      const observer = new MutationObserver(recordPaint)
      observer.observe(document.body, { childList: true, subtree: true })
      Object.assign(window, { measuredOpen })
      recordPaint()
      const publishFrame = () => {
        Object.assign(window, { measuredOpen })
        if (measuredOpen.componentReadyMs === null) requestAnimationFrame(publishFrame)
      }
      requestAnimationFrame(publishFrame)
    }, { once: true, capture: true })
    Object.assign(window, { measuredOpenEventEntries: entries })
    const rect = button.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  }, { selector, label })
  await page.mouse.click(point.x, point.y)
  if (label === "Chat") await page.waitForSelector(".chat-dialog")
  else await page.waitForSelector(".sync-dialog")
  return page.evaluate(async () => {
    const measured = window as unknown as {
      measuredOpenEventEntries: Array<{ name: string; duration: number; interactionId: number; startTime: number; processingStart: number; processingEnd: number; targetTag: string; targetAriaLabel: string }>
      measuredOpen: { pendingPaintMs: number | null; componentReadyMs: number | null }
    }
    const deadline = performance.now() + 5_000
    while (measured.measuredOpen.componentReadyMs === null && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return {
      events: measured.measuredOpenEventEntries.map(entry => ({ ...entry,
        inputDelayMs: entry.processingStart - entry.startTime,
        processingMs: entry.processingEnd - entry.processingStart,
        presentationMs: entry.startTime + entry.duration - entry.processingEnd,
      })),
      pendingPaintMs: measured.measuredOpen.pendingPaintMs ?? 1500,
      componentReadyMs: measured.measuredOpen.componentReadyMs ?? 5000,
      dialogVisible: Boolean(document.querySelector(".chat-dialog, .sync-dialog")),
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

test("Given the Chat chunk fails after loading is delayed, when Chat opens, then reload recovers chat", async ({ page }) => {
  let releaseChunk!: () => void
  const chunkGate = new Promise<void>(resolve => { releaseChunk = resolve })
  let firstRequest = true
  await page.route("**/src/components/WorkspaceChat.vue*", async route => {
    await chunkGate
    if (firstRequest) {
      firstRequest = false
      await route.abort()
    } else await route.continue()
  })
  await populatedBoard(page)
  await page.getByRole("button", { name: "Workspace chat", exact: true }).click()
  const pending = page.locator(".chat-open-pending")
  await expect(pending).toContainText("Opening chat…")
  releaseChunk()
  const failed = page.getByRole("alert").filter({ hasText: "Chat could not load." })
  await expect(failed).toBeVisible()
  await failed.getByRole("button", { name: "Reload tincanban" }).click()
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled({ timeout: 60_000 })
  await page.getByRole("button", { name: "Workspace chat", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Workspace chat", exact: true })).toBeVisible()
})

test("Given Sync chunk fails to load, when Sync opens, then pending can close and reload recovers", async ({ page }) => {
  test.setTimeout(120_000)
  let firstLoad = true
  await page.route("**/src/components/SyncDialog.vue*", async route => {
    if (firstLoad) {
      firstLoad = false
      await new Promise(resolve => setTimeout(resolve, 800))
      await route.abort()
    } else await route.continue()
  })
  await populatedBoard(page)
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Device sync", exact: true })
  await expect(dialog.getByRole("status")).toContainText("Loading sync controls")
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await page.getByRole("button", { name: "Open Performance card 0", exact: true }).click()
  const itemDialogAfterPendingClose = page.getByRole("dialog", { name: "Item overview" })
  await expect(itemDialogAfterPendingClose).toBeVisible()
  await itemDialogAfterPendingClose.getByRole("button", { name: "Close detail", exact: true }).click()
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const failedDialog = page.getByRole("dialog", { name: "Device sync", exact: true })
  await expect(failedDialog.getByRole("alert")).toContainText("Sync controls could not load")
  await expect(failedDialog.getByRole("button", { name: "Reload tincanban", exact: true })).toBeVisible()
  await failedDialog.getByRole("button", { name: "Close", exact: true }).click()
  await page.getByRole("button", { name: "Open Performance card 0", exact: true }).click()
  const itemDialog = page.getByRole("dialog", { name: "Item overview" })
  await expect(itemDialog).toBeVisible()
  await itemDialog.getByRole("button", { name: "Close detail", exact: true }).click()
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  await page.getByRole("dialog", { name: "Device sync", exact: true }).getByRole("button", { name: "Reload tincanban", exact: true }).click()
  // Recovery waits for full-history admission; the pending Sync state remains asserted above.
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled({ timeout: 60_000 })
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  await expect(page.locator(".sync-dialog")).toBeVisible()
})
