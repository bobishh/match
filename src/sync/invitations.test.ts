import { describe, expect, it, beforeEach } from "vitest"
import {
  InvitationService,
  resetInvitationStorageForTest,
  deriveTranscriptAuthCode,
} from "./invitations"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createDeviceEnrollmentInvite, createWorkspaceJoinInvite } from "./protocol"

describe("InvitationService (Tasks 3.2 - 3.4)", () => {
  beforeEach(() => {
    resetIdentityStorageForTest()
    resetInvitationStorageForTest()
  })

  it("handles atomic single-target claim and same-target resume", async () => {
    const profile = await bootstrapIdentity("Issuer Alice")
    const service = new InvitationService()

    const invite = createDeviceEnrollmentInvite("ep1", "sec1", profile)
    await service.saveIssuedInvitation(invite)

    // First claim by device B
    const claim1 = await service.claimInvitation(invite.invitationId, "device_b")
    expect(claim1.ok).toBe(true)

    // Same-target resume succeeds
    const resume = await service.claimInvitation(invite.invitationId, "device_b")
    expect(resume.ok).toBe(true)

    // Competing recipient device C fails
    const claim2 = await service.claimInvitation(invite.invitationId, "device_c")
    expect(claim2.ok).toBe(false)
    if (!claim2.ok) {
      expect(claim2.error).toMatch(/competing/i)
    }
  })

  it("handles cancellation and expiration", async () => {
    const profile = await bootstrapIdentity("Issuer Alice")
    const service = new InvitationService()

    const invite = createDeviceEnrollmentInvite("ep1", "sec1", profile)
    await service.saveIssuedInvitation(invite)

    await service.cancelInvitation(invite.invitationId)
    const claim = await service.claimInvitation(invite.invitationId, "device_b")
    expect(claim.ok).toBe(false)
    if (!claim.ok) {
      expect(claim.error).toMatch(/cancelled/i)
    }
  })

  it("derives deterministic short transcript authentication codes", async () => {
    const code1 = await deriveTranscriptAuthCode("sec_abc", "pubkey_host", "pubkey_guest")
    const code2 = await deriveTranscriptAuthCode("sec_abc", "pubkey_host", "pubkey_guest")
    expect(code1).toEqual(code2)
    expect(code1.length).toBeGreaterThanOrEqual(4)

    const codeDifferent = await deriveTranscriptAuthCode("sec_other", "pubkey_host", "pubkey_guest")
    expect(code1).not.toEqual(codeDifferent)
  })

  it("approves own-device enrollment and issues signed certificate", async () => {
    const profileHost = await bootstrapIdentity("Alice Host")
    resetIdentityStorageForTest()
    const profileGuest = await bootstrapIdentity("Alice Guest Device")
    const service = new InvitationService()

    const invite = createDeviceEnrollmentInvite("ep1", "sec1", profileHost)
    await service.saveIssuedInvitation(invite)

    await service.claimInvitation(invite.invitationId, profileGuest.device.deviceId)

    const approval = await service.approveEnrollment(
      invite.invitationId,
      profileGuest.device,
      profileHost
    )
    expect(approval.ok).toBe(true)
    if (!approval.ok) return

    expect(approval.certificate.payload.deviceId).toBe(profileGuest.device.deviceId)
    expect(approval.certificate.payload.personId).toBe(profileHost.identity.personId)
  })

  it("prevents non-owner editor from issuing workspace grants (Task 3.4)", async () => {
    const owner = await bootstrapIdentity("Owner Alice")
    resetIdentityStorageForTest()
    const editor = await bootstrapIdentity("Editor Bob")
    const service = new InvitationService()

    const invite = createWorkspaceJoinInvite("ep1", "sec1", editor, "ws_1", "Secret Board")
    await service.saveIssuedInvitation(invite)
    await service.claimInvitation(invite.invitationId, "charlie_device")

    // Bob tries to approve grant for Charlie on ws_1 where Bob is only an editor, not owner
    const approval = await service.approveWorkspaceJoin(
      invite.invitationId,
      "person_charlie",
      "ws_1",
      editor,
      owner.identity.personId // real owner is Alice
    )
    expect(approval.ok).toBe(false)
    if (!approval.ok) {
      expect(approval.error).toMatch(/owner/i)
    }
  })

  it("issues signed workspace grants for every workspace in a selected fixed set", async () => {
    const owner = await bootstrapIdentity("Owner Alice")
    const service = new InvitationService()

    const invite = createWorkspaceJoinInvite(
      "ep1",
      "sec1",
      owner,
      [
        { id: "ws_1", title: "Job search" },
        { id: "ws_2", title: "Reading list" },
      ]
    )
    await service.saveIssuedInvitation(invite)
    await service.claimInvitation(invite.invitationId, "charlie_device")

    const res = await service.approveWorkspaceJoinSet(
      invite.invitationId,
      "person_charlie",
      ["ws_1", "ws_2"],
      owner
    )

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.grants).toHaveLength(2)
    expect(res.grants[0].payload.workspaceId).toBe("ws_1")
    expect(res.grants[0].payload.personId).toBe("person_charlie")
    expect(res.grants[1].payload.workspaceId).toBe("ws_2")
    expect(res.grants[1].payload.personId).toBe("person_charlie")
  })

  it("fails grant-set approval explicitly if issuer lacks ownership authority for any workspace", async () => {
    const owner = await bootstrapIdentity("Owner Alice")
    resetIdentityStorageForTest()
    const editor = await bootstrapIdentity("Editor Bob")
    const service = new InvitationService()

    const invite = createWorkspaceJoinInvite(
      "ep1",
      "sec1",
      editor,
      [
        { id: "ws_1", title: "Job search" },
        { id: "ws_2", title: "Reading list" },
      ]
    )
    await service.saveIssuedInvitation(invite)
    await service.claimInvitation(invite.invitationId, "charlie_device")

    const res = await service.approveWorkspaceJoinSet(
      invite.invitationId,
      "person_charlie",
      ["ws_1", "ws_2"],
      editor,
      new Map([["ws_1", owner.identity.personId]]) // Bob is not the owner of ws_1
    )

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toMatch(/owner/i)
    }
  })
})
