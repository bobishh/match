import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "./identity"
import { createWorkspaceDoc } from "./seeds"
import { executeCommand } from "./commands"
import { projectWorkspaceSettings, validateWorkspaceSettingsDraft } from "./workspaceSettings"
import type { WorkspaceDocumentV2 } from "./model"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("workspace settings transaction", () => {
  let profile: LocalProfile
  let doc: Automerge.Doc<WorkspaceDocumentV2>

  beforeEach(async () => {
    resetIdentityStorageForTest()
    profile = await bootstrapIdentity("Settings Test")
    doc = Automerge.from(createWorkspaceDoc("settings", "Before", profile.identity.personId, "blank"))
  })

  it("applies workspace, board, fields, columns, and document templates in one CRDT change", async () => {
    const settings = projectWorkspaceSettings(doc)
    settings.workspace.title = "After"
    settings.board.entityName = "book"
    settings.board.columns[0].title = "Unread"
    settings.board.fields = [
      { title: "Author", valueType: "text", required: true },
      { title: "Published At", valueType: "datetime" as any, required: false },
    ]
    settings.documentTemplates = [{ title: "Review", markdown: "# {{title}}" }]

    const result = await executeCommand(doc, { kind: "updateWorkspaceSettings", settings, expectedHeads: Automerge.getHeads(doc) }, profile)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Automerge.getChanges(doc, result.value.newDoc)).toHaveLength(1)
    const projected = projectWorkspaceSettings(result.value.newDoc)
    expect(projected.workspace.title).toBe("After")
    expect(projected.board.entityName).toBe("book")
    expect(projected.board.columns[0].title).toBe("Unread")
    expect(projected.board.fields[0].title).toBe("Author")
    expect(projected.board.fields[1].title).toBe("Published At")
    expect(projected.board.fields[1].valueType).toBe("datetime")
    expect(projected.documentTemplates[0]).toMatchObject({ title: "Review", markdown: "# {{title}}" })
  })

  it("rejects invalid paths and stale heads without changing the document", async () => {
    const settings = projectWorkspaceSettings(doc)
    settings.board.entityName = ""
    expect(validateWorkspaceSettingsDraft(settings, doc).errors[0].path).toBe("/board/entityName")
    const invalid = await executeCommand(doc, { kind: "updateWorkspaceSettings", settings }, profile)
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_input", field: "/board/entityName" } })

    settings.board.entityName = "item"
    const stale = await executeCommand(doc, { kind: "updateWorkspaceSettings", settings, expectedHeads: ["stale"] }, profile)
    expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } })
    expect(doc.title).toBe("Before")
  })

  it("rejects changing an existing field type", async () => {
    const created = await executeCommand(doc, {
      kind: "createField",
      boardId: projectWorkspaceSettings(doc).board.boardId,
      title: "Estimate",
      valueType: "number",
      required: false,
    }, profile)
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const settings = projectWorkspaceSettings(created.value.newDoc)
    settings.board.fields[0].valueType = "text"
    expect(validateWorkspaceSettingsDraft(settings, created.value.newDoc).errors).toContainEqual({
      path: "/board/fields/0/valueType",
      message: "Field type cannot change",
    })
  })

  it("applies the archive role and rejects duplicate archive columns", async () => {
    const settings = projectWorkspaceSettings(doc)
    settings.board.columns[0].title = "Cold storage"
    settings.board.columns[0].archive = true

    const result = await executeCommand(doc, { kind: "updateWorkspaceSettings", settings }, profile)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const projected = projectWorkspaceSettings(result.value.newDoc)
    expect(projected.board.columns[0]).toMatchObject({ title: "Cold storage", archive: true })

    projected.board.columns[1].archive = true
    expect(validateWorkspaceSettingsDraft(projected, result.value.newDoc).errors).toContainEqual({
      path: "/board/columns/1/archive",
      message: "Only one archive column is allowed",
    })
  })
})
