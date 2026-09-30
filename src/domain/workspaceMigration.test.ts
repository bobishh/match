import * as Automerge from "@automerge/automerge/slim"
import { readFile } from "node:fs/promises"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { createWorkspaceDoc } from "./seeds"
import { validateWorkspaceDoc } from "./validation"
import { planWorkspaceMigration } from "./workspaceMigration"
import type { WorkspaceDocumentV2 } from "./model"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await Automerge.initializeWasm("/automerge.wasm")
})

function legacyWorkspace() {
  const current = createWorkspaceDoc("legacy-board", "Legacy board", "owner", "job-search", "2026-01-01T00:00:00.000Z") as unknown as Record<string, any>
  current.formatVersion = 2
  current.deleted = false
  delete current.archivedAt
  for (const entity of Object.values(current.entities) as Array<Record<string, any>>) {
    entity.deleted = entity.kind === "column" && entity.title === "Archive"
    delete entity.archivedAt
    if (entity.kind === "column") entity.displayHint = "normal"
    if (entity.kind === "field" && entity.valueType === "select") {
      for (const option of Object.values(entity.options) as Array<Record<string, any>>) {
        option.deleted = false
        delete option.archivedAt
      }
    }
  }
  return current
}

describe("workspace format migration", () => {
  it("Given signed format 2 data, when owner migrates, then history remains and archive state survives", () => {
    const source = Automerge.from(legacyWorkspace())
    const before = Automerge.getAllChanges(source)
    const plan = planWorkspaceMigration(source, "2026-02-01T00:00:00.000Z")
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const migrated = Automerge.change(Automerge.clone(source), draft => plan.value.apply(draft as unknown as WorkspaceDocumentV2))
    expect(Automerge.getAllChanges(migrated).slice(0, before.length)).toEqual(before)
    expect(Automerge.getAllChanges(migrated)).toHaveLength(before.length + 1)
    expect(validateWorkspaceDoc(migrated).ok).toBe(true)
    const archive = Object.values(migrated.entities).find((entity: any) => entity.kind === "column" && entity.title === "Archive") as any
    expect(archive.archivedAt).toBe("2026-01-01T00:00:00.000Z")
    expect(archive).not.toHaveProperty("deleted")
    expect(archive).not.toHaveProperty("displayHint")
  })

  it("Given malformed format 2 data, when migration is planned, then it fails without changing source", () => {
    const old = legacyWorkspace()
    const column = Object.values(old.entities).find((entity: any) => entity.kind === "column") as any
    column.deleted = "yes"
    const source = Automerge.from(old)
    const heads = Automerge.getHeads(source)
    expect(planWorkspaceMigration(source, "2026-02-01T00:00:00.000Z").ok).toBe(false)
    expect(Automerge.getHeads(source)).toEqual(heads)
  })
})
