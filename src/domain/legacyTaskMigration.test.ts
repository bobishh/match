import { readFile } from "node:fs/promises"
import { beforeAll, describe, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { createWorkspaceDoc } from "./seeds"
import { validateWorkspaceDoc, type WorkspaceDocumentV2 } from "./model"
import { migrateLegacyTaskItems } from "./legacyTaskMigration"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("legacy task item migration", () => {
  it("turns the persisted task discriminator into one deletion-only Automerge change", () => {
    const raw = createWorkspaceDoc("workspace", "Old board", "owner", "blank")
    const column = Object.values(raw.entities).find(entity => entity.kind === "column")!
    const items = Array.from({ length: 4 }, (_, index) => ({
      id: `legacy-item-${index}`, title: `Persisted old card ${index}`, body: "", values: {},
      placement: { parentId: column.id, rank: `${index}/1` }, deleted: false,
      createdAt: "2026-09-17T08:27:28.056Z", updatedAt: "2026-09-17T08:27:28.056Z",
    }))
    for (const item of items) raw.entities[item.id] = item
    const legacy = Automerge.change(Automerge.from<WorkspaceDocumentV2>(raw), (draft) => {
      for (const item of items) {
        (draft.entities[item.id] as { kind?: string }).kind = "task"
      }
    })
    const before = Automerge.getAllChanges(legacy)

    const migrated = migrateLegacyTaskItems(legacy)!

    expect(validateWorkspaceDoc(migrated)).toMatchObject({ ok: true })
    for (const item of items)
      expect((migrated.entities[item.id] as { kind?: unknown }).kind).toBeUndefined()
    expect(Automerge.getAllChanges(migrated)).toHaveLength(before.length + 1)
    const change = Automerge.decodeChange(Automerge.getLastLocalChange(migrated)!)
    expect(change.ops).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ action: "del", key: "kind" })))
  })
})
