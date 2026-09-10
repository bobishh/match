import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "./identity"
import { createWorkspaceDoc } from "./seeds"
import {
  projectBoardSchema,
  validateBoardSchemaDraft,
  diffBoardSchema,
  type BoardSchemaDraft,
} from "./schema"
import { executeCommand } from "./commands"
import type { WorkspaceDocumentV2, FieldDefinition } from "./model"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("Board Schema Projection, Validation and Atomic Diff (Gate E)", () => {
  let profile: LocalProfile

  beforeEach(async () => {
    resetIdentityStorageForTest()
    profile = await bootstrapIdentity("Alice")
  })

  it("projects canonical entities to disposable typed JSON schema draft without exposing private keys or card data", () => {
    const raw = createWorkspaceDoc("ws_test", "Product Roadmap", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(raw)

    const board = Object.values(doc.entities).find((e) => e.kind === "board")!
    const draft = projectBoardSchema(doc, board.id)

    expect(draft.boardId).toBe(board.id)
    expect(draft.boardTitle).toBe("Product Roadmap")
    expect(draft.columns.map((c) => c.title)).toEqual(["To do", "Doing", "Done"])
    expect(draft.fields).toEqual([])

    // Verify no private identity, devices, certificates, or tasks are in draft
    expect((draft as any).ownerPersonId).toBeUndefined()
    expect((draft as any).entities).toBeUndefined()
    expect((draft as any).leads).toBeUndefined()
  })

  it("validates draft with precise JSON paths for invalid column and field definitions", () => {
    const invalidDraft: BoardSchemaDraft = {
      boardId: "board-1",
      boardTitle: "",
      entityName: "",
      columns: [
        { id: "c1", title: "Valid" },
        { id: "c2", title: "   " }, // empty title
      ],
      fields: [
        {
          id: "f1",
          title: "Status Field",
          valueType: "unknown_type" as any,
          required: false,
        },
        {
          id: "f2",
          title: "Priority",
          valueType: "select",
          required: true,
          options: [{ id: "opt1", title: "" }], // empty option title
        },
      ],
    }

    const res = validateBoardSchemaDraft(invalidDraft)
    expect(res.valid).toBe(false)
    const paths = res.errors.map((e) => e.path)
    expect(paths).toContain("/boardTitle")
    expect(paths).toContain("/entityName")
    expect(paths).toContain("/columns/1/title")
    expect(paths).toContain("/fields/0/valueType")
    expect(paths).toContain("/fields/1/options/0/title")
  })

  it("diffs schema draft against canonical doc showing renames, soft-deletions, and option retention", () => {
    const raw = createWorkspaceDoc("ws_test", "Test Board", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(raw)

    const board = Object.values(doc.entities).find((e) => e.kind === "board")!
    const draft = projectBoardSchema(doc, board.id)

    // Rename first column, remove second column (soft delete), add a new column
    draft.columns[0].title = "Backlog"
    const removedColId = draft.columns[1].id!
    draft.columns.splice(1, 1) // removes "Doing"
    draft.columns.push({ title: "Archived Columns" })

    // Add a field with options
    draft.fields.push({
      title: "Severity",
      valueType: "select",
      required: true,
      options: [
        { id: "opt-p1", title: "P1" },
        { id: "opt-p2", title: "P2" },
      ],
    })

    const diff = diffBoardSchema(doc, board.id, draft)
    expect(diff.columnsRenamed).toEqual([
      { id: draft.columns[0].id!, oldTitle: "To do", newTitle: "Backlog" },
    ])
    expect(diff.columnsSoftDeleted.map((c) => c.id)).toContain(removedColId)
    expect(diff.columnsAdded.map((c) => c.title)).toContain("Archived Columns")
    expect(diff.fieldsAdded.map((f) => f.title)).toContain("Severity")
  })

  it("applies schema draft through atomic updateBoardSchema command retaining stable IDs and soft-deleting removals", async () => {
    const raw = createWorkspaceDoc("ws_test", "Test Board", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(raw)

    const board = Object.values(doc.entities).find((e) => e.kind === "board")!
    const initialDraft = projectBoardSchema(doc, board.id)
    const originalCol0Id = initialDraft.columns[0].id!
    const removedColId = initialDraft.columns[1].id!

    // Modify schema draft
    initialDraft.columns[0].title = "Inbox"
    initialDraft.columns.splice(1, 1) // soft delete "Doing"
    initialDraft.columns.push({ title: "Shipped" })
    initialDraft.fields.push({
      title: "Priority",
      valueType: "select",
      required: false,
      options: [
        { id: "opt-low", title: "Low" },
        { id: "opt-high", title: "High" },
      ],
    })

    const result = await executeCommand(
      doc,
      {
        kind: "updateBoardSchema",
        boardId: board.id,
        schema: initialDraft,
      },
      profile
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const newDoc = result.value.newDoc
    const updatedCol0 = newDoc.entities[originalCol0Id]
    expect(updatedCol0?.title).toBe("Inbox")
    expect(updatedCol0?.deleted).toBe(false)

    // Removed column is soft-deleted, NOT destroyed
    const softDeletedCol = newDoc.entities[removedColId]
    expect(softDeletedCol).toBeDefined()
    expect(softDeletedCol?.deleted).toBe(true)

    // New column created
    const shippedCol = Object.values(newDoc.entities).find(
      (e) => e.kind === "column" && e.title === "Shipped" && !e.deleted
    )
    expect(shippedCol).toBeDefined()

    // New field created with options
    const priorityField = Object.values(newDoc.entities).find(
      (e): e is FieldDefinition => e.kind === "field" && e.title === "Priority" && !e.deleted
    )
    expect(priorityField).toBeDefined()
    if (priorityField && priorityField.valueType === "select") {
      expect(priorityField.options["opt-low"].title).toBe("Low")
      expect(priorityField.options["opt-high"].title).toBe("High")
    }
  })

  it("detects concurrent draft conflict if expectedHeads do not match current doc heads", async () => {
    const raw = createWorkspaceDoc("ws_test", "Test Board", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(raw)

    const board = Object.values(doc.entities).find((e) => e.kind === "board")!
    const draft = projectBoardSchema(doc, board.id)

    // Stale expected heads
    const staleHeads = ["stale-head-hash"]

    const result = await executeCommand(
      doc,
      {
        kind: "updateBoardSchema",
        boardId: board.id,
        schema: draft,
        expectedHeads: staleHeads,
      },
      profile
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("conflict")
      expect(result.error.message).toContain("Concurrent edits arrived")
    }
  })
})
