import { beforeEach, describe, expect, it, vi } from "vitest"
import { bootstrapIdentity, clearInMemoryProfileForReloadTest, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault } from "../domain/proofs"
import { InvitationService, resetInvitationStorageForTest } from "./invitations"
import { createDeviceEnrollmentInvite } from "./protocol"
import { createEnrollmentRequest, enrollmentPayload, installEnrollment, readEnrollmentRequest } from "./enrollment"
import { defaultStorage } from "../storage"
import { verifyDeviceChain } from "./meshRecords"

vi.mock("../storage", () => ({ defaultStorage: { savePersonalRoot: vi.fn(async () => {}) } }))

async function fixture() {
  const owner = await bootstrapIdentity("Owner")
  resetIdentityStorageForTest()
  const guest = await bootstrapIdentity("New device")
  const service = new InvitationService()
  const invite = createDeviceEnrollmentInvite("endpoint", "secret", owner)
  await service.saveIssuedInvitation(invite)
  await service.claimInvitation(invite.invitationId, guest.device.deviceId)
  const result = await service.approveEnrollment(invite.invitationId, guest.device, owner)
  if (!result.ok) throw new Error(result.error)
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  const bytes = await enrollmentPayload(invite, owner, result.certificate, root, [{ id: "ws", title: "Board" }],
    [{ workspaceId: "ws", ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey, optionalMeshField: undefined }], new TextEncoder().encode("[]"))
  return { owner, guest, service, invite, bytes, certificate: result.certificate }
}

beforeEach(() => { resetIdentityStorageForTest(); resetInvitationStorageForTest() })

describe("device enrollment boundary", () => {
  it("requires possession of the requested device key and binds requests to an invitation", async () => {
    const { guest, invite } = await fixture()
    const bytes = await createEnrollmentRequest(invite, guest)
    expect((await readEnrollmentRequest(bytes, invite)).deviceId).toBe(guest.device.deviceId)
    await expect(readEnrollmentRequest(bytes, { ...invite, invitationId: "different" })).rejects.toThrow("Invalid")
    const forged = JSON.parse(new TextDecoder().decode(bytes))
    forged.payload.displayName = "Forged"
    await expect(readEnrollmentRequest(new TextEncoder().encode(JSON.stringify(forged)), invite)).rejects.toThrow("Invalid")
  })

  it("persists the approved identity and device certificate without copying a root private key", async () => {
    const { owner, guest, invite, bytes } = await fixture()
    await installEnrollment(bytes, invite, guest)
    clearInMemoryProfileForReloadTest()
    const restored = await bootstrapIdentity()
    expect(restored.identity.personId).toBe(owner.identity.personId)
    expect(restored.device.deviceId).toBe(guest.device.deviceId)
    expect(restored.privateKeys.identityPrivateKey).toBeUndefined()
    expect(await verifyDeviceChain({ personId: owner.identity.personId, publicKey: owner.identity.publicKey,
      deviceId: guest.device.deviceId, certificates: [restored.certificate] })).toBe(guest.device.publicKey)
  })

  it("rejects forged or replayed approvals before changing local identity", async () => {
    const { guest, invite, bytes } = await fixture()
    await expect(installEnrollment(bytes, { ...invite, invitationId: "different" }, guest)).rejects.toThrow("Invalid")
    const raw = JSON.parse(new TextDecoder().decode(bytes))
    raw.payload.personalRoot.identity.displayName = "Forged owner"
    await expect(installEnrollment(new TextEncoder().encode(JSON.stringify(raw)), invite, guest)).rejects.toThrow("Invalid")
    expect((await bootstrapIdentity()).identity.personId).toBe(guest.identity.personId)
  })

  it("keeps the current identity when approval cannot be saved", async () => {
    const { guest, invite, bytes } = await fixture()
    vi.mocked(defaultStorage.savePersonalRoot).mockRejectedValueOnce(new Error("Storage full"))
    await expect(installEnrollment(bytes, invite, guest)).rejects.toThrow("Storage full")
    expect((await bootstrapIdentity()).identity.personId).toBe(guest.identity.personId)
  })

  it("lets an enrolled device issue a verifiable delegated certificate for another device", async () => {
    const { owner, guest, invite, bytes, service } = await fixture()
    const enrolled = await installEnrollment(bytes, invite, guest)
    resetIdentityStorageForTest()
    const third = await bootstrapIdentity("Third device")
    const thirdInvite = createDeviceEnrollmentInvite("second-endpoint", "another-secret", enrolled.profile)
    await service.saveIssuedInvitation(thirdInvite)
    await service.claimInvitation(thirdInvite.invitationId, third.device.deviceId)
    const result = await service.approveEnrollment(thirdInvite.invitationId, third.device, enrolled.profile)
    if (!result.ok) throw new Error(result.error)
    expect(result.certificate.payload.issuerCertificateHash).toBe(await certHashDefault(enrolled.certificate))
    expect(await verifyDeviceChain({ personId: owner.identity.personId, publicKey: owner.identity.publicKey,
      deviceId: third.device.deviceId, certificates: [result.certificate, enrolled.certificate] })).toBe(third.device.publicKey)
    expect((await service.approveEnrollment(thirdInvite.invitationId, third.device, enrolled.profile)).ok).toBe(false)
  })
})
