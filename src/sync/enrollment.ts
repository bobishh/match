import { z } from "zod"
import { adoptEnrolledIdentity, fromBase64Url, signEnvelope, toBase64Url, verifyEnvelope, type LocalProfile } from "../domain/identity"
import type { DeviceCertificate, PersonalRootDocumentV1 } from "../domain/model"
import { certHashDefault, defaultProofStore } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { keyId, verifyDeviceChain } from "./meshRecords"
import type { DeviceEnrollmentInvitation } from "./protocol"

const text = z.string().min(1).max(512)
const certificateSchema = z.object({
  payload: z.object({ kind: z.literal("device-certificate"), version: z.literal(1), personId: text,
    deviceId: text, devicePublicKey: text, issuerCertificateHash: text.nullable(), canEnrollDevices: z.literal(true) }),
  signerKeyId: text, signature: text,
})
const identitySchema = z.object({ personId: text, publicKey: text, displayName: text })
const rootSchema = z.object({ kind: z.literal("personal-root"), formatVersion: z.literal(1), rootId: text,
  identity: identitySchema,
  devices: z.record(z.string(), z.object({ deviceId: text, publicKey: text, displayName: text, certificateHash: text, addedAt: text })),
  workspaces: z.record(z.string(), z.object({ workspaceId: text, documentId: text, grantHash: text, forgotten: z.boolean() })),
})
const requestPayload = z.object({ kind: z.literal("device-enrollment-request"), version: z.literal(2),
  invitationId: text, deviceId: text, publicKey: text, displayName: text })
const requestSchema = z.object({ payload: requestPayload, signerKeyId: text, signature: text })
const approvalSchema = z.object({
  payload: z.object({ kind: z.literal("device-enrollment-approval"), version: z.literal(2), invitationId: text,
    recipientDeviceId: text, certificate: certificateSchema, certificates: z.array(certificateSchema).min(1).max(32),
    personalRoot: rootSchema, workspaces: z.array(z.object({ id: text, title: text })).min(1).max(512),
    activeWorkspaceId: text,
    meshWorkspaces: z.array(z.object({ workspaceId: text, ownerPersonId: text, ownerPublicKey: text }).passthrough()).max(512),
    snapshot: z.string().min(1),
  }), signerKeyId: text, signature: text,
})
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

export async function createEnrollmentRequest(invite: DeviceEnrollmentInvitation, profile: LocalProfile) {
  return encode(await signEnvelope(profile.privateKeys.devicePrivateKey, {
    kind: "device-enrollment-request", version: 2, invitationId: invite.invitationId,
    deviceId: profile.device.deviceId, publicKey: profile.device.publicKey, displayName: profile.device.displayName,
  }, profile.device.deviceId))
}

export async function readEnrollmentRequest(bytes: Uint8Array, invite: DeviceEnrollmentInvitation) {
  const parsed = requestSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)))
  if (!parsed.success) throw new Error("The other device needs an update. Reload both devices and create a new link.")
  const request = parsed.data
  if (request.payload.invitationId !== invite.invitationId || request.signerKeyId !== request.payload.deviceId ||
    await keyId(request.payload.publicKey) !== request.payload.deviceId ||
    !await verifyEnvelope(request, request.payload.publicKey)) throw new Error("Invalid device enrollment request.")
  return request.payload
}

export async function enrollmentPayload(invite: DeviceEnrollmentInvitation, profile: LocalProfile,
  certificate: DeviceCertificate, personalRoot: PersonalRootDocumentV1, workspaces: { id: string; title: string }[],
  activeWorkspaceId: string, meshWorkspaces: unknown[], snapshot: Uint8Array) {
  const certificates = [profile.certificate, ...(await defaultProofStore.listCertificates())]
    .filter(cert => cert.payload.personId === profile.identity.personId)
  const payload = {
    kind: "device-enrollment-approval", version: 2, invitationId: invite.invitationId,
    recipientDeviceId: certificate.payload.deviceId, certificate,
    certificates: [...new Map(certificates.map(cert => [cert.signature, cert])).values()],
    personalRoot, workspaces, activeWorkspaceId, meshWorkspaces, snapshot: toBase64Url(snapshot),
  }
  // Optional mesh fields must have exactly the same shape when signed and sent as JSON.
  return encode(await signEnvelope(profile.privateKeys.devicePrivateKey, JSON.parse(JSON.stringify(payload)), profile.device.deviceId))
}

export async function installEnrollment(bytes: Uint8Array, invite: DeviceEnrollmentInvitation, profile: LocalProfile) {
  const raw = JSON.parse(new TextDecoder().decode(bytes))
  if (typeof raw?.error === "string") throw new Error(raw.error)
  const parsed = approvalSchema.safeParse(raw)
  if (!parsed.success) throw new Error("The other device needs an update. Reload both devices and create a new link.")
  const approval = parsed.data
  const payload = approval.payload
  // Verify the original envelope, before schema parsing can strip unknown fields.
  if (approval.signerKeyId !== invite.issuerDeviceId || !await verifyEnvelope(raw, invite.issuerPublicKey)) {
    throw new Error("Invalid device enrollment approval signature.")
  }
  if (payload.invitationId !== invite.invitationId || payload.recipientDeviceId !== profile.device.deviceId ||
    payload.personalRoot.identity.personId !== invite.issuerPersonId ||
    payload.certificate.payload.deviceId !== profile.device.deviceId ||
    payload.certificate.payload.devicePublicKey !== profile.device.publicKey ||
    payload.certificate.payload.personId !== invite.issuerPersonId ||
    new Set(payload.workspaces.map(item => item.id)).size !== payload.workspaces.length ||
    !payload.workspaces.some(item => item.id === payload.activeWorkspaceId) ||
    payload.meshWorkspaces.length !== payload.workspaces.length ||
    new Set(payload.meshWorkspaces.map(item => item.workspaceId)).size !== payload.workspaces.length ||
    payload.meshWorkspaces.some(item => item.ownerPersonId !== invite.issuerPersonId ||
      item.ownerPublicKey !== payload.personalRoot.identity.publicKey || !payload.workspaces.some(ws => ws.id === item.workspaceId))) {
    throw new Error("Invalid device enrollment approval.")
  }
  const certificates = [...payload.certificates, payload.certificate]
  const issuerKey = await verifyDeviceChain({ personId: invite.issuerPersonId,
    publicKey: payload.personalRoot.identity.publicKey, deviceId: invite.issuerDeviceId, certificates })
  if (issuerKey !== invite.issuerPublicKey) throw new Error("Enrollment issuer does not match the invitation.")
  await verifyDeviceChain({ personId: invite.issuerPersonId, publicKey: payload.personalRoot.identity.publicKey,
    deviceId: profile.device.deviceId, certificates })
  for (const cert of certificates) await defaultProofStore.putCertificate(await certHashDefault(cert), cert)
  // Validate encoded data before changing the local identity.
  fromBase64Url(payload.snapshot)
  await defaultStorage.savePersonalRoot(payload.personalRoot)
  const enrolled = await adoptEnrolledIdentity(payload.personalRoot.identity, payload.certificate)
  return { ...payload, profile: enrolled }
}
