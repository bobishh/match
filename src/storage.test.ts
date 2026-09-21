import { readFile } from "node:fs/promises"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "./crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "./domain/identity"
import { createPersonalRoot } from "./domain/personalRoot"
import { createWorkspaceDoc } from "./domain/seeds"
import { executeCommand, type Command } from "./domain/commands"
import { isItem } from "./domain/model"
import {
  WorkspaceStorage,
  setStorageFailureHookForTest,
  createWorkspaceBundleV2,
  readWorkspaceBundleV2,
} from "./storage"
import type { WorkspaceDocumentV2 } from "./domain/model"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("Workspace catalog across browser tabs", () => {
  let backing: Map<string, string>
  const tab = () => new WorkspaceStorage({ changes: new Map(), proofs: new Map(), receipts: new Map(),
    snapshots: new Map(), workspaces: new Map(), personalRoots: new Map() })
  beforeEach(() => {
    backing = new Map()
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => backing.set(key, value),
      removeItem: (key: string) => backing.delete(key),
      key: (index: number) => [...backing.keys()][index] ?? null,
      get length() { return backing.size },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it("keeps a received workspace when a stale tab saves another workspace", async () => {
    const old = tab()
    await old.registerWorkspace("existing", "Existing")
    const receiving = tab()
    await receiving.listWorkspaces()
    await receiving.registerWorkspace("new", "Twang issues")
    await old.registerWorkspace("existing", "Edited")
    expect((await tab().listWorkspaces()).map(w => w.id)).toEqual(expect.arrayContaining(["existing", "new"]))
  })

  it("recovers an unlisted snapshot without reading the retired catalog", async () => {
    const doc = Automerge.from(createWorkspaceDoc("orphan", "Twang issues", "owner", "blank"))
    await tab().saveSnapshot("orphan", doc, Automerge.save(doc))
    for (const key of [...backing.keys()]) if (!key.startsWith("match.snapshot.")) backing.delete(key)
    backing.set("match.workspaces", JSON.stringify([{ id: "legacy", title: "Retired", updatedAt: "2026-09-17" }]))
    expect((await tab().listWorkspaces()).map(w => w.title)).toEqual(["Twang issues"])
  })

  it("does not resurrect a deleted workspace from a stale tab or legacy catalog", async () => {
    const stale = tab()
    await stale.registerWorkspace("gone", "Gone")
    await tab().deleteWorkspace("gone")
    backing.set("match.workspaces", JSON.stringify([{ id: "gone", title: "Gone", updatedAt: "2026-09-17" }]))
    expect(await stale.listWorkspaces()).toEqual([])
    await expect(stale.registerWorkspace("gone", "Stale edit")).rejects.toThrow(/deleted/i)
  })

  it("reports a browser write failure instead of pretending the workspace was saved", async () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError") })
    await expect(tab().registerWorkspace("full", "Full")).rejects.toThrow("QuotaExceededError")
  })

  it("does not cache a durable receipt when the browser rejects the write", async () => {
    const storage = tab()
    const receipt = { transactionId: "failed-save", changeHash: "change" } as never
    const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError") })
    await expect(storage.commitTransaction("workspace", receipt, new Uint8Array([1]), {} as never)).rejects.toThrow("QuotaExceededError")
    expect(await storage.getReceipt("workspace", "failed-save")).toBeNull()
    write.mockRestore()
    await storage.commitTransaction("workspace", receipt, new Uint8Array([1]), {} as never)
    expect(await tab().getReceipt("workspace", "failed-save")).toEqual(receipt)
  })
})

describe("Document & Change-hash persistence (Requirement 1.7)", () => {
  let profile: LocalProfile
  let storage: WorkspaceStorage

  beforeEach(async () => {
    resetIdentityStorageForTest()
    setStorageFailureHookForTest(false)
    profile = await bootstrapIdentity("Storage User")
    storage = new WorkspaceStorage()
  })

  it("loads stored documents without creating unsigned CRDT changes", async () => {
    const raw = createWorkspaceDoc(crypto.randomUUID(), "Legacy", profile.identity.personId, "blank")
    let doc = Automerge.from<WorkspaceDocumentV2>(raw)
    const column = Object.values(doc.entities).find(e => e.kind === "column")!
    const result = await executeCommand(doc, { kind: "createItem", parentId: column.id, title: "Legacy" }, profile)
    if (!result.ok) throw new Error(result.error.message)
    doc = Automerge.change(result.value.newDoc, draft => { (Object.values(draft.entities).find(isItem) as any).kind = "task" })
    const heads = Automerge.getHeads(doc)
    await storage.saveSnapshot(doc.id, doc, Automerge.save(doc))
    expect((await storage.loadWorkspaceDoc(doc.id))!.heads).toEqual(heads)
  })

  it("selects the current identity root after enrollment instead of the first stored root", async () => {
    await storage.savePersonalRoot(createPersonalRoot(profile, "old-cert", "00000000-0000-4000-8000-000000000001"))
    resetIdentityStorageForTest()
    const enrolled = await bootstrapIdentity("Enrolled identity")
    await storage.savePersonalRoot(createPersonalRoot(enrolled, "new-cert", "00000000-0000-4000-8000-000000000002"))
    expect((await storage.loadPersonalRoot())?.rootId).toBe("00000000-0000-4000-8000-000000000002")
    expect((await storage.loadPersonalRoot("00000000-0000-4000-8000-000000000001"))?.identity.personId).toBe(profile.identity.personId)
  })

  it("atomically commits change bytes, proof, and transaction receipt", async () => {
    const rawWs = createWorkspaceDoc("ws_atomic", "Atomic Test", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    const initialBytes = Automerge.save(doc)

    // Save initial snapshot
    await storage.saveSnapshot("ws_atomic", doc, initialBytes)

    const col = Object.values(doc.entities).find((e) => e.kind === "column" && e.title === "To do")!
    const cmd: Command = { kind: "createItem", parentId: col.id, title: "Persisted Item" }

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

    // Verify reload reproduces the item
    const reloaded = await storage.loadWorkspaceDoc("ws_atomic")
    expect(reloaded).toBeDefined()
    const item = Object.values(reloaded!.doc.entities).find(isItem)
    expect(item?.title).toBe("Persisted Item")
  })

  it("handles same-ID retry idempotently returning existing receipt without duplicating change", async () => {
    const rawWs = createWorkspaceDoc("ws_retry", "Retry Test", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    await storage.saveSnapshot("ws_retry", doc, Automerge.save(doc))

    const col = Object.values(doc.entities).find((e) => e.kind === "column" && e.title === "To do")!
    const res = await executeCommand(doc, { kind: "createItem", parentId: col.id, title: "Idempotent Item" }, profile)
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
    const res = await executeCommand(doc, { kind: "createItem", parentId: col.id, title: "Failed Item" }, profile)
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
    const item = Object.values(reloaded!.doc.entities).find(isItem)
    expect(item).toBeUndefined()
  })

  it("handles stale-tab concurrent saves without overwriting unseen writes", async () => {
    const rawWs = createWorkspaceDoc("ws_stale", "Stale Test", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    await storage.saveSnapshot("ws_stale", doc, Automerge.save(doc))

    const todoCol = Object.values(doc.entities).find((e) => e.kind === "column" && e.title === "To do")!

    // Tab 1 creates Item 1
    const actor1 = "11111111111111111111111111111111"
    const docTab1 = Automerge.clone(doc, { actor: actor1 })
    const res1 = await executeCommand(docTab1, { kind: "createItem", parentId: todoCol.id, title: "Tab 1 Item" }, profile, actor1)
    expect(res1.ok).toBe(true)
    if (!res1.ok) return
    await storage.commitTransaction("ws_stale", res1.value.receipt, Automerge.getLastLocalChange(res1.value.newDoc)!, res1.value.proof)

    // Tab 2 (has not loaded Tab 1's change yet) creates Item 2 from original doc
    const actor2 = "22222222222222222222222222222222"
    const docTab2 = Automerge.clone(doc, { actor: actor2 })
    const res2 = await executeCommand(docTab2, { kind: "createItem", parentId: todoCol.id, title: "Tab 2 Item" }, profile, actor2)
    expect(res2.ok).toBe(true)
    if (!res2.ok) return
    await storage.commitTransaction("ws_stale", res2.value.receipt, Automerge.getLastLocalChange(res2.value.newDoc)!, res2.value.proof)

    // Reopening workspace must union both Tab 1 and Tab 2 changes!
    const reloaded = await storage.loadWorkspaceDoc("ws_stale")
    expect(reloaded).toBeDefined()
    const items = Object.values(reloaded!.doc.entities).filter(isItem)
    expect(items).toHaveLength(2)
    const titles = items.map((t) => t.title)
    expect(titles).toContain("Tab 1 Item")
    expect(titles).toContain("Tab 2 Item")
  })

  it("compacts snapshot while preserving unseen concurrent writer chunks", async () => {
    const rawWs = createWorkspaceDoc("ws_compact", "Compact Test", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    await storage.saveSnapshot("ws_compact", doc, Automerge.save(doc))
    const todoCol = Object.values(doc.entities).find((e) => e.kind === "column" && e.title === "To do")!

    // Save Change 1
    const res1 = await executeCommand(doc, { kind: "createItem", parentId: todoCol.id, title: "Item 1" }, profile)
    if (!res1.ok) throw new Error("res1 failed")
    await storage.commitTransaction("ws_compact", res1.value.receipt, Automerge.getLastLocalChange(res1.value.newDoc)!, res1.value.proof)

    // Concurrently, an unseen writer saves Change 2 on original doc
    const unseenActor = "99999999999999999999999999999999"
    const unseenDoc = Automerge.clone(doc, { actor: unseenActor })
    const resUnseen = await executeCommand(unseenDoc, { kind: "createItem", parentId: todoCol.id, title: "Unseen Writer Item" }, profile, unseenActor)
    if (!resUnseen.ok) throw new Error("resUnseen failed")
    await storage.commitTransaction("ws_compact", resUnseen.value.receipt, Automerge.getLastLocalChange(resUnseen.value.newDoc)!, resUnseen.value.proof)

    // Tab 1 compacts only based on res1.value.newDoc (which does not have unseen change yet)
    await storage.compactWorkspace("ws_compact", res1.value.newDoc)

    // The unseen writer's change chunk must NOT be deleted!
    const remainingChanges = await storage.listChanges("ws_compact")
    expect(remainingChanges.some((c) => c.changeHash === resUnseen.value.receipt.changeHash)).toBe(true)

    // Reload unions the compacted snapshot and the unseen writer's change
    const reloaded = await storage.loadWorkspaceDoc("ws_compact")
    const items = Object.values(reloaded!.doc.entities).filter(isItem)
    expect(items).toHaveLength(2)
    const titles = items.map((t) => t.title)
    expect(titles).toContain("Item 1")
    expect(titles).toContain("Unseen Writer Item")
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

  it("exports v2 bundle with public proofs but without private keys, personal root, or invitation secrets (Requirement 2.5)", async () => {
    const rawWs = createWorkspaceDoc("ws_export", "Export Test", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    const heads = Automerge.getHeads(doc).sort()
    const automergeBytes = Automerge.save(doc)

    const col = Object.values(doc.entities).find((e) => e.kind === "column" && e.title === "To do")!
    const res = await executeCommand(doc, { kind: "createItem", parentId: col.id, title: "Exported Item" }, profile)
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
    const res = await executeCommand(doc, { kind: "createItem", parentId: col.id, title: "Persisted Item" }, profile)
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
    const items = Object.values(loadedDoc!.doc.entities).filter(isItem)
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe("Persisted Item")
  })
})
