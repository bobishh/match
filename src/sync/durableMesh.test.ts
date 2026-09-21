import { beforeAll, describe, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { MeshNetworkError } from "@meta-uber/mesh-transport"
import { bootstrapIdentity, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, toBase64Url, type LocalProfile } from "../domain/identity"
import { certHashDefault, createDelegatedCertificate, createWorkspaceGrant } from "../domain/proofs"
import { createWorkspaceBreakGlassClaim, createWorkspaceOwnershipTransfer, verifyWorkspaceGrant } from "./meshRecords"
import { assertRequiredMeshCapabilities, DurableMesh, isMeshDialNetworkFailure, shouldReplaceMeshSession } from "./durableMesh"

beforeAll(async () => { await Automerge.initializeWasm(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")) })

describe("DurableMesh peer catalog gossip", () => {
  it("Given Iroh has no route metadata, when Promise.any rejects, then it remains a network failure", () => {
    const unavailable = new AggregateError([new Error("No addressing information available")], "All promises were rejected")
    expect(isMeshDialNetworkFailure(unavailable)).toBe(true)
    expect(isMeshDialNetworkFailure(new AggregateError([new Error("Invalid write signature")], "All promises were rejected"))).toBe(false)
  })

  it("Given a peer without iroh gossip, when capabilities are checked, then the handshake fails closed", () => {
    expect(() => assertRequiredMeshCapabilities(["heartbeat-v1", "automerge-sync-v1"]))
      .toThrow("Peer does not support required iroh gossip")
    expect(() => assertRequiredMeshCapabilities(["heartbeat-v1", "iroh-gossip-v1"]))
      .not.toThrow()
  })

  it("Given stored mesh trust belongs to another transient identity, when startup filters credentials, then it preserves trust for recovery", async () => {
    const removeWorkspaceMeshData = vi.fn()
    const credential = {
      version: 1 as const, workspaceId: "workspace-1", ownerPersonId: "previous-person",
      ownerPublicKey: "previous-key", ownerCertificates: [], transportSecret: "mesh-secret",
      epoch: 1, updatedAt: new Date().toISOString(),
    }
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ identity: { personId: "current-person", publicKey: "current-key" } } as never),
      store: { removeWorkspaceMeshData, listWorkspaceCredentials: async () => [credential], listPeers: async () => [] } as never })

    await expect((mesh as any).activeCredentialsForProfile([credential],
      { identity: { personId: "current-person", publicKey: "current-key" } })).resolves.toEqual([])
    expect(removeWorkspaceMeshData).not.toHaveBeenCalled()
    await mesh.dispose()
  })

  it("explains a missing recovery policy separately from editor eligibility", async () => {
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ identity: { personId: "editor" } } as never),
      store: { getWorkspaceCredential: async () => ({ localGrant: { payload: { role: "editor" } } }) } as never })
    await expect(mesh.voteForSuccessor("workspace", "editor")).rejects.toThrow("The owner has not enabled ownership recovery")
    await mesh.dispose()
  })

  it("refuses to start ownership transfer to a peer without durable receipt support", async () => {
    const put = vi.fn()
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ identity: { personId: "owner" } } as never),
      store: { getWorkspaceCredential: async () => ({ ownerPersonId: "owner" }), putWorkspaceCredential: put,
        listPeers: async () => [{ personId: "target", deviceId: "target-device" }] } as never })
    ;(mesh as any).sessions.set("test", { workspaceId: "workspace", deviceId: "target-device" })
    await expect(mesh.transferOwnership("workspace", "target")).rejects.toThrow(/reload Match/i)
    expect(put).not.toHaveBeenCalled()
    ;(mesh as any).sessions.clear()
    await mesh.dispose()
  })
  it("does not report a cancelled losing route as an invalid peer or penalize its health", async () => {
    const onDiagnostic = vi.fn()
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({} as never), store: { listWorkspaceCredentials: async () => [], listPeers: async () => [] } as never, onDiagnostic })
    const controller = new AbortController(); controller.abort()
    ;(mesh as any).node = {}
    await expect((mesh as any).connectPeer({ workspaceId: "workspace", deviceId: "remote" }, {}, new AbortController().signal, controller.signal)).rejects.toThrow(/cancelled/)
    expect(onDiagnostic).not.toHaveBeenCalled()
    expect((mesh as any).routeFailures("workspace:remote")).toBe(0)
    ;(mesh as any).node = undefined
    await mesh.dispose()
  })

  it("Given an incoming session wins a dial race, when the losing outgoing route fails, then connected UI stays healthy", async () => {
    const onDiagnostic = vi.fn()
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({} as never),
      store: { listPeers: async () => [], listWorkspaceCredentials: async () => [] } as never, onDiagnostic })
    const internal = mesh as any
    const peer = {
      workspaceId: "workspace", personId: "remote-person", deviceId: "remote-device", instanceId: "legacy:remote",
      endpoint: "remote-endpoint", transportSecret: "secret", role: "editor", lastSeen: new Date().toISOString(),
      advertisement: { advertisement: { signerKeyId: "remote-device", signature: "signature", payload: {
        kind: "peer-advertisement", version: 1, workspaceId: "workspace", personId: "remote-person",
        deviceId: "remote-device", endpoint: "remote-endpoint", issuedAt: new Date().toISOString(),
      } } },
    }
    internal.node = {}
    internal.connectPeer = vi.fn(async () => {
      internal.runtime().admitSession({ key: { workspaceId: "workspace", deviceId: "remote-device", instanceId: "incoming" },
        connectionId: "incoming", remoteIssuedAt: new Date().toISOString(), direction: "incoming" }, "incoming")
      internal.sessions.set("workspace:remote-device:incoming", { workspaceId: "workspace", deviceId: "remote-device" })
      throw new Error("All promises were rejected")
    })

    await internal.dialDevice([peer], new AbortController().signal)

    expect(internal.hasDeviceSession("workspace", "remote-device")).toBe(true)
    expect(onDiagnostic).not.toHaveBeenCalled()
    internal.sessions.clear()
    internal.node = undefined
    await mesh.dispose()
  })

  it("Given every route reaches an offline device, when dialing exhausts network routes, then UI stays in reconnecting state", async () => {
    const onDiagnostic = vi.fn()
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({} as never),
      store: { listPeers: async () => [], listWorkspaceCredentials: async () => [] } as never, onDiagnostic })
    const internal = mesh as any
    const peer = {
      workspaceId: "workspace", personId: "remote-person", deviceId: "remote-device", instanceId: "legacy:remote",
      endpoint: "remote-endpoint", transportSecret: "secret", role: "editor", lastSeen: new Date().toISOString(),
      advertisement: { advertisement: { signerKeyId: "remote-device", signature: "signature", payload: {
        kind: "peer-advertisement", version: 1, workspaceId: "workspace", personId: "remote-person",
        deviceId: "remote-device", endpoint: "remote-endpoint", issuedAt: new Date().toISOString(),
      } } },
    }
    internal.node = {}
    internal.connectPeer = vi.fn(async () => { throw new MeshNetworkError("remote device offline") })

    await internal.dialDevice([peer], new AbortController().signal)

    expect(onDiagnostic).not.toHaveBeenCalled()
    internal.node = undefined
    await mesh.dispose()
  })

  it("Given simultaneous same-peer handshakes, when credentials load concurrently, then only one session owns the receive loop", async () => {
    const credential = { workspaceId: "workspace", transportSecret: "secret" }
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never,
      workspaceStore: { read: () => new Promise<Uint8Array>(() => {}) } as never,
      getProfile: async () => ({ device: { deviceId: "local" } } as never),
      store: { getWorkspaceCredential: async () => credential, listWorkspaceCredentials: async () => [], listPeers: async () => [] } as never })
    const connection = () => ({ acceptStream: vi.fn(() => new Promise<never>(() => {})), openStream: vi.fn(), close: vi.fn(async () => {}) })
    const first = connection(), second = connection()
    await Promise.all([first, second].map(value => (mesh as any).installSession("workspace", "remote", "slot-0", "2026-09-17", 1, "incoming", value)))
    expect(first.acceptStream.mock.calls.length + second.acceptStream.mock.calls.length).toBe(1)
    expect(first.close.mock.calls.length + second.close.mock.calls.length).toBe(1)
    await mesh.dispose()
  })

  it("Given chat changed while its mesh session was offline, when a replacement session becomes current, then it replays the local chat", async () => {
    const credential = { workspaceId: "workspace", transportSecret: "secret" }
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ device: { deviceId: "local" } } as never),
      store: { getWorkspaceCredential: async () => credential, listWorkspaceCredentials: async () => [], listPeers: async () => [] } as never })
    const internal = mesh as any
    const publish = vi.fn(async () => {})
    internal.lifecycle = { stopped: false }
    internal.createMeshSession = vi.fn(() => ({ incrementalEngine: undefined,
      session: { publish, close: async () => {}, done: new Promise<never>(() => {}) } }))
    const connection = { close: vi.fn(async () => {}), acceptStream: vi.fn(), openStream: vi.fn() }

    await internal.installSession("workspace", "remote", "slot-0", "2026-09-21", 1, "incoming", connection)
    await new Promise<void>(resolve => queueMicrotask(resolve))

    expect(publish).toHaveBeenCalledOnce()
    internal.lifecycle = undefined
    await mesh.dispose()
  })

  it("accepts independent sibling instances without replacing their connections or sharing Automerge state", async () => {
    const credential = { workspaceId: "workspace", transportSecret: "secret" }
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never,
      workspaceStore: { read: () => new Promise<Uint8Array>(() => {}) } as never,
      getProfile: async () => ({ device: { deviceId: "local" } } as never),
      store: { getWorkspaceCredential: async () => credential, listWorkspaceCredentials: async () => [], listPeers: async () => [] } as never })
    const connection = () => ({ acceptStream: vi.fn(() => new Promise<never>(() => {})), openStream: vi.fn(), close: vi.fn(async () => {}) })
    const first = connection(), sibling = connection()
    const internal = mesh as any
    await internal.installSession("workspace", "remote", "slot-0", "2026-09-17", 1, "incoming", first)
    expect(await internal.installSession("workspace", "remote", "slot-1", "2026-09-17", 99, "outgoing", sibling)).toBe(true)
    expect(first.close).not.toHaveBeenCalled()
    expect(sibling.close).not.toHaveBeenCalled()
    expect(internal.sessions.size).toBe(2)
    expect(internal.syncEngine("workspace", "remote", "local", "slot-0"))
      .not.toBe(internal.syncEngine("workspace", "remote", "local", "slot-1"))
    await internal.sessions.get("workspace:remote:slot-0").evict("remote closed")
    expect(internal.sessions.get("workspace:remote:slot-1").connection).toBe(sibling)
    expect(sibling.close).not.toHaveBeenCalled()
    await mesh.dispose()
  })

  it("Given a session whose receive loop hangs, when publish fails and a replacement connects, then stale cleanup cannot evict the replacement", async () => {
    let rejectSnapshot!: (error: Error) => void
    let resolveOldAccept!: (stream: never) => void
    let snapshot = new Promise<Uint8Array>((_resolve, reject) => { rejectSnapshot = reject })
    const changes: unknown[][] = []
    const credential = {
      workspaceId: "workspace-1", ownerPersonId: "owner", ownerPublicKey: "owner-key",
      ownerCertificates: [], transportSecret: "mesh-secret", epoch: 1, updatedAt: new Date().toISOString(),
    }
    const peer = {
      workspaceId: "workspace-1", personId: "remote-person", deviceId: "remote-device", role: "editor" as const,
      endpoint: "remote-endpoint", lastSeen: new Date().toISOString(),
    }
    const mesh = new DurableMesh({
      transport: {} as never,
      workspace: {} as never,
      workspaceStore: { read: () => snapshot } as never,
      getProfile: async () => ({ identity: { personId: "local-person" }, device: { deviceId: "local-device" } } as never),
      store: {
        getWorkspaceCredential: async () => credential,
        listWorkspaceCredentials: async () => [credential],
        listPeers: async () => [peer],
      } as never,
      onChange: (...args) => changes.push(args),
    })
    const oldConnection = {
      acceptStream: () => new Promise<never>(resolve => { resolveOldAccept = resolve }),
      openStream: vi.fn(),
      close: vi.fn(async () => {}),
    }
    const replacementConnection = {
      acceptStream: () => new Promise<never>(() => {}),
      openStream: vi.fn(async () => ({ send: async () => {}, closeSend: async () => {}, read: async () => new Uint8Array() })),
      close: vi.fn(async () => {}),
    }

    const internal = mesh as any
    await internal.installSession("workspace-1", "remote-device", "instance-1",
      "2026-09-16T09:00:00.000Z", 1, "incoming", oldConnection,
      false, false, "incoming-test", false, "", false, "remote-endpoint")
    expect(internal.sessions.size).toBe(1)
    const publish = internal.publishAll()
    rejectSnapshot(new Error("publish failed"))
    await publish
    await vi.waitFor(() => expect(internal.sessions.size).toBe(0))
    await expect(mesh.views("workspace-1")).resolves.toMatchObject([{ online: false }])

    snapshot = Promise.resolve(new Uint8Array([1]))
    await internal.installSession("workspace-1", "remote-device", "instance-1",
      "2026-09-16T09:00:00.000Z", 1, "incoming", replacementConnection,
      false, false, "incoming-replacement", false, "", false, "remote-endpoint")
    const replacement = internal.sessions.get("workspace-1:remote-device:instance-1").session
    resolveOldAccept(undefined as never)
    await Promise.resolve()
    await Promise.resolve()

    expect(internal.sessions.get("workspace-1:remote-device:instance-1").session).toBe(replacement)
    await expect(mesh.views("workspace-1")).resolves.toMatchObject([{ online: true }])
    expect(changes.length).toBeGreaterThan(0)
    await mesh.dispose()
  })

  it("Given a live session while Iroh gossip has no neighbour yet, when the workspace changes, then direct sync still publishes", async () => {
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({} as never), store: { listPeers: async () => [], listWorkspaceCredentials: async () => [] } as never })
    const internal = mesh as any
    const publish = vi.fn(async () => {})
    internal.sessions.set("workspace:remote:slot", {
      workspaceId: "workspace", deviceId: "remote", instanceId: "slot", endpoint: "remote-endpoint",
      session: { publish, close: async () => {}, done: new Promise<never>(() => {}) },
      evict: async () => {},
    })
    await internal.publishAll()

    expect(publish).toHaveBeenCalledOnce()
    await mesh.dispose()
  })

  it("Given simultaneous dials converge, when the same session arrives again, then only the preferred direction replaces its duplicate", () => {
    const current = { remoteIssuedAt: "2026-09-14T12:00:00.000Z", direction: "incoming" as const }

    expect(shouldReplaceMeshSession(current, { ...current }, "incoming")).toBe(false)
    expect(shouldReplaceMeshSession(current, { ...current, direction: "outgoing" }, "incoming")).toBe(false)
    expect(shouldReplaceMeshSession({ ...current, direction: "outgoing" }, current, "incoming")).toBe(true)
  })

  it("Given a renewed route for one instance, when both sessions arrive, then route sequence beats wall-clock skew", () => {
    const current = { remoteIssuedAt: "2026-09-14T12:05:00.000Z", remoteRouteSequence: 4, direction: "incoming" as const }
    const renewed = { remoteIssuedAt: "2026-09-14T12:00:00.000Z", remoteRouteSequence: 5, direction: "incoming" as const }

    expect(shouldReplaceMeshSession(current, renewed, "incoming")).toBe(true)
    expect(shouldReplaceMeshSession(renewed, current, "incoming")).toBe(false)
  })

  it("Given equal route sequence with skewed clocks, when duplicate sessions arrive, then time cannot replace the preferred direction", () => {
    const current = { remoteIssuedAt: "2026-09-14T12:00:00.000Z", remoteRouteSequence: 4, direction: "incoming" as const }
    const future = { ...current, remoteIssuedAt: "2099-09-14T12:00:00.000Z", direction: "outgoing" as const }

    expect(shouldReplaceMeshSession(current, future, "incoming")).toBe(false)
  })

  it("Given a newer browser instance closed, when an older live instance has no session, then it still dials the known peer", async () => {
    const controller = new AbortController()
    const own = {
      workspaceId: "workspace-1", personId: "local-person", deviceId: "local-device",
      instanceId: "slot-0", endpoint: "local-endpoint", transportSecret: "mesh-secret", role: "owner" as const,
      lastSeen: "2026-09-14T12:00:00.000Z",
      advertisement: { advertisement: { payload: { issuedAt: "2026-09-14T12:00:00.000Z" } } },
    }
    const peer = {
      workspaceId: "workspace-1", personId: "remote-person", deviceId: "remote-device",
      instanceId: "slot-1", endpoint: "remote-endpoint", transportSecret: "mesh-secret", role: "editor" as const,
      lastSeen: "2026-09-14T12:01:00.000Z",
      advertisement: { advertisement: { payload: { issuedAt: "2026-09-14T12:01:00.000Z" } } },
    }
    const mesh = new DurableMesh({
      transport: {} as never, workspaceStore: {} as never, workspace: {} as never,
      getProfile: async () => ({ device: { deviceId: "local-device" } } as never),
      store: {} as never,
    })
    const internal = mesh as any
    internal.node = {}
    internal.instanceId = "slot-0"
    internal.peerInstances = vi.fn(async (workspaceId?: string) => workspaceId ? [own, peer] : [peer])
    internal.dialDevice = vi.fn(async () => controller.abort())
    const guard = setTimeout(() => controller.abort(), 50)

    await internal.dialLoop(controller.signal)

    clearTimeout(guard)
    expect(internal.dialDevice).toHaveBeenCalledWith([peer], controller.signal)
    await mesh.dispose()
  })

  it("Given a signed route lease expired, when reconnect scans the catalog, then it keeps probing that bootstrap route", async () => {
    const controller = new AbortController()
    const peer = {
      workspaceId: "workspace-1", personId: "remote-person", deviceId: "remote-device",
      instanceId: "slot-1", endpoint: "remote-endpoint", transportSecret: "mesh-secret", role: "editor" as const,
      lastSeen: "2026-09-14T12:00:00.000Z",
      advertisement: { advertisement: { payload: { issuedAt: "2026-09-14T12:00:00.000Z",
        expiresAt: new Date(Date.now() - 60_000).toISOString() } } },
    }
    const mesh = new DurableMesh({
      transport: {} as never, workspaceStore: {} as never, workspace: {} as never,
      getProfile: async () => ({ device: { deviceId: "local-device" } } as never), store: {} as never,
    })
    const internal = mesh as any
    internal.node = {}
    internal.peerInstances = vi.fn(async () => [peer])
    internal.dialDevice = vi.fn(async () => controller.abort())
    const guard = setTimeout(() => controller.abort(), 50)

    await internal.dialLoop(controller.signal)

    clearTimeout(guard)
    expect(internal.dialDevice).toHaveBeenCalledWith([peer], controller.signal)
    expect(internal.peerInstances).toHaveBeenCalled()
    await mesh.dispose()
  })

  it("Given two different same-epoch recovery claims, when projected, then conflict pauses automatic recovery", async () => {
    const policy = { payload: { successorPersonId: null, eligibleEditorPersonIds: ["editor-a", "editor-b"] } }
    const credential = {
      version: 1 as const, workspaceId: "workspace-conflict", ownerPersonId: "editor-a", ownerPublicKey: "key-a",
      ownerCertificates: [], transportSecret: "mesh-secret", epoch: 2, updatedAt: new Date().toISOString(),
      catalog: { successionClaims: [
        { signature: "claim-a", payload: { epoch: 2, toOwnerPersonId: "editor-a", policy } },
        { signature: "claim-b", payload: { epoch: 2, toOwnerPersonId: "editor-b", policy } },
      ] },
    }
    const mesh = new DurableMesh({
      transport: {} as never, workspaceStore: {} as never, workspace: {} as never,
      getProfile: async () => ({} as never),
      store: { listWorkspaceCredentials: async () => [credential] } as never,
    })

    await expect(mesh.successionViews()).resolves.toMatchObject([{ workspaceId: "workspace-conflict", conflicted: true }])
    await mesh.dispose()
  })

  it("Given an owner signs two successors for one epoch, when replicas meet, then authority stays put and writes freeze", async () => {
    resetIdentityStorageForTest()
    const owner = await bootstrapIdentity("Owner")
    resetIdentityStorageForTest()
    const first = await bootstrapIdentity("First successor")
    resetIdentityStorageForTest()
    const second = await bootstrapIdentity("Second successor")
    const transfers = await Promise.all([first, second].map(target => createWorkspaceOwnershipTransfer(owner, "workspace-1", {
      personId: target.identity.personId, publicKey: target.identity.publicKey, certificates: [target.certificate],
    }, ["head"], 2)))
    let credential = {
      version: 1 as const, workspaceId: "workspace-1", ownerPersonId: owner.identity.personId,
      ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: "secret",
      epoch: 1, updatedAt: new Date().toISOString(), catalog: {},
    }
    const store = {
      putWorkspaceCredential: async (next: typeof credential) => { credential = structuredClone(next) },
      transferWorkspaceCredential: async (_previous: string, next: typeof credential) => { credential = structuredClone(next) },
      listPeers: async () => [],
      listWorkspaceCredentials: async () => [credential],
    }
    const mesh = new DurableMesh({ transport: {} as never, workspaceStore: {} as never, workspace: {} as never,
      getProfile: async () => owner, store: store as never })

    const result = await (mesh as any).mergeOwnershipTransfers(credential, transfers)

    expect(result.ownerPersonId).toBe(owner.identity.personId)
    expect(result.epoch).toBe(1)
    expect((result.catalog as any).ownershipTransfers).toHaveLength(2)
    await expect(mesh.successionViews()).resolves.toMatchObject([{ workspaceId: "workspace-1", conflicted: true }])
    await mesh.dispose()
  })

  it("Given an existing editor peer, when it receives a valid break-glass claim, then it adopts the new owner and keeps its own grant", async () => {
    resetIdentityStorageForTest()
    const owner = await bootstrapIdentity("Offline owner")
    resetIdentityStorageForTest()
    const recovering = await bootstrapIdentity("Recovering editor")
    resetIdentityStorageForTest()
    const receiver = await bootstrapIdentity("Existing editor")
    const recoveringGrant = await createWorkspaceGrant(owner, "workspace-1", recovering.identity.personId, "editor")
    const receiverGrant = await createWorkspaceGrant(owner, "workspace-1", receiver.identity.personId, "editor")
    const claim = await createWorkspaceBreakGlassClaim(recovering, "workspace-1", owner.identity.personId,
      recoveringGrant, ["head"], 2)
    let credential: any = {
      version: 1, workspaceId: "workspace-1", ownerPersonId: owner.identity.personId,
      ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: "secret",
      localGrant: receiverGrant, epoch: 1, updatedAt: new Date(0).toISOString(), catalog: {},
    }
    const store = {
      putWorkspaceCredential: async (next: any) => { credential = structuredClone(next) },
      transferWorkspaceCredential: async (_previous: string, next: any) => { credential = structuredClone(next) },
      listPeers: async () => [], listWorkspaceCredentials: async () => [credential],
    }
    const mesh = new DurableMesh({ transport: {} as never, workspaceStore: {} as never, workspace: {} as never,
      getProfile: async () => receiver, store: store as never })

    await (mesh as any).mergeBreakGlassClaims(credential, [claim])

    expect(credential.ownerPersonId).toBe(recovering.identity.personId)
    expect(credential.epoch).toBe(2)
    expect(credential.localGrant.signature).toBe(receiverGrant.signature)
    expect(credential.catalog.breakGlassClaims).toEqual([claim])
    await mesh.dispose()
  })

  it("Given an older client adopted the recovery epoch without its proof, when the signed claim arrives, then it retains the claim for historical writes", async () => {
    resetIdentityStorageForTest()
    const returningOwner = await bootstrapIdentity("Returning owner")
    resetIdentityStorageForTest()
    const previousOwner = await bootstrapIdentity("Previous owner")
    const editorGrant = await createWorkspaceGrant(returningOwner, "workspace-1", returningOwner.identity.personId, "editor")
    const claim = await createWorkspaceBreakGlassClaim(returningOwner, "workspace-1", previousOwner.identity.personId,
      editorGrant, ["head"], 3)
    let credential: any = {
      version: 1, workspaceId: "workspace-1", ownerPersonId: returningOwner.identity.personId,
      ownerPublicKey: returningOwner.identity.publicKey, ownerCertificates: [returningOwner.certificate],
      ownerHistory: [
        { personId: returningOwner.identity.personId, publicKey: returningOwner.identity.publicKey,
          certificates: [returningOwner.certificate] },
        { personId: previousOwner.identity.personId, publicKey: previousOwner.identity.publicKey,
          certificates: [previousOwner.certificate] },
      ],
      transportSecret: "secret", epoch: 3, updatedAt: new Date(0).toISOString(), catalog: {},
    }
    const store = {
      putWorkspaceCredential: async (next: any) => { credential = structuredClone(next) },
      transferWorkspaceCredential: async (_previous: string, next: any) => { credential = structuredClone(next) },
      listPeers: async () => [], listWorkspaceCredentials: async () => [credential],
    }
    const mesh = new DurableMesh({ transport: {} as never, workspaceStore: {} as never, workspace: {} as never,
      getProfile: async () => previousOwner, store: store as never })

    await (mesh as any).mergeBreakGlassClaims(credential, [claim])

    expect(credential.ownerPersonId).toBe(returningOwner.identity.personId)
    expect(credential.epoch).toBe(3)
    expect(credential.catalog.breakGlassClaims).toEqual([claim])
    await mesh.dispose()
  })

  it("Given production stored the first local-only recovery record, when the new protocol starts, then it upgrades that record for peer verification", async () => {
    resetIdentityStorageForTest()
    const owner = await bootstrapIdentity("Offline owner")
    resetIdentityStorageForTest()
    const recovering = await bootstrapIdentity("Recovering editor")
    const grant = await createWorkspaceGrant(owner, "workspace-1", recovering.identity.personId, "editor")
    const claimedAt = new Date().toISOString()
    const signed = await signEnvelope(recovering.privateKeys.devicePrivateKey, {
      kind: "workspace-break-glass" as const, version: 1 as const, workspaceId: "workspace-1",
      fromOwnerPersonId: owner.identity.personId, toOwnerPersonId: recovering.identity.personId,
      epoch: 2, claimedAt,
    }, recovering.device.deviceId)
    let credential: any = {
      version: 1, workspaceId: "workspace-1", ownerPersonId: recovering.identity.personId,
      ownerPublicKey: recovering.identity.publicKey, ownerCertificates: [recovering.certificate],
      ownerHistory: [{ personId: owner.identity.personId, publicKey: owner.identity.publicKey, certificates: [owner.certificate] }],
      transportSecret: "secret", epoch: 2, updatedAt: claimedAt,
      catalog: { breakGlassClaims: [{ signed, grant, certificates: [recovering.certificate] }] },
    }
    const doc = Automerge.from({ id: "workspace-1", ownerPersonId: owner.identity.personId })
    const store = { putWorkspaceCredential: async (next: any) => { credential = structuredClone(next) } }
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never,
      workspaceStore: { read: async () => Automerge.save(doc) } as never,
      getProfile: async () => recovering, store: store as never })

    await (mesh as any).migrateLegacyBreakGlassClaim(credential, recovering)

    expect(credential.catalog.breakGlassClaims).toHaveLength(1)
    expect(credential.catalog.breakGlassClaims[0].payload.toOwnerPublicKey).toBe(recovering.identity.publicKey)
    expect(credential.catalog.breakGlassClaims[0].payload.editorGrant.signature).toBe(grant.signature)
    Automerge.free(doc)
    await mesh.dispose()
  })

  it("Given partitioned replicas accepted different successors, when their transfer logs meet, then neither authority replaces the other", async () => {
    resetIdentityStorageForTest()
    const owner = await bootstrapIdentity("Owner")
    resetIdentityStorageForTest()
    const first = await bootstrapIdentity("First successor")
    resetIdentityStorageForTest()
    const second = await bootstrapIdentity("Second successor")
    const [toFirst, toSecond] = await Promise.all([first, second].map(target => createWorkspaceOwnershipTransfer(owner, "workspace-1", {
      personId: target.identity.personId, publicKey: target.identity.publicKey, certificates: [target.certificate],
    }, ["shared-head"], 2)))
    const initial = {
      version: 1 as const, workspaceId: "workspace-1", ownerPersonId: owner.identity.personId,
      ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: "secret",
      epoch: 1, updatedAt: new Date(0).toISOString(), catalog: {},
    }
    const replica = (profile: LocalProfile) => {
      let credential: any = structuredClone(initial)
      const store = {
        putWorkspaceCredential: async (next: any) => { credential = structuredClone(next) },
        transferWorkspaceCredential: async (_previous: string, next: any) => { credential = structuredClone(next) },
        listPeers: async () => [], listWorkspaceCredentials: async () => [credential],
      }
      const mesh = new DurableMesh({ transport: {} as never, workspaceStore: {} as never, workspace: {} as never,
        getProfile: async () => profile, store: store as never })
      return { mesh, credential: () => credential }
    }
    const a = replica(first)
    const b = replica(second)

    await (a.mesh as any).mergeOwnershipTransfers(a.credential(), [toFirst])
    await (b.mesh as any).mergeOwnershipTransfers(b.credential(), [toSecond])
    expect(a.credential().ownerPersonId).toBe(first.identity.personId)
    expect(b.credential().ownerPersonId).toBe(second.identity.personId)

    await (a.mesh as any).mergeOwnershipTransfers(a.credential(), [toSecond])
    await (b.mesh as any).mergeOwnershipTransfers(b.credential(), [toFirst])

    expect(a.credential().ownerPersonId).toBe(first.identity.personId)
    expect(b.credential().ownerPersonId).toBe(second.identity.personId)
    expect(a.credential().catalog.ownershipTransfers).toHaveLength(2)
    expect(b.credential().catalog.ownershipTransfers).toHaveLength(2)
    await expect(a.mesh.successionViews()).resolves.toMatchObject([{ conflicted: true }])
    await expect(b.mesh.successionViews()).resolves.toMatchObject([{ conflicted: true }])
    await Promise.all([a.mesh.dispose(), b.mesh.dispose()])
  })

  it("Given a stored peer with an invalid grant, when the mesh validates its catalog, then it removes the poisoned peer before dialing", async () => {
    const removed: string[] = []
    const credential = {
      version: 1 as const,
      workspaceId: "workspace-1",
      ownerPersonId: "owner-person",
      ownerPublicKey: "owner-key",
      ownerCertificates: [],
      transportSecret: "mesh-secret",
      epoch: 1,
      updatedAt: new Date().toISOString(),
    }
    const store = {
      listPeers: async () => [{
        workspaceId: "workspace-1", personId: "stale-person", deviceId: "stale-device",
        endpoint: "stale-endpoint", transportSecret: "mesh-secret", role: "editor" as const,
        lastSeen: new Date().toISOString(), advertisement: { poisoned: true },
      }],
      removePeer: async (workspaceId: string, deviceId: string) => { removed.push(`${workspaceId}:${deviceId}`); return true },
    }
    const mesh = new DurableMesh({
      transport: {} as never,
      workspaceStore: {} as never,
      workspace: {} as never,
      getProfile: async () => ({ device: { deviceId: "local-device" } } as never),
      store: store as never,
    })

    await (mesh as any).pruneInvalidStoredPeers(credential, "local-device")

    expect(removed).toEqual(["workspace-1:stale-device"])
    await mesh.dispose()
  })

  it("Given this device changed identity, when its own advertisement refreshes, then the stale record is replaced instead of merged", async () => {
    resetIdentityStorageForTest()
    const owner = await bootstrapIdentity("Owner")
    const removed: string[] = []
    const saved: any[] = []
    const credential = {
      version: 1 as const,
      workspaceId: "workspace-1",
      ownerPersonId: owner.identity.personId,
      ownerPublicKey: owner.identity.publicKey,
      ownerCertificates: [owner.certificate],
      transportSecret: "mesh-secret",
      epoch: 1,
      updatedAt: new Date().toISOString(),
    }
    const store = {
      getPeer: async () => ({
        workspaceId: "workspace-1", personId: "previous-person", deviceId: owner.device.deviceId,
        endpoint: "old-endpoint", transportSecret: "mesh-secret", role: "visitor" as const,
        lastSeen: new Date(Date.now() + 60_000).toISOString(), advertisement: { stale: true },
      }),
      removePeer: async (workspaceId: string, deviceId: string) => { removed.push(`${workspaceId}:${deviceId}`); return true },
      upsertPeer: async (peer: any) => { saved.push(peer); return peer },
      putWorkspaceCredential: async () => {},
    }
    const mesh = new DurableMesh({
      transport: {} as never,
      workspaceStore: {} as never,
      workspace: {} as never,
      getProfile: async () => owner,
      store: store as never,
    })

    await (mesh as any).refreshOwnBundle(credential, owner, "new-endpoint", [owner.certificate])

    expect(removed).toEqual([`workspace-1:${owner.device.deviceId}`])
    expect(saved.at(-1)?.personId).toBe(owner.identity.personId)
    expect(saved.at(-1)?.endpoint).toBe("new-endpoint")
    await mesh.dispose()
  })

  it("Given a workspace guest enrolls as an owner device, when enrollment is approved, then its old peer aliases are removed", async () => {
    const removed: string[] = []
    const closed: string[] = []
    const mesh = new DurableMesh({
      transport: {} as never,
      workspaceStore: {} as never,
      workspace: {} as never,
      getProfile: async () => ({} as never),
      store: {
        removePeer: async (workspaceId: string, deviceId: string) => {
          removed.push(`${workspaceId}:${deviceId}`)
          return true
        },
      } as never,
    })
    const internal = mesh as any
    const sessionKey = "workspace-1:guest-device"
    internal.sessions.set(sessionKey, {
      workspaceId: "workspace-1",
      deviceId: "guest-device",
      session: { close: async () => { closed.push("session") } },
      connection: { close: async () => { closed.push("connection") } },
      evict: async () => {
        internal.sessions.delete(sessionKey)
        closed.push("session", "connection")
      },
    })
    internal.runtime().beginRouteAttempt("workspace-1:guest-device", Date.now())
    internal.runtime().scheduleReconnect("workspace-1:guest-device", Date.now(), 5_000, 5 * 60_000)

    await mesh.forgetEnrolledDevice(["workspace-1", "workspace-1", "workspace-2"], "guest-device")

    expect(removed).toEqual(["workspace-1:guest-device", "workspace-2:guest-device"])
    expect(closed).toEqual(["session", "connection"])
    expect(internal.sessions.has("workspace-1:guest-device")).toBe(false)
    expect(internal.runtime().routeAttemptActive("workspace-1:guest-device")).toBe(false)
    expect(internal.runtime().reconnectState("workspace-1:guest-device")).toBeNull()
    await mesh.dispose()
  })

  it("Given one invalid peer record, when a catalog merges, then later valid peers still import", async () => {
    const credential = { workspaceId: "workspace-1" }
    const mesh = new DurableMesh({
      transport: {} as never,
      workspaceStore: {} as never,
      workspace: {} as never,
      getProfile: async () => ({} as never),
      store: { getWorkspaceCredential: async () => credential } as never,
    })
    const imported: string[] = []
    const internal = mesh as any
    internal.mergeOwnershipTransfers = async () => credential
    internal.mergeRevocations = async () => {}
    internal.putVerifiedBundle = vi.fn(async (_credential: unknown, bundle: { id: string }) => {
      if (bundle.id === "poisoned") throw new Error("Invalid workspace grant signature")
      imported.push(bundle.id)
    })
    internal.notify = async () => {}

    await mesh.mergeWorkspace("workspace-1", {
      version: 1,
      peers: [{ id: "poisoned" }, { id: "owner-phone" }],
      revocations: [],
    })

    expect(imported).toEqual(["owner-phone"])
    await mesh.dispose()
  })

  it("Given an enrolled owner device, when it opens an existing workspace, then its certificate can verify new grants", async () => {
    resetIdentityStorageForTest()
    const owner = await bootstrapIdentity("Owner")
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair
    const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)))
    const deviceId = await sha256Base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)))
    const certificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
      owner.identity.personId, deviceId, publicKey, await certHashDefault(owner.certificate))
    const enrolledOwner: LocalProfile = {
      identity: owner.identity,
      device: { deviceId, publicKey, displayName: "Owner phone" },
      certificate,
      privateKeys: { devicePrivateKey: keyPair.privateKey },
    }
    let credential = {
      version: 1 as const,
      workspaceId: "workspace-1",
      ownerPersonId: owner.identity.personId,
      ownerPublicKey: owner.identity.publicKey,
      ownerCertificates: [owner.certificate],
      transportSecret: "mesh-secret",
      epoch: 1,
      updatedAt: new Date(0).toISOString(),
      localGrant: { stale: true },
    }
    const store = {
      getWorkspaceCredential: async () => structuredClone(credential),
      putWorkspaceCredential: async (next: typeof credential) => { credential = structuredClone(next) },
      getPeer: async () => null,
    }
    const mesh = new DurableMesh({
      transport: {} as never,
      workspaceStore: {} as never,
      workspace: {} as never,
      getProfile: async () => enrolledOwner,
      store: store as never,
    })
    const internal = mesh as any
    internal.putVerifiedBundle = vi.fn(async () => {})
    internal.notify = vi.fn(async () => {})

    await mesh.ensureOwnerWorkspaces(["workspace-1"], "owner-phone-endpoint", enrolledOwner)
    const grant = await createWorkspaceGrant(enrolledOwner, "workspace-1", "editor-person", "editor")

    await expect(verifyWorkspaceGrant(grant, {
      workspaceId: "workspace-1",
      personId: "editor-person",
      ownerPersonId: owner.identity.personId,
      ownerPublicKey: owner.identity.publicKey,
      ownerCertificates: credential.ownerCertificates,
    })).resolves.toBe("editor")
    expect(credential.ownerCertificates.map(item => item.payload.deviceId)).toContain(deviceId)
    expect("localGrant" in credential).toBe(false)
    await mesh.dispose()
  })
})
