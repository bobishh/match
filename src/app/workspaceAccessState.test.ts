import { expect, it } from "vitest"
import { mergeWorkspaceAccessState, type WorkspaceAccessResult } from "./workspaceAccessState"

const owner: WorkspaceAccessResult = { role: "owner", blocked: false }
const editor: WorkspaceAccessResult = { role: "editor", blocked: false }
const unavailable: WorkspaceAccessResult = { role: "visitor", blocked: true, error: "permissions unavailable" }

it("preserves fresh active access and inactive errors when delayed full verification resolves", async () => {
  let resolveFull!: (access: Record<string, WorkspaceAccessResult>) => void
  const fullResult = new Promise<Record<string, WorkspaceAccessResult>>(resolve => { resolveFull = resolve })
  let state = mergeWorkspaceAccessState({ active: owner, inactive: owner }, {},
    ["active", "inactive"], "active", true)
  const delayedCommit = fullResult.then(access => {
    state = mergeWorkspaceAccessState(state.access, access, ["active", "inactive"], "active", false)
  })

  state = mergeWorkspaceAccessState(state.access, { active: editor }, ["active", "inactive"], "active", true)
  resolveFull({ active: owner, inactive: unavailable })
  await delayedCommit

  expect(state.access.active).toEqual(editor)
  expect(state.errors).toEqual([unavailable.error])
})

it("keeps inactive verification failures during active-only refresh and drops removed catalog entries on full refresh", () => {
  const afterActiveRefresh = mergeWorkspaceAccessState({ active: owner, inactive: unavailable, removed: unavailable },
    { active: editor }, ["active", "inactive"], "active", true)
  expect(afterActiveRefresh.access.inactive).toEqual(unavailable)
  expect(afterActiveRefresh.errors).toEqual([unavailable.error])

  const afterFullRefresh = mergeWorkspaceAccessState(afterActiveRefresh.access, { active: editor, inactive: owner },
    ["active", "inactive"], "active", true)
  expect(afterFullRefresh.access).toEqual({ active: editor, inactive: owner })
  expect(afterFullRefresh.errors).toEqual([])
})
