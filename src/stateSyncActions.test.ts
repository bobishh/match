import { afterEach, describe, expect, it } from "vitest"
import { createWorkspaceDoc } from "./domain/seeds"
import type { WorkspaceStorage } from "./storage"
import { stateRuntime } from "./stateContext"
import { createSyncActions } from "./stateSyncActions"

const originalDoc = stateRuntime.activeDoc

afterEach(() => { stateRuntime.activeDoc = originalDoc })

describe("readWorkspaceDoc", () => {
  it("returns active authoritative document without touching storage", async () => {
    const doc = createWorkspaceDoc("active-id", "Current", "owner", "blank")
    stateRuntime.activeDoc = doc
    const storage = { loadWorkspaceDoc: async () => { throw new Error("unexpected storage read") } } as unknown as WorkspaceStorage
    expect(await createSyncActions().readWorkspaceDoc(doc.id, storage)).toBe(doc)
  })

  it("loads inactive workspace document without serializing it", async () => {
    const doc = createWorkspaceDoc("inactive-id", "Stored", "owner", "blank")
    stateRuntime.activeDoc = null
    const storage = { loadWorkspaceDoc: async () => ({ doc }) } as unknown as WorkspaceStorage
    expect(await createSyncActions().readWorkspaceDoc(doc.id, storage)).toBe(doc)
  })
})
