import { describe, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, sha256Base64Url, toBase64Url, type LocalProfile } from "../domain/identity"
import { certHashDefault, createDelegatedCertificate, createWorkspaceGrant } from "../domain/proofs"
import { createWorkspaceOwnershipTransfer, verifyWorkspaceGrant } from "./meshRecords"
import { DurableMesh, shouldReplaceMeshSession } from "./durableMesh"

describe("DurableMesh peer catalog gossip", () => {
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
    internal.dialPeer = vi.fn(async () => controller.abort())
    const guard = setTimeout(() => controller.abort(), 50)

    await internal.dialLoop(controller.signal)

    clearTimeout(guard)
    expect(internal.dialPeer).toHaveBeenCalledWith(peer, controller.signal)
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
    internal.dialPeer = vi.fn(async () => controller.abort())
    const guard = setTimeout(() => controller.abort(), 50)

    await internal.dialLoop(controller.signal)

    clearTimeout(guard)
    expect(internal.dialPeer).toHaveBeenCalledWith(peer, controller.signal)
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
    internal.sessions.set("workspace-1:guest-device", {
      workspaceId: "workspace-1",
      deviceId: "guest-device",
      session: { close: async () => { closed.push("session") } },
      connection: { close: async () => { closed.push("connection") } },
    })
    internal.connecting.add("workspace-1:guest-device")
    internal.failures.set("workspace-1:guest-device", 2)
    internal.failedAt.set("workspace-1:guest-device", Date.now())

    await mesh.forgetEnrolledDevice(["workspace-1", "workspace-1", "workspace-2"], "guest-device")

    expect(removed).toEqual(["workspace-1:guest-device", "workspace-2:guest-device"])
    expect(closed).toEqual(["session", "connection"])
    expect(internal.sessions.has("workspace-1:guest-device")).toBe(false)
    expect(internal.connecting.has("workspace-1:guest-device")).toBe(false)
    expect(internal.failures.has("workspace-1:guest-device")).toBe(false)
    expect(internal.failedAt.has("workspace-1:guest-device")).toBe(false)
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
