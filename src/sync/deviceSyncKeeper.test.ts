import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot, registerWorkspaceInRoot } from "../domain/personalRoot"
import { defaultStorage } from "../storage"
import type { DurableMesh } from "./durableMesh"
import { removeKeeperAccess } from "./deviceSyncKeeper"
import { ownerKeepers, saveOwnerKeeper } from "./ownerKeeper"

describe("keeper removal", () => {
  beforeEach(() => resetIdentityStorageForTest())
  afterEach(() => vi.restoreAllMocks())

  async function setupOwnerKeeper(scopeIds: string[]) {
    const profile = await bootstrapIdentity("Keeper owner")
    const owner = profile.identity.personId
    const keeper = `keeper-${crypto.randomUUID()}`
    const root = createPersonalRoot(profile, "keeper-test-certificate")
    for (const id of scopeIds) registerWorkspaceInRoot(root, id, id, "import")
    root.keeperIntegrations = {
      integration: {
        integrationId: "integration",
        serviceOrigin: "https://rusty.example",
        servicePersonId: keeper,
        serviceDeviceId: "rusty-device",
        servicePublicKey: "rusty-public-key",
        serviceCertificates: [],
        workspaceIds: scopeIds,
        scopeReceipts: scopeIds.map(workspaceId => ({ workspaceId, grantEpoch: 1, activationOperationId: "activation" })),
        futureBoards: false,
        futureBoardBaselineIds: scopeIds,
        revision: 1,
        state: "active",
        verifiedAt: new Date().toISOString(),
      },
    }
    await defaultStorage.savePersonalRoot(root)
    return {
      profile,
      owner,
      keeper,
      discovery: {
        origin: "https://rusty.example",
        displayName: "Rusty keeper",
        personId: keeper,
        deviceId: "rusty-device",
        publicKey: "rusty-public-key",
        certificates: [],
        fingerprint: "",
        capabilities: { modes: ["replicate" as const], documentReplication: true, chatReplication: true, blobReplication: true, pairing: true },
      },
    }
  }

  it("revokes every owned board locally and keeps policy while Rusty confirmation is unavailable", async () => {
    const { profile, owner, keeper, discovery } = await setupOwnerKeeper(["other", "active"])
    const revokePerson = vi.fn(async () => {})
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ message: "offline Rusty" }), { status: 503, headers: { "Content-Type": "application/json" } },
    ))
    await saveOwnerKeeper(owner, { personId: keeper, role: "visitor" })
    await expect(removeKeeperAccess(keeper, {
      getProfile: async () => profile,
      workspaces: [{ id: "active" }, { id: "other" }, { id: "guest" }],
      workspaceOwner: async id => id === "guest" ? "someone-else" : owner,
      mesh: async () => ({ revokePerson }) as unknown as DurableMesh,
      activeWorkspaceId: "active",
      discovery,
      knownServiceDeviceIds: ["rusty-device"],
    })).rejects.toThrow("Local access was revoked; Rusty confirmation is still pending")
    expect(revokePerson.mock.calls).toEqual([["other", keeper], ["active", keeper]])
    expect(fetchMock).toHaveBeenCalledOnce()
    await expect(ownerKeepers(owner)).resolves.toEqual([{ personId: keeper, role: "visitor" }])
  })

  it("keeps owner policy when any board cannot be revoked", async () => {
    const { profile, owner, keeper, discovery } = await setupOwnerKeeper(["board"])
    await saveOwnerKeeper(owner, { personId: keeper, role: "editor" })
    await expect(removeKeeperAccess(keeper, {
      getProfile: async () => profile,
      workspaces: [{ id: "board" }], workspaceOwner: async () => owner,
      mesh: async () => ({ revokePerson: async () => { throw new Error("offline board") } }) as unknown as DurableMesh,
      discovery,
    })).rejects.toThrow("offline board")
    await expect(ownerKeepers(owner)).resolves.toEqual([{ personId: keeper, role: "editor" }])
  })
})
