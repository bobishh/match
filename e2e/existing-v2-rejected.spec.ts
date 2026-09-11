import { expect, test } from "@playwright/test"
import { ensureJobSearchWorkspace } from "./support/workspaces"

test("Given a saved v2 board predating Rejected, when upgraded, existing cards can move to Rejected with notes after reload", async ({ page }) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  await page.getByLabel("Company *").fill("Existing V2")
  await page.getByLabel("Role *").fill("Engineer")
  await page.getByRole("button", { name: "Create item" }).click()
  await page.getByRole("button", { name: "Close detail" }).click()
  await page.evaluate(async () => {
    // Seed the already-migrated v2 shape shipped before Rejected was restored.
    const state = await import("/src/state.ts")
    const storage = await import("/src/storage.ts")
    const A = await import("/@id/@automerge/automerge/slim")
    const doc = state.useMatch().getActiveDoc()!
    const old = A.change(A.clone(doc), (draft: any) => {
      const board = Object.values(draft.entities).find((e: any) => e.kind === "board") as any
      for (const key of ["status.rejected", "field.rejectionReason"]) {
        delete draft.entities[board.preset.bindings[key]]
        delete board.preset.bindings[key]
      }
    })
    await storage.defaultStorage.saveSnapshot(old.id, old, A.save(old))
  })
  await page.reload()
  await page.getByRole("button", { name: "Open Existing V2 — Engineer" }).click()
  const detail = page.getByRole("dialog", { name: "Lead details" })
  await detail.getByRole("button", { name: "Rejected", exact: true }).click()
  await expect(detail.getByLabel("Rejection notes")).toBeVisible()
  await detail.getByLabel("Rejection notes").fill("Role closed")
  await page.getByRole("button", { name: "Close detail" }).click()
  await page.reload()
  await page.getByRole("region", { name: "Rejected", exact: true }).getByRole("button", { name: "Open Existing V2 — Engineer" }).click()
  await expect(page.getByLabel("Rejection notes")).toHaveValue("Role closed")
  await page.getByRole("button", { name: "Close detail" }).click()
  const deletedIds = await page.evaluate(async () => {
    const { useMatch } = await import("/src/state.ts")
    const match = useMatch()
    const board = Object.values(match.getActiveDoc()!.entities).find((e: any) => e.kind === "board") as any
    const ids = [board.preset.bindings["status.rejected"], board.preset.bindings["field.rejectionReason"]]
    for (const entityId of ids) await match.executeCommandAsync({ kind: "setEntityDeleted", entityId, deleted: true })
    return ids
  })
  await page.reload()
  await expect(page.getByRole("region", { name: "Job search" })).toBeVisible()
  const retained = await page.evaluate(async (ids) => {
    const { useMatch } = await import("/src/state.ts")
    const doc = useMatch().getActiveDoc()!
    return ids.map((id) => doc.entities[id]?.deleted)
  }, deletedIds)
  expect(retained).toEqual([true, true])
})
