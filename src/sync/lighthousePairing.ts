import { verifyDeviceCertificateChain } from "@meta-uber/mesh-identity"
import { bootstrapIdentity, canonicalizeJson, sha256Base64Url, signEnvelope, verifyEnvelope, type LocalProfile } from "../domain/identity"
import { defaultProofStore } from "../domain/proofs"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { peerStore } from "./peerStore"
import type { DeviceCertificate } from "../domain/model"
import type { KeeperWorkspace, LighthouseDiscovery } from "./lighthouseDiscovery"
import type { WorkspaceJoinInvitation } from "@meta-uber/mesh-pairing"

const CONTROL_DOMAIN = "MESH-LIGHTHOUSE/1"

export type KeeperPairing = {
  pairingId: string
  operatorUrl: string
  comparisonCode: string
  expiresAt: number
  transcriptHash: string
  challengeNonce: string
  controllerFingerprint: string
  discovery: LighthouseDiscovery
  workspaces: KeeperWorkspace[]
  futureBoards?: boolean
}

export type KeeperPairingStatus = "pending" | "approved" | "provisioning" | "active" | "rejected" | "expired"
const provisionRequests = new WeakMap<KeeperPairing, string>()

function base64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function operationId(): string { return base64Url(crypto.getRandomValues(new Uint8Array(16))) }
function unixSeconds(): number { return Math.floor(Date.now() / 1000) }

function checkExpiry(payload: Record<string, unknown>) {
  const now = unixSeconds()
  const issuedAt = now
  return { issuedAt, expiresAt: now + 600, operationId: operationId(), ...payload }
}

async function controllerBundle(profile: LocalProfile) {
  const certificates = await defaultProofStore.listCertificates()
  const byId = new Map<string, DeviceCertificate>()
  for (const cert of [profile.certificate, ...certificates]) {
    if (cert.payload.personId === profile.identity.personId) byId.set(cert.payload.deviceId, cert)
  }
  return {
    identity: profile.identity,
    deviceId: profile.device.deviceId,
    certificates: [...byId.values()],
  }
}

async function publicKeyFingerprint(publicKey: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(publicKey)))
  return [...bytes].slice(0, 12).map(byte => byte.toString(16).padStart(2, "0")).join("").match(/.{1,4}/g)?.join(":") ?? "unavailable"
}

export async function getEligibleKeeperWorkspaces(workspaces: KeeperWorkspace[]): Promise<KeeperWorkspace[]> {
  const profile = await bootstrapIdentity()
  const checked = await Promise.all(workspaces.map(async workspace => {
    const authority = await peerStore.getWorkspaceAuthority(workspace.id) ?? await peerStore.getWorkspaceCredential(workspace.id)
    const snapshot = (authority as { scopeAuthoritySnapshot?: { genesis?: unknown } } | null)?.scopeAuthoritySnapshot
    if (!authority || !snapshot?.genesis) return false
    try {
      const validated = meshRustRuntime().state.validateScopeAuthority(snapshot, Date.now()) as { scopeId: string; controller: { personId: string; publicKey: string } }
      return validated.scopeId === workspace.id && validated.controller.personId === profile.identity.personId && validated.controller.publicKey === authority.ownerPublicKey && authority.ownerPersonId === profile.identity.personId
    } catch { return false }
  }))
  return workspaces.filter((_, index) => checked[index])
}

export async function signKeeperControllerRequest(profile: LocalProfile, discovery: LighthouseDiscovery, kind: string, body: Record<string, unknown>) {
  const payload = {
    kind,
    version: 1,
    protocolVersion: 1,
    servicePersonId: discovery.personId,
    serviceOrigin: discovery.origin,
    controllerPersonId: profile.identity.personId,
    controllerDeviceId: profile.device.deviceId,
    ...checkExpiry(body),
  }
  return {
    ...await controllerBundle(profile),
    signed: await signEnvelope(profile.privateKeys.devicePrivateKey, payload, profile.device.deviceId, CONTROL_DOMAIN),
  }
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000), redirect: "error", headers: { Accept: "application/json", "Content-Type": "application/json", ...init.headers } })
  const body = await response.json().catch(() => null) as { message?: string } | null
  if (!response.ok) throw new Error(body?.message || `Keeper pairing failed (${response.status}).`)
  if (!body) throw new Error("Keeper returned an invalid pairing response.")
  return body as T
}

export async function verifyKeeperServiceEnvelope(discovery: LighthouseDiscovery, envelope: unknown, expectedKind: string) {
  if (!envelope || typeof envelope !== "object") throw new Error("Keeper returned an invalid signed challenge.")
  const signed = envelope as { payload?: Record<string, unknown>; signerKeyId?: string; signature?: string }
  if (!signed.payload || typeof signed.signerKeyId !== "string" || typeof signed.signature !== "string" || signed.signerKeyId !== discovery.deviceId || signed.payload.kind !== expectedKind) {
    throw new Error("Keeper signed challenge does not match advertised device.")
  }
  const identity = { personId: discovery.personId, publicKey: discovery.publicKey, displayName: discovery.displayName }
  const certificates = discovery.certificates as DeviceCertificate[]
  const key = await verifyDeviceCertificateChain(identity, discovery.deviceId, certificates)
  if (!await verifyEnvelope(signed as never, key, CONTROL_DOMAIN)) throw new Error("Keeper challenge signature is invalid.")
  return signed.payload
}

function verifyProvisionedScopes(payload: Record<string, unknown>, pairing: KeeperPairing) {
  const provisioned = payload.provisioning as { scopes?: unknown } | undefined
  if (!provisioned || !Array.isArray(provisioned.scopes)) throw new Error("Keeper omitted durable per-board provisioning state.")
  const expected = pairing.workspaces.map(workspace => workspace.id)
  const actual = provisioned.scopes as { workspaceId?: unknown; status?: unknown; error?: unknown; errorDetail?: unknown }[]
  if (actual.length !== expected.length || actual.some((scope, index) =>
    scope.workspaceId !== expected[index]
    || !["pending", "active"].includes(String(scope.status))
    || (scope.error !== undefined && scope.error !== null && !["join_failed", "runtime_unavailable"].includes(String(scope.error))))) {
    throw new Error("Keeper provisioning state does not match the approved board set.")
  }
  if (payload.status === "active" && actual.some(scope => scope.status !== "active" || scope.error !== undefined)) {
    throw new Error("Keeper reported active before every approved board was committed.")
  }
  if (payload.status === "provisioning" && actual.some(scope => scope.error === "join_failed")) {
    const failed = actual.find(scope => scope.error === "join_failed")!
    const detail = typeof failed.errorDetail === "string" ? failed.errorDetail.slice(0, 1024) : "No error detail returned by Rusty"
    throw new Error(`Rusty could not join the selected boards: ${detail}. Keep this tab open and retry board setup.`)
  }
  if (payload.status === "provisioning" && actual.some(scope => scope.error === "runtime_unavailable")) {
    throw new Error("Rusty replication runtime is unavailable. Retry board setup after the service recovers.")
  }
}

export async function beginKeeperPairing(discovery: LighthouseDiscovery, workspaces: KeeperWorkspace[], futureBoards = false): Promise<KeeperPairing> {
  const profile = await bootstrapIdentity()
  if (!workspaces.length) throw new Error("Choose at least one owner board.")
  const scopes = await Promise.all(workspaces.map(async workspace => {
    const authority = await peerStore.getWorkspaceAuthority(workspace.id) ?? await peerStore.getWorkspaceCredential(workspace.id)
    const snapshot = (authority as { scopeAuthoritySnapshot?: { genesis?: unknown } } | null)?.scopeAuthoritySnapshot
    if (!authority || !snapshot?.genesis || authority.ownerPersonId !== profile.identity.personId) {
      throw new Error(`Owner proof unavailable for ${workspace.title}. Reopen Sync on that board and retry.`)
    }
    const validated = meshRustRuntime().state.validateScopeAuthority(snapshot, Date.now()) as { scopeId: string; controller: { personId: string; publicKey: string } }
    if (validated.scopeId !== workspace.id || validated.controller.personId !== profile.identity.personId || validated.controller.publicKey !== authority.ownerPublicKey) {
      throw new Error(`Owner proof unavailable for ${workspace.title}. Reopen Sync on that board and retry.`)
    }
    return { workspaceId: workspace.id, title: workspace.title, genesisAnchor: canonicalizeJson(snapshot.genesis), mode: "replicate" }
  }))
  const signedRequestBody = await signKeeperControllerRequest(profile, discovery, "lighthouse-pairing-offer", {
    body: { scopes, policy: { futureBoards } },
  })
  const transcriptHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(signedRequestBody.signed.payload)))
  const result = await request<{
    pairingId: string; expiresAt: number; operatorUrl: string; comparisonCode: string;
    transcriptHash: string; challenge: unknown
  }>(`${discovery.origin}/v1/pairings`, { method: "POST", body: JSON.stringify(signedRequestBody) })
  if (!result.pairingId || result.transcriptHash !== transcriptHash || !Number.isSafeInteger(result.expiresAt) || typeof result.comparisonCode !== "string") {
    throw new Error("Keeper returned a pairing response that does not match this request.")
  }
  const challenge = await verifyKeeperServiceEnvelope(discovery, result.challenge, "lighthouse-pairing-challenge")
  if (challenge.pairingId !== result.pairingId || challenge.transcriptHash !== transcriptHash || challenge.servicePersonId !== discovery.personId || challenge.serviceOrigin !== discovery.origin || challenge.expiresAt !== result.expiresAt || typeof challenge.nonce !== "string") {
    throw new Error("Keeper challenge is not bound to this pairing, identity and origin.")
  }
  const operatorUrl = new URL(result.operatorUrl)
  if (operatorUrl.origin !== discovery.origin || operatorUrl.pathname !== "/admin/") throw new Error("Keeper returned an unsafe operator URL.")
  return { pairingId: result.pairingId, operatorUrl: operatorUrl.toString(), comparisonCode: result.comparisonCode, expiresAt: result.expiresAt, transcriptHash, challengeNonce: challenge.nonce, controllerFingerprint: await publicKeyFingerprint(profile.identity.publicKey), discovery, workspaces: workspaces.map(workspace => ({ ...workspace })), futureBoards }
}

export async function decideKeeperPairing(pairing: KeeperPairing, approve: boolean): Promise<void> {
  const profile = await bootstrapIdentity()
  const signed = await signKeeperControllerRequest(profile, pairing.discovery, "lighthouse-pairing-decision", {
    pairingId: pairing.pairingId,
    transcriptHash: pairing.transcriptHash,
    challengeNonce: pairing.challengeNonce,
    decision: approve ? "approve" : "decline",
  })
  await request(`${pairing.discovery.origin}/v1/pairings/${encodeURIComponent(pairing.pairingId)}/decision`, { method: "POST", body: JSON.stringify(signed) })
}

export async function getKeeperPairingStatus(pairing: KeeperPairing): Promise<KeeperPairingStatus> {
  const profile = await bootstrapIdentity()
  const signed = await signKeeperControllerRequest(profile, pairing.discovery, "lighthouse-pairing-status", {
    pairingId: pairing.pairingId,
    transcriptHash: pairing.transcriptHash,
  })
  const envelope = await request<unknown>(`${pairing.discovery.origin}/v1/pairings/${encodeURIComponent(pairing.pairingId)}/status`, { method: "POST", body: JSON.stringify(signed) })
  const payload = await verifyKeeperServiceEnvelope(pairing.discovery, envelope, "lighthouse-pairing-status")
  if (payload.pairingId !== pairing.pairingId || payload.transcriptHash !== pairing.transcriptHash || payload.serviceOrigin !== pairing.discovery.origin || !["pending", "approved", "provisioning", "active", "rejected", "expired"].includes(String(payload.status))) {
    throw new Error("Keeper returned a status for another pairing or an unsupported state.")
  }
  if (payload.status === "provisioning" || payload.status === "active") verifyProvisionedScopes(payload, pairing)
  return payload.status as KeeperPairingStatus
}

export async function deliverKeeperInvitation(pairing: KeeperPairing, invitation: WorkspaceJoinInvitation): Promise<KeeperPairingStatus> {
  let body = provisionRequests.get(pairing)
  if (!body) {
    const profile = await bootstrapIdentity()
    const approvedScopes = pairing.workspaces.map(workspace => ({ workspaceId: workspace.id, mode: "replicate" }))
    const signed = await signKeeperControllerRequest(profile, pairing.discovery, "lighthouse-pairing-provision", {
      body: {
        pairingId: pairing.pairingId,
        transcriptHash: pairing.transcriptHash,
        servicePersonId: pairing.discovery.personId,
        approvedScopes,
        futureBoards: pairing.futureBoards === true,
        invitation,
      },
    })
    body = JSON.stringify(signed)
    provisionRequests.set(pairing, body)
  }
  const result = await request<unknown>(`${pairing.discovery.origin}/v1/pairings/${encodeURIComponent(pairing.pairingId)}/provision`, {
    method: "POST",
    body,
  })
  const payload = await verifyKeeperServiceEnvelope(pairing.discovery, result, "lighthouse-pairing-status")
  if (payload.pairingId !== pairing.pairingId
    || payload.transcriptHash !== pairing.transcriptHash
    || payload.serviceOrigin !== pairing.discovery.origin
    || !["provisioning", "active"].includes(String(payload.status))) {
    throw new Error("Keeper returned a provisioning state for another pairing or scope set.")
  }
  verifyProvisionedScopes(payload, pairing)
  return payload.status as KeeperPairingStatus
}
