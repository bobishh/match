import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot, registerWorkspaceInRoot } from "../domain/personalRoot"
import { defaultStorage } from "../storage"
import type { DurableMesh } from "./durableMesh"
import { removeKeeperAccess } from "./deviceSyncKeeper"
import { ownerKeepers, saveOwnerKeeper } from "./ownerKeeper"
import * as ownerKeeperStorage from "./ownerKeeper"
import * as lighthousePairing from "./lighthousePairing"

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

  it("revokes only locally owned legacy boards and finishes removal without a Rusty address", async () => {
    const { profile, owner, keeper } = await setupOwnerKeeper(["owned", "foreign"])
    const root = await defaultStorage.loadPersonalRoot()
    root!.keeperIntegrations = {}
    await defaultStorage.savePersonalRoot(root!)
    await saveOwnerKeeper(owner, { personId: keeper, role: "editor", details: {
      boardIds: ["owned", "foreign"], futureBoards: false,
    } })
    let intentPersistedBeforeRevoke = false
    const revokePerson = vi.fn(async () => {
      intentPersistedBeforeRevoke = (await ownerKeepers(owner))[0]?.details?.removalPending === true
    })
    const trace = vi.fn()
    const fetchMock = vi.spyOn(globalThis, "fetch")

    await expect(removeKeeperAccess(keeper, {
      getProfile: async () => profile,
      workspaces: [{ id: "owned" }, { id: "foreign" }],
      workspaceOwner: async id => id === "owned" ? owner : "another-owner",
      mesh: async () => ({ revokePerson }) as unknown as DurableMesh,
      knownServiceDeviceIds: ["rusty-device"],
      trace,
    })).resolves.toBe("removed")

    expect(revokePerson.mock.calls).toEqual([["owned", keeper]])
    expect(trace).toHaveBeenCalledWith("scope-owner", { peerId: keeper, workspaceId: "owned", outcome: "owner" })
    expect(trace).toHaveBeenCalledWith("scope-owner", { peerId: keeper, workspaceId: "foreign", outcome: "other" })
    expect(trace).toHaveBeenCalledWith("revoke-complete", { peerId: keeper, workspaceId: "owned", outcome: "success" })
    expect(intentPersistedBeforeRevoke).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(ownerKeepers(owner)).resolves.toEqual([])
  })
  it("recovers missing legacy board lists from available owned boards and disables future access", async () => {
    const { profile, owner, keeper } = await setupOwnerKeeper(["owned", "foreign"])
    const root = await defaultStorage.loadPersonalRoot()
    root!.keeperIntegrations = {}
    await defaultStorage.savePersonalRoot(root!)
    await saveOwnerKeeper(owner, { personId: keeper, role: "editor" })
    const revokePerson = vi.fn(async () => {})
    const fetchMock = vi.spyOn(globalThis, "fetch")
    await expect(removeKeeperAccess(keeper, {
      getProfile: async () => profile,
      workspaces: [{ id: "owned" }, { id: "foreign" }],
      workspaceOwner: async id => id === "owned" ? owner : "another-owner",
      mesh: async () => ({ revokePerson }) as unknown as DurableMesh,
      knownServiceDeviceIds: ["rusty-device"],
    })).resolves.toBe("removed")
    expect(revokePerson.mock.calls).toEqual([["owned", keeper]])
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(ownerKeepers(owner)).resolves.toEqual([])
  })

  it("retries local keeper cleanup after a verified removal receipt survives restart", async () => {
    const { profile, owner, keeper } = await setupOwnerKeeper(["board"])
    await saveOwnerKeeper(owner, { personId: keeper, role: "editor" })
    const mesh = { revokePerson: vi.fn(async () => {}), views: vi.fn(async () => []) } as unknown as DurableMesh
    const active = { integrationId: "integration", revision: 1, futureBoards: false, scopes: [
      { workspaceId: "board", grantEpoch: 1, state: "active" as const, activationOperationId: "activation" },
    ], tombstones: [] }
    const removed = { ...active, revision: 2, scopes: [], tombstones: [
      { workspaceId: "board", grantEpoch: 1, operationId: "remove-op", state: "removed" as const, cleanup: "complete" as const },
    ] }
    const status = vi.spyOn(lighthousePairing, "getKeeperIntegrationStatus")
      .mockResolvedValueOnce({ integrations: [active], signerKeyId: "rusty-device", signature: "signed", revision: 1 })
      .mockResolvedValue({ integrations: [removed], signerKeyId: "rusty-device", signature: "signed", revision: 2 })
    vi.spyOn(lighthousePairing, "disconnectKeeperIntegration").mockResolvedValue({
      integrationId: "integration", operationId: "remove-op", requestHash: "request-hash", revision: 2,
      status: "removed", scopes: [{ workspaceId: "board", grantEpoch: 1, state: "removed", cleanup: "complete" }],
    })
    vi.spyOn(ownerKeeperStorage, "removeOwnerKeeper").mockRejectedValueOnce(new Error("storage unavailable"))
    const options = {
      getProfile: async () => profile,
      workspaces: [{ id: "board" }], workspaceOwner: async () => owner, mesh: async () => mesh,
    }

    await expect(removeKeeperAccess(keeper, options)).rejects.toThrow("Rusty confirmed removal; local keeper cleanup is pending")
    const afterReceipt = (await ownerKeeperStorage.keeperIntegrationReferences()).integrations.integration
    expect(afterReceipt).toMatchObject({ state: "removed", workspaceIds: [], completedRemoval: {
      operationId: "remove-op", scopes: [{ workspaceId: "board", grantEpoch: 1 }],
    } })

    await expect(removeKeeperAccess(keeper, options)).resolves.toBe("removed")
    expect(status).toHaveBeenCalledTimes(2)
    expect(mesh.revokePerson).toHaveBeenCalledOnce()
    await expect(ownerKeepers(owner)).resolves.toEqual([])
    expect((await ownerKeeperStorage.keeperIntegrationReferences()).integrations.integration?.scopeReceipts).toEqual([])
  })

})
