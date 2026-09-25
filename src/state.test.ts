import { defaultStorage } from "./storage"
import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { initializeAutomerge } from "./crdt"
import { setStorageFailureHookForTest, WorkspaceStorage } from "./storage"
import { bootstrapIdentity, resetIdentityStorageForTest } from "./domain/identity"
import { useMatch, hydrate, reconcile, resetStateForTest } from "./state"
import * as Automerge from "@automerge/automerge/slim"
import { createWorkspaceDoc } from "./domain/seeds"
import { isItem } from "./domain/model"
import { authorizeLocalChanges, exportAuthorizationBundle, exportAuthorizations } from "./sync/changeAuthorization"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("Repository-backed state and projections (Requirement 1.8)", () => {
  beforeEach(async () => {
    setStorageFailureHookForTest(false)
    for (const workspace of await defaultStorage.listWorkspaces()) await defaultStorage.deleteWorkspace(workspace.id)
    resetIdentityStorageForTest()
    setStorageFailureHookForTest(false)
    resetStateForTest()
    await bootstrapIdentity("State Test User")
    await hydrate()
    await useMatch().createWorkspaceAsync("Job search", "job-search")
  })

  it("notifies subscribers only after durable commit succeeds", async () => {
    const match = useMatch()
    let changeNotified = false

    const unsubscribe = match.subscribeLocalChanges(() => {
      changeNotified = true
    })

    const lead = await match.createLeadAsync({
      company: "Stripe",
      role: "Backend Engineer",
      status: "lead",
      priority: "p0",
    })

    expect(lead).toBeDefined()
    expect(changeNotified).toBe(true)
    expect(match.workspace.leads.some((l) => l.company === "Stripe")).toBe(true)

    unsubscribe()
  })

  it("Given two commands start together, when they commit to one workspace, then UI and reopened storage retain both", async () => {
    const match = useMatch()
    const workspaceId = match.activeWorkspace.id

    await Promise.all([
      match.createLeadAsync({ company: "Concurrent A", role: "Engineer", status: "lead" }),
      match.createLeadAsync({ company: "Concurrent B", role: "Engineer", status: "lead" }),
    ])

    expect(match.workspace.leads.map(lead => lead.company)).toEqual(expect.arrayContaining(["Concurrent A", "Concurrent B"]))
    const reopened = await new WorkspaceStorage({ changes: new Map(), proofs: new Map(), receipts: new Map(),
      snapshots: new Map(), workspaces: new Map(), personalRoots: new Map() }).loadWorkspaceDoc(workspaceId)
    const titles = Object.values(reopened!.doc.entities)
      .filter(isItem)
      .map(entity => entity.title)
    expect(titles).toEqual(expect.arrayContaining(["Concurrent A — Engineer", "Concurrent B — Engineer"]))
  })

  it("does not notify replication or adopt change when save fails", async () => {
    const match = useMatch()
    let changeNotified = false

    const unsubscribe = match.subscribeLocalChanges(() => {
      changeNotified = true
    })

    // Inject storage failure
    setStorageFailureHookForTest(true)

    await expect(
      match.createLeadAsync({
        company: "Failed Corp",
        role: "Dev",
        status: "lead",
      })
    ).rejects.toThrow(/Storage failure/i)

    // Listener MUST NOT have been called!
    expect(changeNotified).toBe(false)

    // State MUST NOT contain the failed card!
    expect(match.workspace.leads.some((l) => l.company === "Failed Corp")).toBe(false)

    unsubscribe()
  })

  it("reconciles changes from BroadcastChannel without losing local state", async () => {
    const match = useMatch()
    expect(match.ready.value).toBe(true)

    // Verify channel reconciliation hook exists
    expect(typeof match.reconcile).toBe("function")
    await match.reconcile()
    expect(match.ready.value).toBe(true)
  })

  it("notifies live mesh subscribers when another tab persists an inactive workspace during reconciliation", async () => {
    const match = useMatch()
    const activeWorkspaceId = match.activeWorkspace.id
    const publish = vi.fn()
    const unsubscribe = match.subscribeLocalChanges(publish)

    await Promise.all([
      reconcile(defaultStorage),
      reconcile(defaultStorage, true),
    ])

    expect(publish).toHaveBeenCalledOnce()
    expect(match.activeWorkspace.id).toBe(activeWorkspaceId)
    unsubscribe()
  })

  it("rejects an unrelated same-ID workspace without changing local documents or identity", async () => {
    const match = useMatch()
    await match.createLeadAsync({ company: "Local data", role: "Engineer", status: "lead" })
    const id = match.getActiveDoc()!.id
    const unrelated = Automerge.from(createWorkspaceDoc(id, "Remote board", match.getActiveDoc()!.ownerPersonId, "blank"))
    const bytes = Automerge.save(unrelated)
    await expect(match.mergeAuthorizedWorkspace(id, bytes, await exportAuthorizationBundle(bytes, match.getCurrentProfile()!))).rejects.toThrow("Workspace conflict")
    expect(match.activeWorkspace.id).toBe(id)
    expect(match.activeWorkspace.title).toBe("Job search")
    expect(match.workspace.leads.some(lead => lead.company === "Local data")).toBe(true)
  })

  it("rejects a document addressed to another workspace without touching the active board", async () => {
    const match = useMatch()
    const before = match.getAutomergeBytes()
    const remote = Automerge.from(createWorkspaceDoc("other", "Remote board", match.getCurrentProfile()!.identity.personId, "blank"))
    const authorization = await exportAuthorizationBundle(Automerge.save(remote), match.getCurrentProfile()!)
    await expect(match.mergeAuthorizedWorkspace("selected", Automerge.save(remote), authorization)).rejects.toThrow(/Invalid workspace/)
    expect(match.getAutomergeBytes()).toEqual(before)
  })

  it("does not allow a peer to replace the owner used to authorize chat", async () => {
    const match = useMatch()
    const before = match.getActiveDoc()!
    const owner = before.ownerPersonId
    const forged = Automerge.change(Automerge.clone(before), draft => { draft.ownerPersonId = "attacker" })
    const changed = Automerge.getAllChanges(forged).map(change => Automerge.decodeChange(change).hash)
    await authorizeLocalChanges(forged, match.getCurrentProfile()!, changed)
    const authorization = await exportAuthorizationBundle(Automerge.save(before), match.getCurrentProfile()!)
    authorization.records = await exportAuthorizations(Automerge.save(forged))
    await expect(match.mergeAuthorizedWorkspace(before.id, Automerge.save(forged), authorization)).rejects.toThrow(/owner/i)
    expect(match.getActiveDoc()!.ownerPersonId).toBe(owner)
  })

  it("keeps unsigned merge helpers private and rejects importing another owner's workspace", async () => {
    const match = useMatch()
    expect(match).not.toHaveProperty("mergeRemoteBytes")
    expect(match).not.toHaveProperty("mergeScopedWorkspaceBytes")
    const foreign = Automerge.from(createWorkspaceDoc("foreign", "Foreign", "another-person", "blank"))
    await expect(match.importWorkspaceDocument(foreign)).rejects.toThrow(/owner/i)
    expect(match.availableWorkspaces.value.some(workspace => workspace.id === "foreign")).toBe(false)
  })

  it("deletes the active workspace and opens a remaining workspace", async () => {
    const match = useMatch()
    const firstId = match.activeWorkspace.id
    await match.createWorkspaceAsync("Keep me", "blank")
    const secondId = match.activeWorkspace.id
    await match.deleteWorkspaceAsync(secondId)
    expect(match.activeWorkspace.id).not.toBe(secondId)
    expect(match.availableWorkspaces.value.some(workspace => workspace.id === firstId)).toBe(true)
    expect(match.availableWorkspaces.value.some(workspace => workspace.id === match.activeWorkspace.id)).toBe(true)
    expect(match.availableWorkspaces.value.some(workspace => workspace.id === secondId)).toBe(false)
    expect(await new WorkspaceStorage().loadWorkspaceDoc(secondId)).toBeNull()
  })
})
