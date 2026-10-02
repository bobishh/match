import { expect, test, type Page } from "@playwright/test"
import { writeFile } from "node:fs/promises"

async function populatedBoard(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
  await page.evaluate(async () => {
    const { useMatch } = await import("/src/state.ts")
    const { defaultStorage } = await import("/src/storage.ts")
    const { prepareLocalChangeAuthorizations } = await import("/src/sync/changeAuthorization.ts")
    const { updateReactiveState } = await import("/src/statePersistence.ts")
    const A = await import("/@id/@automerge/automerge/slim")
    const match = useMatch()
    await match.whenReady()
    const base = match.getActiveDoc()!
    const parent = Object.values(base.entities).find(entity => entity.kind === "column" && entity.title === "To do")!
    const now = new Date().toISOString()
    const doc = A.change(A.clone(base), draft => {
      for (let index = 0; index < 55; index++) {
        const id = `performance-card-${index}`
        draft.entities[id] = { id, title: `Performance card ${index}`, body: "Detailed job requirements. ".repeat(320),
          placement: { parentId: parent.id, rank: `${index}/1` }, archivedAt: null,
          createdAt: now, updatedAt: now, lastActivityAt: now, values: {} }
      }
    })
    const proofs = await prepareLocalChangeAuthorizations(doc, match.getCurrentProfile()!, [A.getHeads(doc)[0]!])
    await defaultStorage.commitWorkspace(doc.id, doc, A.save(doc), proofs)
    updateReactiveState(doc)
  })
  await expect(page.getByRole("button", { name: "Open Performance card 0", exact: true })).toBeVisible()
}

async function moveFirst(page: Page) {
  const source = (await page.getByRole("button", { name: "Open Performance card 0", exact: true }).boundingBox())!
  const target = (await page.getByRole("region", { name: "Doing", exact: true }).locator(".card-stack").boundingBox())!
  await page.mouse.move(source.x + source.width / 2, source.y + Math.min(30, source.height / 2))
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + 28, { steps: 15 })
  await page.mouse.up()
}

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
  await page.reload()
  await expect(page.getByRole("region", { name: "Doing", exact: true }).getByText("Performance card 0", { exact: true })).toBeVisible()
})

test("Given a detailed board and failed storage, when a card moves, then failure restores placement and retry persists", async ({ page }) => {
  await populatedBoard(page)
  await page.evaluate(async () => (await import("/src/storage.ts")).setStorageFailureHookForTest(true))
  await moveFirst(page)
  await expect(page.getByRole("status")).toContainText("Move failed")
  await expect(page.getByRole("region", { name: "To do", exact: true }).getByText("Performance card 0", { exact: true })).toBeVisible()
  await page.evaluate(async () => (await import("/src/storage.ts")).setStorageFailureHookForTest(false))
  await moveFirst(page)
  await expect(page.getByRole("status")).toContainText("Item moved")
  await page.reload()
  await expect(page.getByRole("region", { name: "Doing", exact: true }).getByText("Performance card 0", { exact: true })).toBeVisible()
})

test("Given two tabs share a detailed board, when one moves a card and another edits its neighbor, then reload retains both writes", async ({ page, context }) => {
  await populatedBoard(page)
  const other = await context.newPage()
  await other.goto("/")
  await expect(other.getByRole("button", { name: "Open Performance card 1", exact: true })).toBeVisible()
  await Promise.all([
    moveFirst(page),
    other.evaluate(async () => {
      const state = (await import("/src/state.ts")).useMatch()
      await state.executeCommandAsync({ kind: "patchItem", entityId: "performance-card-1", title: "Concurrent neighbor edit" })
    }),
  ])
  await expect(page.getByRole("status")).toContainText("Item moved")
  await page.reload()
  await expect(page.getByRole("region", { name: "Doing", exact: true }).getByText("Performance card 0", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Open Concurrent neighbor edit", exact: true })).toBeVisible()
  await other.close()
})
