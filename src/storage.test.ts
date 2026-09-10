import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "./crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "./domain/identity"
import { createWorkspaceDoc } from "./domain/seeds"
import { executeCommand, type Command } from "./domain/commands"
import {
  WorkspaceStorage,
  setStorageFailureHookForTest,
  createWorkspaceBundleV2,
  readWorkspaceBundleV2,
  type StoredChange,
} from "./storage"
import type { WorkspaceDocumentV2 } from "./domain/model"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("Document & Change-hash persistence (Task 1.7)", () => {
  let profile: LocalProfile
  let storage: WorkspaceStorage

  beforeEach(async () => {
    resetIdentityStorageForTest()
    setStorageFailureHookForTest(false)
    profile = await bootstrapIdentity("Storage User")
    storage = new WorkspaceStorage()
  })

  it("atomically commits change bytes, proof, and transaction receipt", async () => {
    const rawWs = createWorkspaceDoc("ws_atomic", "Atomic Test", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    const initialBytes = Automerge.save(doc)

    // Save initial snapshot
    await storage.saveSnapshot("ws_atomic", doc, initialBytes)

    const col = Object.values(doc.entities).find((e) => e.kind === "column" && e.title === "To do")!
    const cmd: Command = { kind: "createTask", parentId: col.id, title: "Persisted Task" }

    const res = await executeCommand(doc, cmd, profile)
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const changeBytes = Automerge.getLastLocalChange(res.value.newDoc)!
    await storage.commitTransaction(
      "ws_atomic",
      res.value.receipt,
      changeBytes,
      res.value.proof
    )

    // Verify receipt was saved
    const storedReceipt = await storage.getReceipt("ws_atomic", res.value.receipt.transactionId)
    expect(storedReceipt).toBeDefined()
    expect(storedReceipt?.transactionId).toBe(res.value.receipt.transactionId)

    // Verify proof was saved
    const storedProof = await storage.getProof("ws_atomic", res.value.receipt.changeHash)
    expect(storedProof).toBeDefined()
    expect(storedProof?.payload.changeHash).toBe(res.value.receipt.changeHash)

    // Verify reload reproduces the task
    const reloaded = await storage.loadWorkspaceDoc("ws_atomic")
    expect(reloaded).toBeDefined()
    const task = Object.values(reloaded!.doc.entities).find((e) => e.kind === "task")
    expect(task?.title).toBe("Persisted Task")
  })

  it("handles same-ID retry idempotently returning existing receipt without duplicating change", async () => {
    const rawWs = createWorkspaceDoc("ws_retry", "Retry Test", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    await storage.saveSnapshot("ws_retry", doc, Automerge.save(doc))

    const col = Object.values(doc.entities).find((e) => e.kind === "column" && e.title === "To do")!
    const res = await executeCommand(doc, { kind: "createTask", parentId: col.id, title: "Idempotent Task" }, profile)
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const changeBytes = Automerge.getLastLocalChange(res.value.newDoc)!

    // First commit
    const firstReceipt = await storage.commitTransaction("ws_retry", res.value.receipt, changeBytes, res.value.proof)
    expect(firstReceipt.saved).toBe(true)

    // Retry same transaction ID
    const retryReceipt = await storage.commitTransaction("ws_retry", res.value.receipt, changeBytes, res.value.proof)
    expect(retryReceipt.transactionId).toBe(firstReceipt.transactionId)

    // Check that there is only 1 change stored, not 2
    const allChanges = await storage.listChanges("ws_retry")
    expect(allChanges).toHaveLength(1)
  })

  it("aborts commit cleanly when storage failure hook is active", async () => {
    const rawWs = createWorkspaceDoc("ws_fail", "Fail Test", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    await storage.saveSnapshot("ws_fail", doc, Automerge.save(doc))

    const col = Object.values(doc.entities).find((e) => e.kind === "column" && e.title === "To do")!
    const res = await executeCommand(doc, { kind: "createTask", parentId: col.id, title: "Failed Task" }, profile)
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const changeBytes = Automerge.getLastLocalChange(res.value.newDoc)!

    // Activate failure hook
    setStorageFailureHookForTest(true)

    await expect(
      storage.commitTransaction("ws_fail", res.value.receipt, changeBytes, res.value.proof)
    ).rejects.toThrow(/Storage failure/i)

    // Verify nothing uncommitted was saved
    setStorageFailureHookForTest(false)
    const storedReceipt = await storage.getReceipt("ws_fail", res.value.receipt.transactionId)
    expect(storedReceipt).toBeNull()

    const reloaded = await storage.loadWorkspaceDoc("ws_fail")
    const task = Object.values(reloaded!.doc.entities).find((e) => e.kind === "task")
    expect(task).toBeUndefined()
  })

  it("handles stale-tab concurrent saves without overwriting unseen writes", async () => {
    const rawWs = createWorkspaceDoc("ws_stale", "Stale Test", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    await storage.saveSnapshot("ws_stale", doc, Automerge.save(doc))

    const todoCol = Object.values(doc.entities).find((e) => e.kind === "column" && e.title === "To do")!

    // Tab 1 creates Task 1
    const actor1 = "11111111111111111111111111111111"
    const docTab1 = Automerge.clone(doc, { actor: actor1 })
    const res1 = await executeCommand(docTab1, { kind: "createTask", parentId: todoCol.id, title: "Tab 1 Task" }, profile, actor1)
    expect(res1.ok).toBe(true)
    if (!res1.ok) return
    await storage.commitTransaction("ws_stale", res1.value.receipt, Automerge.getLastLocalChange(res1.value.newDoc)!, res1.value.proof)

    // Tab 2 (has not loaded Tab 1's change yet) creates Task 2 from original doc
    const actor2 = "22222222222222222222222222222222"
    const docTab2 = Automerge.clone(doc, { actor: actor2 })
    const res2 = await executeCommand(docTab2, { kind: "createTask", parentId: todoCol.id, title: "Tab 2 Task" }, profile, actor2)
    expect(res2.ok).toBe(true)
    if (!res2.ok) return
    await storage.commitTransaction("ws_stale", res2.value.receipt, Automerge.getLastLocalChange(res2.value.newDoc)!, res2.value.proof)

    // Reopening workspace must union both Tab 1 and Tab 2 changes!
    const reloaded = await storage.loadWorkspaceDoc("ws_stale")
    expect(reloaded).toBeDefined()
    const tasks = Object.values(reloaded!.doc.entities).filter((e) => e.kind === "task")
    expect(tasks).toHaveLength(2)
    const titles = tasks.map((t) => t.title)
    expect(titles).toContain("Tab 1 Task")
    expect(titles).toContain("Tab 2 Task")
  })

  it("compacts snapshot while preserving unseen concurrent writer chunks", async () => {
    const rawWs = createWorkspaceDoc("ws_compact", "Compact Test", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    await storage.saveSnapshot("ws_compact", doc, Automerge.save(doc))
    const todoCol = Object.values(doc.entities).find((e) => e.kind === "column" && e.title === "To do")!

    // Save Change 1
    const res1 = await executeCommand(doc, { kind: "createTask", parentId: todoCol.id, title: "Task 1" }, profile)
    if (!res1.ok) throw new Error("res1 failed")
    await storage.commitTransaction("ws_compact", res1.value.receipt, Automerge.getLastLocalChange(res1.value.newDoc)!, res1.value.proof)

    // Concurrently, an unseen writer saves Change 2 on original doc
    const unseenActor = "99999999999999999999999999999999"
    const unseenDoc = Automerge.clone(doc, { actor: unseenActor })
    const resUnseen = await executeCommand(unseenDoc, { kind: "createTask", parentId: todoCol.id, title: "Unseen Writer Task" }, profile, unseenActor)
    if (!resUnseen.ok) throw new Error("resUnseen failed")
    await storage.commitTransaction("ws_compact", resUnseen.value.receipt, Automerge.getLastLocalChange(resUnseen.value.newDoc)!, resUnseen.value.proof)

    // Tab 1 compacts only based on res1.value.newDoc (which does not have unseen change yet)
    await storage.compactWorkspace("ws_compact", res1.value.newDoc)

    // The unseen writer's change chunk must NOT be deleted!
    const remainingChanges = await storage.listChanges("ws_compact")
    expect(remainingChanges.some((c) => c.changeHash === resUnseen.value.receipt.changeHash)).toBe(true)

    // Reload unions the compacted snapshot and the unseen writer's change
    const reloaded = await storage.loadWorkspaceDoc("ws_compact")
    const tasks = Object.values(reloaded!.doc.entities).filter((e) => e.kind === "task")
    expect(tasks).toHaveLength(2)
    const titles = tasks.map((t) => t.title)
    expect(titles).toContain("Task 1")
    expect(titles).toContain("Unseen Writer Task")
  })

  it("persists and reloads personal root document", async () => {
    const root = {
      kind: "personal-root" as const,
      formatVersion: 1 as const,
      rootId: "root_1",
      identity: profile.identity,
      devices: {
        [profile.device.deviceId]: {
          deviceId: profile.device.deviceId,
          publicKey: profile.device.publicKey,
          displayName: profile.device.displayName,
          certificateHash: "cert_hash_1",
          addedAt: new Date().toISOString(),
        },
      },
      workspaces: {
        ws_test: {
          workspaceId: "ws_test",
          documentId: "doc_test",
          grantHash: "grant_1",
          forgotten: false,
        },
      },
    }

    await storage.savePersonalRoot(root)
    const loaded = await storage.loadPersonalRoot("root_1")
    expect(loaded).toBeDefined()
    expect(loaded?.rootId).toBe("root_1")
    expect(loaded?.workspaces["ws_test"].documentId).toBe("doc_test")
  })

  it("exports v2 bundle with public proofs but without private keys, personal root, or invitation secrets (Task 2.5)", async () => {
    const rawWs = createWorkspaceDoc("ws_export", "Export Test", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    const heads = Automerge.getHeads(doc).sort()
    const automergeBytes = Automerge.save(doc)

    const col = Object.values(doc.entities).find((e) => e.kind === "column" && e.title === "To do")!
    const res = await executeCommand(doc, { kind: "createTask", parentId: col.id, title: "Exported Task" }, profile)
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const changeBytes = Automerge.getLastLocalChange(res.value.newDoc)!
    await storage.commitTransaction("ws_export", res.value.receipt, changeBytes, res.value.proof)

    const proofs = await storage.getProofs("ws_export")
    expect(proofs.changeProofs).toHaveLength(1)

    await storage.savePersonalRoot({
      kind: "personal-root",
      formatVersion: 1,
      rootId: "root_secret",
      identity: profile.identity,
      devices: {},
      workspaces: {},
    })

    const bundleBytes = createWorkspaceBundleV2("ws_export", heads, automergeBytes, proofs, { title: "Export Test" })
    const unzipped = readWorkspaceBundleV2(bundleBytes)

    expect(unzipped.manifest.version).toBe(2)
    expect(unzipped.manifest.workspaceId).toBe("ws_export")
    expect(unzipped.proofs.changeProofs).toHaveLength(1)

    const strRepr = JSON.stringify(unzipped)
    expect(strRepr).not.toContain("privateKey")
    expect(strRepr).not.toContain("privateKeys")
    expect(strRepr).not.toContain("root_secret")
    expect(strRepr).not.toContain("personal-root")
    expect(strRepr).not.toContain("invitationSecret")
  })

  it("persists changes, proofs, receipts, and personal root across fresh storage instances (simulated reload)", async () => {
    const rawWs = createWorkspaceDoc("ws_reload", "Reload Test", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    const initialBytes = Automerge.save(doc)

    await storage.saveSnapshot("ws_reload", doc, initialBytes)

    const col = Object.values(doc.entities).find((e) => e.kind === "column" && e.title === "To do")!
    const res = await executeCommand(doc, { kind: "createTask", parentId: col.id, title: "Persisted Task" }, profile)
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const changeBytes = Automerge.getLastLocalChange(res.value.newDoc)!
    await storage.commitTransaction("ws_reload", res.value.receipt, changeBytes, res.value.proof)

    await storage.savePersonalRoot({
      kind: "personal-root",
      formatVersion: 1,
      rootId: "root_reload",
      identity: profile.identity,
      devices: {},
      workspaces: {},
    })

    // Simulate page reload: fresh storage with empty in-memory store
    const freshStorage = new WorkspaceStorage({
      changes: new Map(),
      proofs: new Map(),
      receipts: new Map(),
      snapshots: new Map(),
      workspaces: new Map(),
      personalRoots: new Map(),
    })

    // Should be able to load changes, proofs, receipts, and personal root from persistent backing
    const changes = await freshStorage.listChanges("ws_reload")
    expect(changes).toHaveLength(1)

    const proof = await freshStorage.getProof("ws_reload", res.value.receipt.changeHash)
    expect(proof).toBeDefined()
    expect(proof?.payload.changeHash).toBe(res.value.receipt.changeHash)

    const receipt = await freshStorage.getReceipt("ws_reload", res.value.receipt.transactionId)
    expect(receipt).toBeDefined()

    const root = await freshStorage.loadPersonalRoot("root_reload")
    expect(root).toBeDefined()
    expect(root?.rootId).toBe("root_reload")

    const loadedDoc = await freshStorage.loadWorkspaceDoc("ws_reload")
    expect(loadedDoc).toBeDefined()
    const tasks = Object.values(loadedDoc!.doc.entities).filter((e) => e.kind === "task")
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe("Persisted Task")
  })
})
