import { expect, type Page } from "./coverage"
import { createJobSearchWorkspace } from "./workspaces"

export async function populatedBoard(page: Page, jobSearch = false) {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
  if (jobSearch) await createJobSearchWorkspace(page, "Detailed leads")
  await page.evaluate(async jobSearch => {
    const { useMatch } = await import("/src/state.ts")
    const { defaultStorage } = await import("/src/storage.ts")
    const { prepareLocalChangeAuthorizations } = await import("/src/sync/changeAuthorization.ts")
    const { updateReactiveState } = await import("/src/statePersistence.ts")
    const A = await import("/@id/@automerge/automerge/slim")
    const match = useMatch()
    await match.whenReady()
    const base = match.getActiveDoc()!
    const board = Object.values(base.entities).find(entity => entity.kind === "board")!
    const parent = Object.values(base.entities).find(entity => entity.kind === "column" && entity.title === (jobSearch ? "Lead" : "To do"))!
    const now = new Date().toISOString()
    const doc = A.change(A.clone(base), draft => {
      for (let index = 0; index < 55; index++) {
        const id = `performance-card-${index}`
        draft.entities[id] = { id, title: `Performance card ${index}`, body: "Detailed job requirements. ".repeat(320),
          placement: { parentId: parent.id, rank: `${index}/1` }, archivedAt: null,
          createdAt: now, updatedAt: now, lastActivityAt: now, values: jobSearch ? {
            [board.preset!.bindings["field.company"]!]: `Performance card ${index}`,
            [board.preset!.bindings["field.role"]!]: "Senior Software Engineer",
          } : {} }
      }
    })
    const proofs = await prepareLocalChangeAuthorizations(doc, match.getCurrentProfile()!, [A.getHeads(doc)[0]!])
    await defaultStorage.commitWorkspace(doc.id, doc, A.save(doc), proofs)
    updateReactiveState(doc)
  }, jobSearch)
  await expect(page.getByRole("button", { name: "Open Performance card 0", exact: true })).toBeVisible()
}

export async function moveFirst(page: Page) {
  const source = (await page.getByRole("button", { name: "Open Performance card 0", exact: true }).boundingBox())!
  const target = (await page.getByRole("region", { name: "Doing", exact: true }).locator(".card-stack").boundingBox())!
  await page.mouse.move(source.x + source.width / 2, source.y + Math.min(30, source.height / 2))
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + 28, { steps: 15 })
  await page.mouse.up()
}
