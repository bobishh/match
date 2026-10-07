import { expect, test } from "./support/coverage"
import { populatedBoard, moveFirst } from "./support/detailedBoard"
import { installWorkspacePhaseProbe, readWorkspacePhaseProbe, startWorkspacePhaseProbe } from "./support/workspacePhaseProbe"

test("Given a detailed board and failed storage, when a card moves, then failure restores placement and retry persists", async ({ page }) => {
  test.setTimeout(120_000)
  await installWorkspacePhaseProbe(page)
  await populatedBoard(page)
  await startWorkspacePhaseProbe(page)
  await page.evaluate(async () => (await import("/src/storage.ts")).setStorageFailureHookForTest(true))
  await moveFirst(page)
  try {
    // Persistence status follows full-history admission; keep this separate from the 200ms interaction gate.
    await expect(page.getByRole("status")).toContainText("Move failed", { timeout: 15_000 })
  } catch (error) {
    console.info("Workspace command phase probe", JSON.stringify(await readWorkspacePhaseProbe(page, 60_000)))
    throw error
  }
  console.info("Workspace command phase probe", JSON.stringify(await readWorkspacePhaseProbe(page)))
  await expect(page.getByRole("region", { name: "To do", exact: true }).getByText("Performance card 0", { exact: true })).toBeVisible()
  await page.evaluate(async () => (await import("/src/storage.ts")).setStorageFailureHookForTest(false))
  await moveFirst(page)
  await expect(page.getByRole("status")).toContainText("Item moved", { timeout: 15_000 })
  await page.reload()
  await expect(page.getByRole("region", { name: "Doing", exact: true }).getByText("Performance card 0", { exact: true })).toBeVisible({ timeout: 15000 })
})

test("Given two tabs share a detailed board, when one moves a card and another edits its neighbor, then reload retains both writes", async ({ page, context }) => {
  test.setTimeout(120_000)
  await populatedBoard(page)
  const other = await context.newPage()
  await installWorkspacePhaseProbe(other)
  await other.goto("/")
  try {
    // Full-history admission gates workspace readiness; interaction limits remain separate.
    await expect(other.getByRole("button", { name: "Open workspaces" })).toBeEnabled({ timeout: 60_000 })
  } catch (error) {
    console.info("Second-tab startup phase probe", JSON.stringify(await readWorkspacePhaseProbe(other, 60_000)))
    throw error
  }
  await expect(other.getByRole("button", { name: "Open Performance card 1", exact: true })).toBeVisible()
  await Promise.all([
    moveFirst(page),
    other.evaluate(async () => {
      const state = (await import("/src/state.ts")).useTincanban()
      await state.executeCommandAsync({ kind: "patchItem", entityId: "performance-card-1", title: "Concurrent neighbor edit" })
    }),
  ])
  await expect(page.getByRole("status")).toContainText("Item moved", { timeout: 15_000 })
  await page.reload()
  await expect(page.getByRole("region", { name: "Doing", exact: true }).getByText("Performance card 0", { exact: true })).toBeVisible({ timeout: 15000 })
  await expect(page.getByRole("button", { name: "Open Concurrent neighbor edit", exact: true })).toBeVisible({ timeout: 15000 })
  await other.close()
})
