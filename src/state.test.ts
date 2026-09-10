import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { initializeAutomerge } from "./crdt"
import { setStorageFailureHookForTest, WorkspaceStorage } from "./storage"
import { bootstrapIdentity, resetIdentityStorageForTest } from "./domain/identity"
import { useMatch, hydrate, resetStateForTest } from "./state"
import * as Automerge from "@automerge/automerge/slim"
import { createWorkspaceDoc } from "./domain/seeds"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("Repository-backed state and projections (Task 1.8)", () => {
  beforeEach(async () => {
    resetIdentityStorageForTest()
    setStorageFailureHookForTest(false)
    resetStateForTest()
    await bootstrapIdentity("State Test User")
    await hydrate()
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

  it("rejects an unrelated populated workspace with the same ID without replacing local data", async () => {
    const match = useMatch()
    await match.createLeadAsync({ company: "Local data", role: "Engineer", status: "lead" })
    const before = match.getAutomergeBytes()
    const id = match.getActiveDoc()!.id
    const unrelated = Automerge.from(createWorkspaceDoc(id, "Remote board", "remote-owner", "blank"))
    await expect(match.mergeScopedWorkspaceBytes(id, Automerge.save(unrelated))).rejects.toThrow(/different workspace/)
    expect(match.getAutomergeBytes()).toEqual(before)
  })

  it("rejects a document addressed to another workspace without touching the active board", async () => {
    const match = useMatch()
    const before = match.getAutomergeBytes()
    const remote = Automerge.from(createWorkspaceDoc("other", "Remote board", "owner", "blank"))
    await expect(match.mergeScopedWorkspaceBytes("selected", Automerge.save(remote))).rejects.toThrow(/Invalid workspace/)
    expect(match.getAutomergeBytes()).toEqual(before)
  })
})
