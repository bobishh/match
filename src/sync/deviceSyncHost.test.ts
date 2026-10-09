import { beforeEach, describe, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createDeviceSyncState } from "./deviceSyncState"
import { resetInvitationStorageForTest } from "./invitations"
import type { SyncNode, SyncTransport } from "./transport"

const { startPersistentNode } = vi.hoisted(() => ({ startPersistentNode: vi.fn() }))

vi.mock("./persistentNode", () => ({ startPersistentNode }))

import { createKeeperWorkspaceHost, generateWorkspaceInvite, type WorkspaceHostContext } from "./deviceSyncHost"

describe("workspace host endpoint identity", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetIdentityStorageForTest()
    resetInvitationStorageForTest()
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  })

  it("Given an owned workspace, when keeper and regular hosts restart, then invites keep the durable instance endpoint", async () => {
    const profile = await bootstrapIdentity("Workspace owner")
    const endpointId = "durable-instance-endpoint"
    const acceptor = { accept: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }
    const node = {
      endpointId,
      accept: vi.fn(async () => acceptor),
      close: vi.fn(async () => undefined),
    } as unknown as SyncNode
    const legacyNode = { ...node, endpointId: "legacy-route" } as SyncNode
    startPersistentNode.mockResolvedValue(legacyNode)
    const durableMesh = {
      startInstanceNode: vi.fn(async () => node),
      ensureOwnerWorkspaces: vi.fn(async () => undefined),
    }
    const transport = { start: vi.fn() } as unknown as SyncTransport
    let run = 0
    const context = (): WorkspaceHostContext => ({
      state: createDeviceSyncState(),
      workspace: {} as never,
      workspaceStore: { read: vi.fn(async () => new Uint8Array()), merge: vi.fn(), activate: vi.fn() },
      durableMesh: durableMesh as never,
      availableWorkspaces: [{ id: "job-search", title: "Job search" }],
      origin: () => "https://example.test",
      transport,
      getProfile: async () => profile,
      nextRun: () => ++run,
      currentRun: () => run,
      pauseMesh: vi.fn(async () => undefined),
      stopNode: vi.fn(async () => undefined),
      setNode: vi.fn(),
      getNode: () => node,
      startMesh: vi.fn(async () => undefined),
      attachLiveSession: vi.fn(),
      detachLiveSession: vi.fn(),
      waitForJoinDecision: vi.fn(async () => null),
      replaceDirectSession: vi.fn(),
      removeDirectSession: vi.fn(),
    })

    const firstInvite = await createKeeperWorkspaceHost(context(), [{ id: "job-search", title: "Job search" }], "rusty-service", true)
    const restoredContext = context()
    restoredContext.state.selectedWorkspaceIds.value = ["job-search"]
    expect(restoredContext.state.selectedWorkspaceIds.value).toEqual(["job-search"])
    await generateWorkspaceInvite(restoredContext)

    expect(restoredContext.state.error.value).toBe("")
    expect(firstInvite.issuerEndpoint).toBe(endpointId)
    expect(durableMesh.startInstanceNode).toHaveBeenCalledTimes(2)
    expect(new URLSearchParams(new URL(restoredContext.state.inviteUrl.value).hash.slice(1)).get("endpoint")).toBe(endpointId)
    expect(startPersistentNode).not.toHaveBeenCalled()
    expect(transport.start).not.toHaveBeenCalled()
    expect(durableMesh.ensureOwnerWorkspaces).toHaveBeenNthCalledWith(1, ["job-search"], endpointId, profile)
    expect(durableMesh.ensureOwnerWorkspaces).toHaveBeenNthCalledWith(2, ["job-search"], endpointId, profile)
    expect(restoredContext.setNode).toHaveBeenCalledWith(node)
  })
})
