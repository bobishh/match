import { describe, expect, it, vi } from "vitest"
import type { LocalProfile } from "../domain/identity"
import type { DurableMesh } from "./durableMesh"
import { removeKeeperAccess } from "./deviceSyncKeeper"
import { ownerKeepers, saveOwnerKeeper } from "./ownerKeeper"

describe("keeper removal", () => {
  it("revokes every owned board before deleting owner policy", async () => {
    const owner = `owner-${crypto.randomUUID()}`
    const keeper = `keeper-${crypto.randomUUID()}`
    const revokePerson = vi.fn(async () => {})
    await saveOwnerKeeper(owner, { personId: keeper, role: "visitor" })
    await removeKeeperAccess(keeper, {
      getProfile: async () => ({ identity: { personId: owner } }) as LocalProfile,
      workspaces: [{ id: "active" }, { id: "other" }, { id: "guest" }],
      workspaceOwner: async id => id === "guest" ? "someone-else" : owner,
      mesh: async () => ({ revokePerson }) as unknown as DurableMesh,
      activeWorkspaceId: "active",
    })
    expect(revokePerson.mock.calls).toEqual([["other", keeper], ["active", keeper]])
    await expect(ownerKeepers(owner)).resolves.toEqual([])
  })

  it("keeps owner policy when any board cannot be revoked", async () => {
    const owner = `owner-${crypto.randomUUID()}`
    const keeper = `keeper-${crypto.randomUUID()}`
    await saveOwnerKeeper(owner, { personId: keeper, role: "editor" })
    await expect(removeKeeperAccess(keeper, {
      getProfile: async () => ({ identity: { personId: owner } }) as LocalProfile,
      workspaces: [{ id: "board" }], workspaceOwner: async () => owner,
      mesh: async () => ({ revokePerson: async () => { throw new Error("offline board") } }) as unknown as DurableMesh,
    })).rejects.toThrow("offline board")
    await expect(ownerKeepers(owner)).resolves.toEqual([{ personId: keeper, role: "editor" }])
  })
})
