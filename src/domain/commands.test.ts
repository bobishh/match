import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "./identity"
import { createWorkspaceDoc } from "./seeds"
import {
  createCommandQueue,
  type Command,
} from "./commands"
import { isItem, type WorkspaceDocumentV2, type Item } from "./model"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("Transaction wrapper, commands, and publication queue (Requirement 1.6)", () => {
  let profile: LocalProfile
  let initialDoc: Automerge.Doc<WorkspaceDocumentV2>

  beforeEach(async () => {
    resetIdentityStorageForTest()
    profile = await bootstrapIdentity("Alice Developer")
    const rawWs = createWorkspaceDoc("ws_test", "Test Board", profile.identity.personId, "job-search")
    initialDoc = Automerge.from<WorkspaceDocumentV2>(rawWs)
  })

  it("executes createItem and patchItem, produces native metadata, and signs a change proof", async () => {
    const queue = createCommandQueue(initialDoc, profile)
    const leadCol = Object.values(initialDoc.entities).find((e) => e.kind === "column" && e.title === "Lead")!

    const companyField = Object.values(initialDoc.entities).find((e) => e.kind === "field" && e.title === "Company")!
    const roleField = Object.values(initialDoc.entities).find((e) => e.kind === "field" && e.title === "Role")!

    const createCmd: Command = {
      kind: "createItem",
      parentId: leadCol.id,
      title: "First Item",
      body: "Initial item description",
      values: {
        [companyField.id]: "Acme",
        [roleField.id]: "Engineer",
      },
    }

    const res1 = await queue.transact(createCmd)
    expect(res1.ok).toBe(true)
    if (!res1.ok) return

    const receipt = res1.value.receipt
    expect(receipt.transactionId).toBeTruthy()
    expect(receipt.changeHash).toBeTruthy()
    expect(receipt.changedEntityIds).toHaveLength(1)

    const createdItemId = receipt.changedEntityIds[0]
    const updatedDoc = queue.getDocument()
    const item = updatedDoc.entities[createdItemId] as Item
    expect(item).toBeDefined()
    expect(item.title).toBe("First Item")
    expect(item.body).toBe("Initial item description")
    expect(item.placement.parentId).toBe(leadCol.id)

    // Verify proof
    const proof = res1.value.proof
    expect(proof.payload.kind).toBe("change-proof")
    expect(proof.payload.changeHash).toBe(receipt.changeHash)

    // Now patch title
    const patchCmd: Command = {
      kind: "patchItem",
      entityId: createdItemId,
      title: "Patched Title",
    }
    const res2 = await queue.transact(patchCmd)
    expect(res2.ok).toBe(true)

    const patchedItem = queue.getDocument().entities[createdItemId] as Item
    expect(patchedItem.title).toBe("Patched Title")
    expect(patchedItem.body).toBe("Initial item description") // body preserved
    expect(patchedItem.lastActivityAt).toBeTruthy()
  })

  it("records review and column-status changes as activity, but does not reset activity when reordering", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
    const blankDoc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("aging", "Aging", profile.identity.personId, "blank"))
    const queue = createCommandQueue(blankDoc, profile)
    const columns = Object.values(blankDoc.entities).filter(entity => entity.kind === "column")
    const created = await queue.transact({ kind: "createItem", parentId: columns[0].id, title: "First" })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const itemId = created.value.receipt.changedEntityIds[0]
    const initialActivity = (queue.getDocument().entities[itemId] as Item).lastActivityAt

    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"))
    await queue.transact({ kind: "moveEntity", entityId: itemId, parentId: columns[0].id, beforeId: null })
    expect((queue.getDocument().entities[itemId] as Item).lastActivityAt).toBe(initialActivity)

    await queue.transact({ kind: "moveEntity", entityId: itemId, parentId: columns[1].id, beforeId: null })
    expect((queue.getDocument().entities[itemId] as Item).lastActivityAt).toBe("2026-01-02T00:00:00.000Z")

    vi.setSystemTime(new Date("2026-01-03T00:00:00.000Z"))
    await queue.transact({ kind: "reviewItem", entityId: itemId })
    expect((queue.getDocument().entities[itemId] as Item).lastActivityAt).toBe("2026-01-03T00:00:00.000Z")
    vi.useRealTimers()
  })

  it("preserves independent offline title and value edits when merged", async () => {
    const queue = createCommandQueue(initialDoc, profile)
    const leadCol = Object.values(initialDoc.entities).find((e) => e.kind === "column" && e.title === "Lead")!
    const companyField = Object.values(initialDoc.entities).find((e) => e.kind === "field" && e.title === "Company")!

    const roleField = Object.values(initialDoc.entities).find((e) => e.kind === "field" && e.title === "Role")!

    const createRes = await queue.transact({
      kind: "createItem",
      parentId: leadCol.id,
      title: "Base Item",
      body: "Base Body",
      values: { [companyField.id]: "Initial Company", [roleField.id]: "Developer" },
    })
    expect(createRes.ok).toBe(true)
    if (!createRes.ok) return
    const itemId = createRes.value.receipt.changedEntityIds[0]

    // Fork document into replica A and replica B with valid hex actor IDs
    const actorA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const actorB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    const docA = Automerge.clone(queue.getDocument(), { actor: actorA })
    const docB = Automerge.clone(queue.getDocument(), { actor: actorB })

    const queueA = createCommandQueue(docA, profile, actorA)
    const queueB = createCommandQueue(docB, profile, actorB)

    // Replica A updates title
    await queueA.transact({
      kind: "patchItem",
      entityId: itemId,
      title: "Title by Tab A",
    })

    // Replica B updates company field value
    await queueB.transact({
      kind: "patchItem",
      entityId: itemId,
      values: { [companyField.id]: "Company by Tab B" },
    })

    // Merge A and B
    const merged = Automerge.merge(queueA.getDocument(), queueB.getDocument())
    const mergedItem = merged.entities[itemId] as Item

    // BOTH edits survived because actual properties were patched in place!
    expect(mergedItem.title).toBe("Title by Tab A")
    expect(mergedItem.values[companyField.id]).toBe("Company by Tab B")
    expect(mergedItem.body).toBe("Base Body")
  })

  it("restores any recorded item version through a new compensating change", async () => {
    const raw = createWorkspaceDoc("ws_history", "History", profile.identity.personId, "blank")
    const queue = createCommandQueue(Automerge.from<WorkspaceDocumentV2>(raw), profile)
    const todo = Object.values(queue.getDocument().entities).find(entity => entity.kind === "column" && entity.title === "To do")!
    const created = await queue.transact({ kind: "createItem", parentId: todo.id, title: "Before", body: "Original" })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const itemId = created.value.receipt.changedEntityIds[0]
    const creationHash = created.value.receipt.changeHash
    const patched = await queue.transact({ kind: "patchItem", entityId: itemId, title: "After", body: "Changed" })
    expect(patched.ok).toBe(true)
    if (!patched.ok) return
    const patchHash = patched.value.receipt.changeHash

    const restored = await queue.transact({ kind: "restoreItemVersion", entityId: itemId, changeHash: creationHash })
    expect(restored.ok).toBe(true)
    expect((queue.getDocument().entities[itemId] as Item)).toMatchObject({ title: "Before", body: "Original" })
    expect(Automerge.getHistory(queue.getDocument()).at(-1)?.change.message).toContain("restoreItemVersion")

    const redone = await queue.transact({ kind: "restoreItemVersion", entityId: itemId, changeHash: patchHash })
    expect(redone.ok).toBe(true)
    expect((queue.getDocument().entities[itemId] as Item)).toMatchObject({ title: "After", body: "Changed" })
  })

  it("rejects invalid commands and cycle-creating moves without mutating document", async () => {
    // Test on a blank board workspace where items have no required fields
    const rawWs = createWorkspaceDoc("ws_blank_test", "Blank Board", profile.identity.personId, "blank")
    const blankDoc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    const queue = createCommandQueue(blankDoc, profile)
    const todoCol = Object.values(blankDoc.entities).find((e) => e.kind === "column" && e.title === "To do")!

    // Create Parent Item
    const resP = await queue.transact({
      kind: "createItem",
      parentId: todoCol.id,
      title: "Parent Item",
    })
    expect(resP.ok).toBe(true)
    const parentId = resP.ok ? resP.value.receipt.changedEntityIds[0] : ""

    // Create Child Item under Parent
    const resC = await queue.transact({
      kind: "createItem",
      parentId,
      title: "Child Item",
    })
    expect(resC.ok).toBe(true)
    const childId = resC.ok ? resC.value.receipt.changedEntityIds[0] : ""

    const headsBefore = Automerge.getHeads(queue.getDocument())

    // Try to move Parent Item under Child Item -> creates cycle
    const cycleMoveRes = await queue.transact({
      kind: "moveEntity",
      entityId: parentId,
      parentId: childId,
      beforeId: null,
    })
    expect(cycleMoveRes.ok).toBe(false)
    if (!cycleMoveRes.ok) {
      expect(cycleMoveRes.error.code).toBe("cycle")
    }

    // Heads must be unchanged
    expect(Automerge.getHeads(queue.getDocument())).toEqual(headsBefore)

    // Empty title rename rejection
    const emptyRenameRes = await queue.transact({
      kind: "renameEntity",
      entityId: parentId,
      title: "   ",
    })
    expect(emptyRenameRes.ok).toBe(false)
    if (!emptyRenameRes.ok) {
      expect(emptyRenameRes.error.code).toBe("invalid_input")
    }
  })

  it("handles overlapping same-tab submissions via the publication queue sequentially", async () => {
    // Blank board
    const rawWs = createWorkspaceDoc("ws_blank_concurrent", "Blank Board", profile.identity.personId, "blank")
    const blankDoc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    const queue = createCommandQueue(blankDoc, profile)
    const todoCol = Object.values(blankDoc.entities).find((e) => e.kind === "column" && e.title === "To do")!

    // Launch 3 concurrent transactions
    const [r1, r2, r3] = await Promise.all([
      queue.transact({ kind: "createItem", parentId: todoCol.id, title: "Concurrent 1" }),
      queue.transact({ kind: "createItem", parentId: todoCol.id, title: "Concurrent 2" }),
      queue.transact({ kind: "createItem", parentId: todoCol.id, title: "Concurrent 3" }),
    ])

    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(r3.ok).toBe(true)

    const allItems = Object.values(queue.getDocument().entities).filter(isItem)
    expect(allItems).toHaveLength(3)
    const titles = allItems.map((t) => t.title)
    expect(titles).toContain("Concurrent 1")
    expect(titles).toContain("Concurrent 2")
    expect(titles).toContain("Concurrent 3")
  })

  it("creates and patches field options on select fields", async () => {
    const rawWs = createWorkspaceDoc("ws_options_test", "Select Board", profile.identity.personId, "blank")
    const blankDoc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    const queue = createCommandQueue(blankDoc, profile)
    const board = Object.values(blankDoc.entities).find((e) => e.kind === "board")!

    // 1. Create select field
    const fieldRes = await queue.transact({
      kind: "createField",
      boardId: board.id,
      title: "Severity",
      valueType: "select",
      required: false,
    })
    expect(fieldRes.ok).toBe(true)
    if (!fieldRes.ok) return
    const fieldId = fieldRes.value.receipt.changedEntityIds[0]

    // 2. Create field option "Low"
    const optRes1 = await queue.transact({
      kind: "createFieldOption",
      fieldId,
      title: "Low",
    })
    expect(optRes1.ok).toBe(true)

    // 3. Create field option "High"
    const optRes2 = await queue.transact({
      kind: "createFieldOption",
      fieldId,
      title: "High",
    })
    expect(optRes2.ok).toBe(true)

    let field = queue.getDocument().entities[fieldId] as any
    expect(field.valueType).toBe("select")
    const opts = Object.values(field.options) as any[]
    expect(opts).toHaveLength(2)
    const lowOpt = opts.find((o) => o.title === "Low")
    expect(lowOpt).toBeDefined()

    // 4. Patch option "Low" -> "Minor"
    const patchOptRes = await queue.transact({
      kind: "patchFieldOption",
      fieldId,
      optionId: lowOpt.id,
      title: "Minor",
    })
    expect(patchOptRes.ok).toBe(true)

    field = queue.getDocument().entities[fieldId] as any
    expect(field.options[lowOpt.id].title).toBe("Minor")
  })

  it("validates datetime field values when creating and patching items", async () => {
    const rawWs = createWorkspaceDoc("ws_dt_test", "Datetime Board", profile.identity.personId, "blank")
    const blankDoc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    const queue = createCommandQueue(blankDoc, profile)
    const board = Object.values(blankDoc.entities).find((e) => e.kind === "board")!
    const col = Object.values(blankDoc.entities).find((e) => e.kind === "column")!

    const fieldRes = await queue.transact({
      kind: "createField",
      boardId: board.id,
      title: "Scheduled Time",
      valueType: "datetime",
      required: true,
    })
    expect(fieldRes.ok).toBe(true)
    if (!fieldRes.ok) return
    const fieldId = fieldRes.value.receipt.changedEntityIds[0]

    // Creating with valid datetime succeeds
    const itemRes = await queue.transact({
      kind: "createItem",
      parentId: col.id,
      title: "Maintenance",
      body: "",
      values: { [fieldId]: "2026-09-12T03:00" },
    })
    expect(itemRes.ok).toBe(true)
    if (!itemRes.ok) return
    const itemId = itemRes.value.receipt.changedEntityIds[0]
    const item = queue.getDocument().entities[itemId] as any
    expect(item.values[fieldId]).toBe("2026-09-12T03:00")

    // Patching with invalid datetime fails
    const patchInvalid = await queue.transact({
      kind: "patchItem",
      entityId: itemId,
      values: { [fieldId]: "invalid-datetime" },
    })
    expect(patchInvalid.ok).toBe(false)

    // Patching with valid ISO datetime with seconds and Z succeeds
    const patchValid = await queue.transact({
      kind: "patchItem",
      entityId: itemId,
      values: { [fieldId]: "2026-09-12T03:30:00Z" },
    })
    expect(patchValid.ok).toBe(true)
    const updatedItem = queue.getDocument().entities[itemId] as any
    expect(updatedItem.values[fieldId]).toBe("2026-09-12T03:30:00Z")
  })

  it("handles setWorkspaceDeleted to soft-delete and restore workspace", async () => {
    const queue = createCommandQueue(initialDoc, profile)
    expect(queue.getDocument().deleted).toBe(false)

    const deleteRes = await queue.transact({
      kind: "setWorkspaceDeleted",
      deleted: true,
    })
    expect(deleteRes.ok).toBe(true)
    expect(queue.getDocument().deleted).toBe(true)

    const restoreRes = await queue.transact({
      kind: "setWorkspaceDeleted",
      deleted: false,
    })
    expect(restoreRes.ok).toBe(true)
    expect(queue.getDocument().deleted).toBe(false)
  })

  it("handles createBoard by adding a new board entity", async () => {
    const queue = createCommandQueue(initialDoc, profile)
    const boardRes = await queue.transact({
      kind: "createBoard",
      title: "Secondary Board",
      preset: "blank",
    })
    expect(boardRes.ok).toBe(true)
    if (!boardRes.ok) return
    const boardId = boardRes.value.receipt.changedEntityIds[0]
    const createdBoard = queue.getDocument().entities[boardId] as any
    expect(createdBoard.kind).toBe("board")
    expect(createdBoard.title).toBe("Secondary Board")
    expect(createdBoard.deleted).toBe(false)
  })

  it("rejects createWorkspace on existing workspace document", async () => {
    const queue = createCommandQueue(initialDoc, profile)
    const res = await queue.transact({
      kind: "createWorkspace",
      title: "New Workspace",
      preset: "blank",
    })
    expect(res.ok).toBe(false)
  })
})
