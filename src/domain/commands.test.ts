import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "./identity"
import { createWorkspaceDoc } from "./seeds"
import {
  executeCommand,
  createCommandQueue,
  type Command,
} from "./commands"
import type { WorkspaceDocumentV2, Task } from "./model"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("Transaction wrapper, commands, and publication queue (Task 1.6)", () => {
  let profile: LocalProfile
  let initialDoc: Automerge.Doc<WorkspaceDocumentV2>

  beforeEach(async () => {
    resetIdentityStorageForTest()
    profile = await bootstrapIdentity("Alice Developer")
    const rawWs = createWorkspaceDoc("ws_test", "Test Board", profile.identity.personId, "job-search")
    initialDoc = Automerge.from<WorkspaceDocumentV2>(rawWs)
  })

  it("executes createTask and patchTask, produces native metadata, and signs a change proof", async () => {
    const queue = createCommandQueue(initialDoc, profile)
    const board = Object.values(initialDoc.entities).find((e) => e.kind === "board")!
    const leadCol = Object.values(initialDoc.entities).find((e) => e.kind === "column" && e.title === "Lead")!

    const companyField = Object.values(initialDoc.entities).find((e) => e.kind === "field" && e.title === "Company")!
    const roleField = Object.values(initialDoc.entities).find((e) => e.kind === "field" && e.title === "Role")!

    const createCmd: Command = {
      kind: "createTask",
      parentId: leadCol.id,
      title: "First Task",
      body: "Initial task description",
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

    const createdTaskId = receipt.changedEntityIds[0]
    const updatedDoc = queue.getDocument()
    const task = updatedDoc.entities[createdTaskId] as Task
    expect(task).toBeDefined()
    expect(task.title).toBe("First Task")
    expect(task.body).toBe("Initial task description")
    expect(task.placement.parentId).toBe(leadCol.id)

    // Verify proof
    const proof = res1.value.proof
    expect(proof.payload.kind).toBe("change-proof")
    expect(proof.payload.changeHash).toBe(receipt.changeHash)

    // Now patch title
    const patchCmd: Command = {
      kind: "patchTask",
      entityId: createdTaskId,
      title: "Patched Title",
    }
    const res2 = await queue.transact(patchCmd)
    expect(res2.ok).toBe(true)

    const patchedTask = queue.getDocument().entities[createdTaskId] as Task
    expect(patchedTask.title).toBe("Patched Title")
    expect(patchedTask.body).toBe("Initial task description") // body preserved
  })

  it("preserves independent offline title and value edits when merged", async () => {
    const queue = createCommandQueue(initialDoc, profile)
    const leadCol = Object.values(initialDoc.entities).find((e) => e.kind === "column" && e.title === "Lead")!
    const companyField = Object.values(initialDoc.entities).find((e) => e.kind === "field" && e.title === "Company")!

    const roleField = Object.values(initialDoc.entities).find((e) => e.kind === "field" && e.title === "Role")!

    const createRes = await queue.transact({
      kind: "createTask",
      parentId: leadCol.id,
      title: "Base Task",
      body: "Base Body",
      values: { [companyField.id]: "Initial Company", [roleField.id]: "Developer" },
    })
    expect(createRes.ok).toBe(true)
    if (!createRes.ok) return
    const taskId = createRes.value.receipt.changedEntityIds[0]

    // Fork document into replica A and replica B with valid hex actor IDs
    const actorA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const actorB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    const docA = Automerge.clone(queue.getDocument(), { actor: actorA })
    const docB = Automerge.clone(queue.getDocument(), { actor: actorB })

    const queueA = createCommandQueue(docA, profile, actorA)
    const queueB = createCommandQueue(docB, profile, actorB)

    // Replica A updates title
    await queueA.transact({
      kind: "patchTask",
      entityId: taskId,
      title: "Title by Tab A",
    })

    // Replica B updates company field value
    await queueB.transact({
      kind: "patchTask",
      entityId: taskId,
      values: { [companyField.id]: "Company by Tab B" },
    })

    // Merge A and B
    const merged = Automerge.merge(queueA.getDocument(), queueB.getDocument())
    const mergedTask = merged.entities[taskId] as Task

    // BOTH edits survived because actual properties were patched in place!
    expect(mergedTask.title).toBe("Title by Tab A")
    expect(mergedTask.values[companyField.id]).toBe("Company by Tab B")
    expect(mergedTask.body).toBe("Base Body")
  })

  it("rejects invalid commands and cycle-creating moves without mutating document", async () => {
    // Test on a blank board workspace where tasks have no required fields
    const rawWs = createWorkspaceDoc("ws_blank_test", "Blank Board", profile.identity.personId, "blank")
    const blankDoc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    const queue = createCommandQueue(blankDoc, profile)
    const todoCol = Object.values(blankDoc.entities).find((e) => e.kind === "column" && e.title === "To do")!

    // Create Parent Task
    const resP = await queue.transact({
      kind: "createTask",
      parentId: todoCol.id,
      title: "Parent Task",
    })
    expect(resP.ok).toBe(true)
    const parentId = resP.ok ? resP.value.receipt.changedEntityIds[0] : ""

    // Create Child Task under Parent
    const resC = await queue.transact({
      kind: "createTask",
      parentId,
      title: "Child Task",
    })
    expect(resC.ok).toBe(true)
    const childId = resC.ok ? resC.value.receipt.changedEntityIds[0] : ""

    const headsBefore = Automerge.getHeads(queue.getDocument())

    // Try to move Parent Task under Child Task -> creates cycle
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
      queue.transact({ kind: "createTask", parentId: todoCol.id, title: "Concurrent 1" }),
      queue.transact({ kind: "createTask", parentId: todoCol.id, title: "Concurrent 2" }),
      queue.transact({ kind: "createTask", parentId: todoCol.id, title: "Concurrent 3" }),
    ])

    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(r3.ok).toBe(true)

    const allTasks = Object.values(queue.getDocument().entities).filter((e) => e.kind === "task")
    expect(allTasks).toHaveLength(3)
    const titles = allTasks.map((t) => t.title)
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
})
