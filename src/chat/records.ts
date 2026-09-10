import { fromBase64Url, sha256Base64Url, signEnvelope, verifyEnvelope, type LocalProfile, type SignedEnvelope } from "../domain/identity"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import { certHashDefault } from "../domain/proofs"
import { validateDisplayName, normalizeDisplayName } from "./names"
import { peerStore } from "../sync/peerStore"

export type ChatPayload = {
  kind: "chat-message" | "chat-profile"
  version: 1
  workspaceId: string
  personId: string
  deviceId: string
  id: string
  createdAt: string
  text: string
  revision: number
}

export type ChatAuthority = {
  publicKey: string
  certificates: DeviceCertificate[]
  grant?: WorkspaceGrant
}

export type ChatRecord = {
  signed: SignedEnvelope<ChatPayload>
  publicKey: string
  certificates: DeviceCertificate[]
  authority: ChatAuthority
}

async function keyId(key: string) {
  const bytes = fromBase64Url(key)
  if (bytes.byteLength !== 32) throw new Error("Invalid public key")
  return sha256Base64Url(bytes)
}

async function deviceKey(personId: string, publicKey: string, signerId: string, certificates: DeviceCertificate[]): Promise<string> {
  if (await keyId(publicKey) !== personId) throw new Error("Identity does not match its key")
  if (!Array.isArray(certificates) || certificates.length > 32) throw new Error("Invalid certificate chain")
  const byHash = new Map<string, DeviceCertificate>()
  for (const cert of certificates) byHash.set(await certHashDefault(cert), cert)
  const first = certificates.find(c => c.payload.deviceId === signerId)
  let cert = first
  const seen = new Set<string>()
  while (cert) {
    const p = cert.payload
    if (p.kind !== "device-certificate" || p.version !== 1 || p.personId !== personId ||
        await keyId(p.devicePublicKey) !== p.deviceId || seen.has(p.deviceId)) throw new Error("Invalid device certificate")
    seen.add(p.deviceId)
    if (p.issuerCertificateHash === null) {
      if (cert.signerKeyId !== personId || !await verifyEnvelope(cert, publicKey)) throw new Error("Invalid root signature")
      return first!.payload.devicePublicKey
    }
    const issuer = byHash.get(p.issuerCertificateHash)
    if (!issuer || !issuer.payload.canEnrollDevices || cert.signerKeyId !== issuer.payload.deviceId ||
        !await verifyEnvelope(cert, issuer.payload.devicePublicKey)) throw new Error("Invalid delegated signature")
    cert = issuer
  }
  throw new Error("Missing device certificate")
}

export async function verifyChatRecord(value: unknown, workspaceId: string, ownerPersonId: string, grantWorkspaceId = workspaceId): Promise<ChatRecord> {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 32768) throw new Error("Chat record too large")
  const record = value as ChatRecord
  const p = record?.signed?.payload
  if (!p || p.version !== 1 || !["chat-message", "chat-profile"].includes(p.kind) ||
      p.workspaceId !== workspaceId || typeof p.personId !== "string" || typeof p.deviceId !== "string" ||
      typeof p.id !== "string" || !p.id.startsWith(`${p.deviceId}:`) || p.id.length > 160 ||
      typeof p.text !== "string" || typeof p.createdAt !== "string" ||
      !Number.isFinite(Date.parse(p.createdAt)) || new Date(p.createdAt).toISOString() !== p.createdAt ||
      Date.parse(p.createdAt) > Date.now() + 300_000 || !Number.isSafeInteger(p.revision) || p.revision < 0 ||
      record.signed.signerKeyId !== p.deviceId) throw new Error("Invalid chat record")
  if (p.kind === "chat-profile") {
    if (validateDisplayName(p.text) || normalizeDisplayName(p.text) !== p.text) throw new Error("Invalid display name")
  } else if (!p.text.trim() || [...p.text].length > 8000) throw new Error("Message must contain 1–8,000 characters")
  const key = await deviceKey(p.personId, record.publicKey, p.deviceId, record.certificates)
  if (!await verifyEnvelope(record.signed, key)) throw new Error("Invalid message signature")
  const authority = record.authority
  if (!authority || await keyId(authority.publicKey) !== ownerPersonId) throw new Error("Invalid workspace authority")
  if (p.personId !== ownerPersonId) {
    if (typeof indexedDB !== "undefined" && (await peerStore.listPeers(grantWorkspaceId)).some(peer => peer.personId === p.personId && peer.revokedAt)) {
      throw new Error("Workspace access revoked")
    }
    const grant = authority.grant
    if (!grant || grant.payload.kind !== "workspace-grant" || grant.payload.version !== 1 ||
        grant.payload.personId !== p.personId || grant.payload.workspaceId !== grantWorkspaceId ||
        !["owner", "editor"].includes(grant.payload.role)) throw new Error("No permission to write to this chat")
    // Existing workspace invitations sign with the root key but label the signer with a device ID.
    if (!await verifyEnvelope(grant, authority.publicKey)) {
      const ownerDeviceKey = await deviceKey(ownerPersonId, authority.publicKey, grant.signerKeyId, authority.certificates)
      if (!await verifyEnvelope(grant, ownerDeviceKey)) throw new Error("Invalid workspace grant")
    }
  }
  return record
}

export async function createChatRecord(profile: LocalProfile, certificates: DeviceCertificate[], authority: ChatAuthority,
  workspaceId: string, kind: ChatPayload["kind"], text: string, revision = 0): Promise<ChatRecord> {
  const payload: ChatPayload = {
    kind, version: 1, workspaceId, personId: profile.identity.personId, deviceId: profile.device.deviceId,
    id: `${profile.device.deviceId}:${crypto.randomUUID()}`, createdAt: new Date().toISOString(), text, revision,
  }
  return {
    signed: await signEnvelope(profile.privateKeys.devicePrivateKey, payload, profile.device.deviceId),
    publicKey: profile.identity.publicKey, certificates, authority,
  }
}
