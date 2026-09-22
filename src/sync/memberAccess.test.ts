import { beforeEach, describe, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createWorkspaceGrant } from "../domain/proofs"
import { createWorkspaceDeparture, verifyWorkspaceDeparture, createPeerAdvertisement, createWorkspaceDeviceRevocation, verifyWorkspaceDeviceRevocation } from "./meshRecords"
import { DurableMesh } from "./durableMesh"
import { hasLeftWorkspace, isDeviceRevoked } from "./durableMeshBase"
import { mergePeerRecords } from "@meta-uber/mesh-peer-store"

beforeEach(() => resetIdentityStorageForTest())
async function identity(name: string) { resetIdentityStorageForTest(); return bootstrapIdentity(name) }
async function fixture() {
  const owner = await identity("Owner"), visitor = await identity("Visitor")
  const grant = await createWorkspaceGrant(owner, "board", visitor.identity.personId, "visitor")
  const bundle = await createPeerAdvertisement(visitor, { workspaceId: "board", endpoint: "endpoint", grant,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate] })
  let credential: any = { version: 1, workspaceId: "board", ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: "secret", epoch: 1,
    updatedAt: new Date().toISOString() }
  let peer: any = { workspaceId: "board", personId: visitor.identity.personId, deviceId: visitor.device.deviceId,
    role: "visitor", endpoint: "endpoint", transportSecret: "secret", lastSeen: bundle.advertisement.payload.issuedAt, advertisement: bundle }
  const store: any = { getPeer: async () => peer, listPeers: async () => [peer],
    getWorkspaceCredential: async () => credential, listWorkspaceCredentials: async () => [credential],
    putWorkspaceCredential: async (value: any) => { credential = value },
    upsertPeer: async (value: any) => { peer = mergePeerRecords(peer, value); return peer } }
  const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
    store, getProfile: async () => owner })
  vi.spyOn(mesh as any, "notify").mockResolvedValue(undefined)
  vi.spyOn(mesh as any, "publishAll").mockResolvedValue(undefined)
  return { mesh, owner, visitor, bundle, store, credential: () => credential, peer: () => peer }
}

describe("member access", () => {
  it("promotes a visitor with a signed owner grant and preserves promotion on a stale announcement", async () => {
    const f = await fixture()
    await f.mesh.promotePerson("board", f.visitor.identity.personId)
    expect(f.peer().role).toBe("editor")
    expect(f.peer().advertisement.grant.payload.role).toBe("editor")
    await (f.mesh as any).putVerifiedBundle(f.credential(), f.bundle)
    expect(f.peer().role).toBe("editor")
    await f.mesh.dispose()
  })
  it("removes only the chosen device and refuses its old signed advertisement on reconnect", async () => {
    const f = await fixture()
    await f.mesh.removeDevice(f.visitor.identity.personId, f.visitor.device.deviceId, ["board"])
    expect(isDeviceRevoked(f.credential(), f.visitor.identity.personId, f.visitor.device.deviceId)).toBe(true)
    expect(isDeviceRevoked(f.credential(), f.visitor.identity.personId, "another-device")).toBe(false)
    await expect((f.mesh as any).putVerifiedBundle(f.credential(), f.bundle)).rejects.toThrow("Device access revoked")
    await f.mesh.dispose()
  })
  it("refuses expanding confirmed removal to an unauthorized workspace before writing", async () => {
    const f = await fixture()
    await expect(f.mesh.removeDevice(f.visitor.identity.personId, f.visitor.device.deviceId, ["board", "someone-elses-board"]))
      .rejects.toThrow("scope is no longer authorized")
    expect(isDeviceRevoked(f.credential(), f.visitor.identity.personId, f.visitor.device.deviceId)).toBe(false)
    await f.mesh.dispose()
  })
  it("accepts a self-issued device removal but rejects a stranger, a changed scope, or a forged signature", async () => {
    const owner = await identity("Owner"), member = await identity("Member"), stranger = await identity("Stranger")
    const removal = await createWorkspaceDeviceRevocation(member, "board", member.identity.personId, "old-device", [member.certificate])
    expect(verifyWorkspaceDeviceRevocation(removal, "board", owner.identity.personId)).toEqual(removal)
    expect(() => verifyWorkspaceDeviceRevocation(removal, "other-board", owner.identity.personId)).toThrow()
    const unauthorized = await createWorkspaceDeviceRevocation(stranger, "board", member.identity.personId, "old-device", [stranger.certificate])
    expect(() => verifyWorkspaceDeviceRevocation(unauthorized, "board", owner.identity.personId)).toThrow()
    const forged = structuredClone(removal)
    forged.record.payload.deviceId = "another-device"
    expect(() => verifyWorkspaceDeviceRevocation(forged, "board", owner.identity.personId)).toThrow()
  })
})

describe("leaving membership", () => {
  it("requires the owner to transfer ownership before leaving", async () => {
    const f = await fixture()
    await expect(f.mesh.leaveWorkspace("board")).rejects.toThrow("Transfer ownership")
    expect(f.credential().ownerPersonId).toBe(f.owner.identity.personId)
    await f.mesh.dispose()
  })
})

  it("a signed departure removes person membership until a newer owner-approved grant", async () => {
    const f = await fixture()
    const departure = await createWorkspaceDeparture(f.visitor, "board", 1, [f.visitor.certificate])
    expect(verifyWorkspaceDeparture(departure, "board")).toEqual(departure)
    await (f.mesh as any).mergeDepartures(f.credential(), [departure])
    expect(hasLeftWorkspace(f.credential(), f.visitor.identity.personId, f.bundle.grant)).toBe(true)
    await expect((f.mesh as any).putVerifiedBundle(f.credential(), f.bundle)).rejects.toThrow("Workspace member is revoked")
    const renewed = await createWorkspaceGrant(f.owner, "board", f.visitor.identity.personId, "editor", 2)
    await (f.mesh as any).putVerifiedBundle(f.credential(), { ...f.bundle, grant: renewed })
    expect(hasLeftWorkspace(f.credential(), f.visitor.identity.personId, renewed)).toBe(false)
    const forged = structuredClone(departure)
    forged.record.payload.personId = f.owner.identity.personId
    expect(() => verifyWorkspaceDeparture(forged, "board")).toThrow()
    await f.mesh.dispose()
  })

  it("requires removal-aware peers before accepting a session, even before the first removal", async () => {
    const f = await fixture()
    await expect((f.mesh as any).mergeIncomingAuthority(f.credential(), { capabilities: ["iroh-gossip-v1"] }))
      .rejects.toThrow("Reload Match to support device removals")
    expect(f.credential().catalog).toBeUndefined()
    await f.mesh.dispose()
  })

it("limits removal of another person's device to owned boards, while own devices include editor boards", async () => {
  const f = await fixture()
  const otherOwner = await identity("Another owner")
  const editorGrant = await createWorkspaceGrant(otherOwner, "third", f.owner.identity.personId, "editor")
  const credentials = [f.credential(), { ...f.credential(), workspaceId: "second" }, {
    ...f.credential(), workspaceId: "third", ownerPersonId: otherOwner.identity.personId,
    ownerPublicKey: otherOwner.identity.publicKey, ownerCertificates: [otherOwner.certificate], localGrant: editorGrant,
  }]
  f.store.listWorkspaceCredentials = async () => credentials
  f.store.getPeer = async (workspaceId: string) => ({ ...f.peer(), workspaceId })
  expect(await f.mesh.removableDeviceWorkspaces(f.visitor.identity.personId, f.visitor.device.deviceId)).toEqual(["board", "second"])
  f.store.getPeer = async (workspaceId: string) => ({ ...f.peer(), workspaceId, personId: f.owner.identity.personId })
  expect(await f.mesh.removableDeviceWorkspaces(f.owner.identity.personId, f.visitor.device.deviceId)).toEqual(["board", "second", "third"])
  await f.mesh.dispose()
})

it("retains removals for both identities when the same device key was enrolled into another person", async () => {
  const f = await fixture()
  const first = await createWorkspaceDeviceRevocation(f.owner, "board", f.visitor.identity.personId, f.visitor.device.deviceId, [f.owner.certificate])
  const second = await createWorkspaceDeviceRevocation(f.owner, "board", "another-person", f.visitor.device.deviceId, [f.owner.certificate])
  await (f.mesh as any).mergeDeviceRevocations(f.credential(), [first, second])
  expect(isDeviceRevoked(f.credential(), f.visitor.identity.personId, f.visitor.device.deviceId)).toBe(true)
  expect(isDeviceRevoked(f.credential(), "another-person", f.visitor.device.deviceId)).toBe(true)
  await f.mesh.dispose()
})
