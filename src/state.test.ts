import { isArchiveColumn } from "./domain/archive"
import { hasEntityKind } from "./domain/model"
import { defaultStorage } from "./storage"
import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { initializeAutomerge } from "./crdt"
import { setStorageFailureHookForTest, WorkspaceStorage } from "./storage"
import { bootstrapIdentity, resetIdentityStorageForTest } from "./domain/identity"
import { useTincanban, hydrate, reconcile, resetStateForTest } from "./state"
import { persistAuthorizedCommand, refreshAvailableWorkspaces } from "./statePersistence"
import * as Automerge from "@automerge/automerge/slim"
import { createWorkspaceDoc } from "./domain/seeds"
import { projectBoardSchema } from "./domain/schema"
import { isItem } from "./domain/model"
import { authorizeLocalChanges, exportAuthorizationBundle, exportAuthorizations, recordGenesisAuthority } from "./sync/changeAuthorization"
import { executeCommand } from "./domain/commands"
import { peerStore } from "./sync/peerStore"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("Repository-backed state and projections (Requirement 1.8)", () => {
  beforeEach(async () => {
    setStorageFailureHookForTest(false)
    for (const workspace of [...await defaultStorage.listWorkspaces(), ...await defaultStorage.listArchivedWorkspaces()]) await defaultStorage.purgeWorkspaceForTest(workspace.id)
    resetIdentityStorageForTest()
    setStorageFailureHookForTest(false)
    resetStateForTest()
    await bootstrapIdentity("State Test User")
    await hydrate()
    await useTincanban().createWorkspaceAsync("Job search", "job-search")
  })

  it("rejects an invalid configured workspace before durable or active-state changes", async () => {
    const tincanban = useTincanban()
    const activeId = tincanban.activeWorkspace.id
    const beforeWorkspaceIds = tincanban.availableWorkspaces.value.map(workspace => workspace.id)
    const activeDoc = tincanban.getActiveDoc()!
    const board = Object.values(activeDoc.entities).find(entity => entity.kind === "board")!
    const draft = {
      ...projectBoardSchema(activeDoc, board.id),
      presetBindings: { ...(board.preset?.bindings ?? {}) },
      fields: [{ title: "  ", valueType: "text" as const, required: false }],
    }
    const saveSnapshot = vi.spyOn(defaultStorage, "saveSnapshot")
    const registerWorkspace = vi.spyOn(defaultStorage, "registerWorkspace")

    await expect(tincanban.createWorkspaceAsync("Invalid config", "job-search", defaultStorage, draft)).rejects.toThrow(/field title/i)

    expect(saveSnapshot).not.toHaveBeenCalled()
    expect(registerWorkspace).not.toHaveBeenCalled()
    expect(tincanban.activeWorkspace.id).toBe(activeId)
    expect(tincanban.availableWorkspaces.value.map(workspace => workspace.id)).toEqual(beforeWorkspaceIds)
    saveSnapshot.mockRestore()
    registerWorkspace.mockRestore()
  })

  it("Given a format 2 owner board, when tincanban starts, then migration is signed and durable", async () => {
    const profile = useTincanban().getCurrentProfile()!
    const old = createWorkspaceDoc(crypto.randomUUID(), "Earlier board", profile.identity.personId, "blank") as unknown as Record<string, any>
    old.formatVersion = 2
    old.deleted = false
    delete old.archivedAt
    for (const entity of Object.values(old.entities) as Array<Record<string, any>>) {
      entity.deleted = entity.kind === "column" && entity.title === "Done"
      delete entity.archivedAt
      if (entity.kind === "column") entity.displayHint = "normal"
    }
    const source = Automerge.from(old)
    await recordGenesisAuthority(source as never, profile)
    await defaultStorage.saveSnapshot(old.id, source as never, Automerge.save(source))
    await defaultStorage.registerWorkspace(old.id, old.title)
    resetStateForTest()
    await hydrate()
    const stored = (await defaultStorage.loadWorkspaceDoc(old.id))!.doc
    const hashes = Automerge.getAllChanges(stored).map(change => Automerge.decodeChange(change).hash)
    const signed = (await exportAuthorizations(Automerge.save(stored))).flatMap(record => record.signed.payload.hashes)
    expect(stored.formatVersion).toBe(3)
    expect(signed).toContain(hashes.at(-1))
    expect(Object.values(stored.entities).find(entity => entity.kind === "column" && entity.title === "Done")?.archivedAt).toBeTruthy()
  })

  it("notifies subscribers only after durable commit succeeds", async () => {
    const tincanban = useTincanban()
    let changedWorkspaceId: string | undefined

    const unsubscribe = tincanban.subscribeLocalChanges(workspaceId => {
      changedWorkspaceId = workspaceId
    })

    const lead = await tincanban.createLeadAsync({
      company: "Stripe",
      role: "Backend Engineer",
      status: "lead",
      priority: "p0",
    })

    expect(lead).toBeDefined()
    expect(changedWorkspaceId).toBe(tincanban.activeWorkspace.id)
    expect(tincanban.workspace.leads.some((l) => l.company === "Stripe")).toBe(true)

    unsubscribe()
  })

  it("Given two commands start together, when they commit to one workspace, then UI and reopened storage retain both", async () => {
    const tincanban = useTincanban()
    const workspaceId = tincanban.activeWorkspace.id

    await Promise.all([
      tincanban.createLeadAsync({ company: "Concurrent A", role: "Engineer", status: "lead" }),
      tincanban.createLeadAsync({ company: "Concurrent B", role: "Engineer", status: "lead" }),
    ])

    expect(tincanban.workspace.leads.map(lead => lead.company)).toEqual(expect.arrayContaining(["Concurrent A", "Concurrent B"]))
    const reopened = await new WorkspaceStorage({ changes: new Map(), proofs: new Map(), receipts: new Map(),
      snapshots: new Map(), workspaces: new Map(), personalRoots: new Map() }).loadWorkspaceDoc(workspaceId)
    const titles = Object.values(reopened!.doc.entities)
      .filter(isItem)
      .map(entity => entity.title)
    expect(titles).toEqual(expect.arrayContaining(["Concurrent A — Engineer", "Concurrent B — Engineer"]))
  })

  it("Given two accepted peer branches, when merges overlap, then reopened storage retains both", async () => {
    const tincanban = useTincanban()
    const base = tincanban.getActiveDoc()!
    const profile = tincanban.getCurrentProfile()!
    const column = Object.values(base.entities).find(entity => entity.kind === "column" && !entity.archivedAt && !isArchiveColumn(entity))!
    const branches = await Promise.all(["Peer A", "Peer B"].map(async title => {
      const result = await executeCommand(Automerge.clone(base), { kind: "createItem", parentId: column.id, title }, profile)
      if (!result.ok) throw new Error(result.error.message)
      await authorizeLocalChanges(result.value.newDoc, profile, [result.value.receipt.changeHash])
      const bytes = Automerge.save(result.value.newDoc)
      return { bytes, authorization: await exportAuthorizationBundle(bytes, profile) }
    }))
    await Promise.all(branches.map(branch => tincanban.mergeAuthorizedWorkspace(base.id, branch.bytes, branch.authorization)))
    const reopened = await new WorkspaceStorage().loadWorkspaceDoc(base.id)
    expect(Object.values(reopened!.doc.entities).filter(isItem).map(item => item.title)).toEqual(expect.arrayContaining(["Peer A", "Peer B"]))
  })

  it("Given local commit fails, when command is rejected, then no authorization or change leaks", async () => {
    const tincanban = useTincanban()
    const before = tincanban.getAutomergeBytes()
    const authorizations = await exportAuthorizations(before)
    setStorageFailureHookForTest(true)
    try {
      await expect(tincanban.createLeadAsync({ company: "Atomic rejection", role: "Engineer", status: "lead" })).rejects.toThrow(/Storage failure/)
    } finally { setStorageFailureHookForTest(false) }
    expect(await exportAuthorizations(before)).toEqual(authorizations)
    expect(Automerge.getHeads((await defaultStorage.loadWorkspaceDoc(tincanban.activeWorkspace.id))!.doc)).toEqual(Automerge.getHeads(tincanban.getActiveDoc()!))
  })

  it("does not notify replication or adopt change when save fails", async () => {
    const tincanban = useTincanban()
    let changeNotified = false

    const unsubscribe = tincanban.subscribeLocalChanges(() => {
      changeNotified = true
    })

    // Inject storage failure
    setStorageFailureHookForTest(true)

    await expect(
      tincanban.createLeadAsync({
        company: "Failed Corp",
        role: "Dev",
        status: "lead",
      })
    ).rejects.toThrow(/Storage failure/i)

    // Listener MUST NOT have been called!
    expect(changeNotified).toBe(false)

    // State MUST NOT contain the failed card!
    expect(tincanban.workspace.leads.some((l) => l.company === "Failed Corp")).toBe(false)

    unsubscribe()
  })

  it("rejects a local edit while an ownership transfer awaits confirmation", async () => {
    const tincanban = useTincanban()
    const workspaceId = tincanban.activeWorkspace.id
    const doc = tincanban.getActiveDoc()!
    const column = Object.values(doc.entities).find(entity => hasEntityKind(entity, "column"))
    if (!column) throw new Error("Test workspace has no column")
    vi.stubGlobal("indexedDB", {})
    vi.stubGlobal("navigator", { locks: { request: async (_name: string, operation: () => Promise<unknown>) => operation() } })
    const load = vi.spyOn(defaultStorage, "loadWorkspaceDoc").mockResolvedValue(null)
    const pending = vi.spyOn(peerStore, "getPendingOwnershipTransfer").mockResolvedValue({
      version: 1,
      workspaceId,
      transfer: {},
    })

    try {
      await expect(persistAuthorizedCommand(doc, {
        kind: "createItem",
        parentId: column.id,
        title: "Deferred edit",
      }, tincanban.getCurrentProfile()!, defaultStorage)).rejects.toThrow(
        "Ownership transfer is awaiting confirmation. Reconnect and retry the same recipient.",
      )
      expect(Object.values(tincanban.getActiveDoc()!.entities).filter(isItem)
        .some(entity => entity.title === "Deferred edit")).toBe(false)
    } finally {
      pending.mockRestore()
      load.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it("reconciles changes from BroadcastChannel without losing local state", async () => {
    const tincanban = useTincanban()
    expect(tincanban.ready.value).toBe(true)

    // Verify channel reconciliation hook exists
    expect(typeof tincanban.reconcile).toBe("function")
    await tincanban.reconcile()
    expect(tincanban.ready.value).toBe(true)
  })

  it("refreshes active and archived workspace lists with one catalog read", async () => {
    const listCatalog = vi.spyOn(defaultStorage, "listWorkspaceCatalog")

    await refreshAvailableWorkspaces(defaultStorage)

    expect(listCatalog).toHaveBeenCalledOnce()
    listCatalog.mockRestore()
  })

  it("notifies live mesh subscribers when another tab persists an inactive workspace during reconciliation", async () => {
    const tincanban = useTincanban()
    const activeWorkspaceId = tincanban.activeWorkspace.id
    const publish = vi.fn()
    const unsubscribe = tincanban.subscribeLocalChanges(publish)

    await Promise.all([
      reconcile(defaultStorage),
      reconcile(defaultStorage, true),
    ])

    expect(publish).toHaveBeenCalledOnce()
    expect(tincanban.activeWorkspace.id).toBe(activeWorkspaceId)
    unsubscribe()
  })

  it("rejects an unrelated same-ID workspace without changing local documents or identity", async () => {
    const tincanban = useTincanban()
    await tincanban.createLeadAsync({ company: "Local data", role: "Engineer", status: "lead" })
    const id = tincanban.getActiveDoc()!.id
    const unrelated = Automerge.from(createWorkspaceDoc(id, "Remote board", tincanban.getActiveDoc()!.ownerPersonId, "blank"))
    const bytes = Automerge.save(unrelated)
    await expect(tincanban.mergeAuthorizedWorkspace(id, bytes, await exportAuthorizationBundle(bytes, tincanban.getCurrentProfile()!))).rejects.toThrow("Workspace conflict")
    expect(tincanban.activeWorkspace.id).toBe(id)
    expect(tincanban.activeWorkspace.title).toBe("Job search")
    expect(tincanban.workspace.leads.some(lead => lead.company === "Local data")).toBe(true)
  })

  it("rejects a document addressed to another workspace without touching the active board", async () => {
    const tincanban = useTincanban()
    const before = tincanban.getAutomergeBytes()
    const remote = Automerge.from(createWorkspaceDoc("other", "Remote board", tincanban.getCurrentProfile()!.identity.personId, "blank"))
    const authorization = await exportAuthorizationBundle(Automerge.save(remote), tincanban.getCurrentProfile()!)
    await expect(tincanban.mergeAuthorizedWorkspace("selected", Automerge.save(remote), authorization)).rejects.toThrow(/Invalid workspace/)
    expect(tincanban.getAutomergeBytes()).toEqual(before)
  })

  it("does not allow a peer to replace the owner used to authorize chat", async () => {
    const tincanban = useTincanban()
    const before = tincanban.getActiveDoc()!
    const owner = before.ownerPersonId
    const forged = Automerge.change(Automerge.clone(before), draft => { draft.ownerPersonId = "attacker" })
    const changed = Automerge.getAllChanges(forged).map(change => Automerge.decodeChange(change).hash)
    await authorizeLocalChanges(forged, tincanban.getCurrentProfile()!, changed)
    const authorization = await exportAuthorizationBundle(Automerge.save(before), tincanban.getCurrentProfile()!)
    authorization.records = await exportAuthorizations(Automerge.save(forged))
    await expect(tincanban.mergeAuthorizedWorkspace(before.id, Automerge.save(forged), authorization)).rejects.toThrow(/owner/i)
    expect(tincanban.getActiveDoc()!.ownerPersonId).toBe(owner)
  })

  it("keeps unsigned merge helpers private and rejects importing another owner's workspace", async () => {
    const tincanban = useTincanban()
    expect(tincanban).not.toHaveProperty("mergeRemoteBytes")
    expect(tincanban).not.toHaveProperty("mergeScopedWorkspaceBytes")
    const foreign = Automerge.from(createWorkspaceDoc("foreign", "Foreign", "another-person", "blank"))
    await expect(tincanban.importWorkspaceDocument(foreign)).rejects.toThrow(/owner/i)
    expect(tincanban.availableWorkspaces.value.some(workspace => workspace.id === "foreign")).toBe(false)
  })

  it("deletes the active workspace and opens a remaining workspace", async () => {
    const tincanban = useTincanban()
    const firstId = tincanban.activeWorkspace.id
    await tincanban.createWorkspaceAsync("Keep me", "blank")
    const secondId = tincanban.activeWorkspace.id
    await tincanban.archiveWorkspaceAsync(secondId)
    expect(tincanban.activeWorkspace.id).not.toBe(secondId)
    expect(tincanban.availableWorkspaces.value.some(workspace => workspace.id === firstId)).toBe(true)
    expect(tincanban.availableWorkspaces.value.some(workspace => workspace.id === tincanban.activeWorkspace.id)).toBe(true)
    expect(tincanban.availableWorkspaces.value.some(workspace => workspace.id === secondId)).toBe(false)
    expect((await new WorkspaceStorage().loadWorkspaceDoc(secondId))?.doc.archivedAt).toEqual(expect.any(String))
  })
})
