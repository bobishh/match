import * as Automerge from "@automerge/automerge/slim"
import { readFile } from "node:fs/promises"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { createWorkspaceDoc } from "../domain/seeds"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { indexOperationParents, touchedPathsForChange } from "./workspaceAdmissionCore"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await Automerge.initializeWasm("/automerge.wasm")
})

describe("workspace admission operation paths", () => {
  it("attributes root Text updates and entity edits to exact paths", () => {
    let doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("path-test", "Board", "owner", "job-search"))
    const column = Object.values(doc.entities).find(entity => entity.kind === "column")!
    doc = Automerge.change(doc, draft => {
      draft.title = "Renamed board"
      draft.entities[column.id]!.title = "Renamed column"
    })
    const changes = Automerge.getAllChanges(doc).map(change => Automerge.decodeChange(change))
    const latest = changes.at(-1)!
    const touched = touchedPathsForChange(latest.ops, indexOperationParents(changes))

    expect(touched?.rootKeys).toEqual(new Set(["title"]))
    expect(touched?.entityIds).toEqual(new Set([column.id]))
  })

  it("uses slow-path for ambiguous root entity-map replacement and unknown object ids", () => {
    const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("path-fallback", "Board", "owner", "blank"))
    const changes = Automerge.getAllChanges(doc).map(change => Automerge.decodeChange(change))
    const objectParents = indexOperationParents(changes)
    const rootReplacement = [{ action: "set", obj: "_root", key: "entities", pred: [] }]
    const unknownObject = [{ action: "set", obj: "missing@actor", key: "title", pred: [] }]

    expect(touchedPathsForChange(rootReplacement, objectParents)).toBeUndefined()
    expect(touchedPathsForChange(unknownObject, objectParents)).toBeUndefined()
  })
})
