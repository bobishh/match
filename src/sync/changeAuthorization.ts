import * as Automerge from "@automerge/automerge/slim"
import { canonicalizeJson, publicKeyId, sha256Base64Url, signEnvelope, type LocalProfile } from "../domain/identity"
import type { WorkspaceDocumentV2, WorkspaceGrant, DeviceCertificate } from "../domain/model"
import { defaultProofStore } from "../domain/proofs"
import { peerStore, type WorkspaceAuthorityRecord, type WorkspaceMeshCredential } from "./peerStore"
import { type WorkspaceAuthority, type WorkspaceOwnershipTransfer,
  type WorkspaceSuccessionClaim, type WorkspaceDeviceRevocation } from "./meshRecords"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { mergeAuthorizationRecords, putRecords, records, type WorkspaceChangeAuthorization } from "./workspaceChangeProofStore"
import { runWorkspaceAdmission } from "./workspaceAdmissionClient"
import type { IncomingAuthorizationBundle, WorkspaceAdmissionResult, WorkspaceWriteAuthorityEvidence } from "./workspaceAdmissionCore"
import { readWorkspaceSnapshot } from "../storageJournal"

import type { WorkspaceRole } from "../domain/permissions"
export class WorkspaceChangeRejected extends Error {
  constructor(message: string) { super(message); this.name = "WorkspaceChangeRejected" }
}

type StoredWorkspaceAuthority = WorkspaceMeshCredential | WorkspaceAuthorityRecord

async function storedWorkspaceAuthority(workspaceId: string): Promise<{ authority: StoredWorkspaceAuthority | null; invalid: boolean }> {
  try {
    // Active transport credentials are replaceable connection state. Durable
    // authority records are the authorization source of truth, including
    // historical owner keys needed to validate an older legitimate grant.
    const authority = await peerStore.getWorkspaceAuthority(workspaceId)
    if (authority) return validateStoredAuthority(authority)
    return validateStoredAuthority(await peerStore.getWorkspaceCredential(workspaceId))
  } catch {
    return { authority: null, invalid: typeof indexedDB !== "undefined" }
  }
}

/** Invalid durable authority is a read-only state, not permission to replay raw history. */
export async function workspaceAuthorityIsInvalid(workspaceId: string): Promise<boolean> {
  return (await storedWorkspaceAuthority(workspaceId)).invalid
}

async function validateStoredAuthority(authority: StoredWorkspaceAuthority | null): Promise<{ authority: StoredWorkspaceAuthority | null; invalid: boolean }> {
  if (!authority) return { authority: null, invalid: false }
  // Never treat historical keys as a repair path for a malformed current
  // authority. That would let a locally forged owner record retain editor
  // privileges through an older, valid owner grant.
  try {
    if (await publicKeyId(authority.ownerPublicKey) !== authority.ownerPersonId)
      return { authority: null, invalid: true }
    const scope = (authority as StoredWorkspaceAuthority & { scopeAuthoritySnapshot?: unknown }).scopeAuthoritySnapshot
    if (scope) {
      const validated = meshRustRuntime().state.validateScopeAuthority(scope, Date.now()) as {
        scopeId: string; controller: { personId: string; publicKey: string }
      }
      if (validated.scopeId !== authority.workspaceId || validated.controller.personId !== authority.ownerPersonId ||
        validated.controller.publicKey !== authority.ownerPublicKey) return { authority: null, invalid: true }
    }
  } catch {
    return { authority: null, invalid: true }
  }
  return { authority, invalid: false }
}

function uniqueCertificates(profile: LocalProfile, certificates: DeviceCertificate[]) {
  const values = [profile.certificate, ...certificates].filter(certificate =>
    certificate?.payload?.personId === profile.identity.personId)
  return [...new Map(values.map(certificate => [certificate.signature, certificate])).values()]
}

export async function recordGenesisAuthority(doc: Automerge.Doc<WorkspaceDocumentV2>, profile: LocalProfile): Promise<Authorization[]> {
  const creator = { personId: profile.identity.personId, publicKey: profile.identity.publicKey,
    certificates: [profile.certificate] }
  const payload = meshRustRuntime().state.planScopeGenesis({ scopeId: doc.id,
    documentOwnerPersonId: doc.ownerPersonId, creator }) as {
    kind: "scope-genesis"; version: 1; scopeId: string; creator: typeof creator; controlEpoch: 1
  }
  if (typeof indexedDB === "undefined") {
    // CLI/unit hosts still need the exact genesis changes signed into their
    // local journal; skipping proofs would make causal replay erase the seed
    // workspace when it builds the first authorized projection.
    const hashes = Automerge.getAllChanges(doc).map(change => Automerge.decodeChange(change).hash)
    return hashes.length ? authorizeLocalChanges(doc, profile, hashes) : []
  }
  const genesis = await signEnvelope(profile.privateKeys.devicePrivateKey, payload, profile.device.deviceId)
  const scopeAuthoritySnapshot = { genesis, grants: [], grantIssuers: [], revocations: [], controlTransfers: [] }
  const validated = meshRustRuntime().state.validateScopeAuthority(scopeAuthoritySnapshot, Date.now()) as {
    scopeId: string; controller: { personId: string }
  }
  if (validated.scopeId !== doc.id || validated.controller.personId !== profile.identity.personId)
    throw new Error("Invalid workspace genesis authority")
  const authority: WorkspaceAuthorityRecord & { scopeAuthoritySnapshot: typeof scopeAuthoritySnapshot } = {
    version: 1, workspaceId: doc.id, genesisOwnerPersonId: profile.identity.personId,
    ownerPersonId: profile.identity.personId, ownerPublicKey: profile.identity.publicKey,
    ownerCertificates: [profile.certificate], epoch: 1,
    updatedAt: new Date().toISOString(), catalog: {}, scopeAuthoritySnapshot,
  }
  await peerStore.putWorkspaceAuthority(authority)
  const hashes = Automerge.getAllChanges(doc)
    .map(change => Automerge.decodeChange(change).hash)
  return hashes.length ? authorizeLocalChanges(doc, profile, hashes) : []
}

type Authorization = WorkspaceChangeAuthorization

export async function workspaceRole(doc: WorkspaceDocumentV2, profile: LocalProfile): Promise<WorkspaceRole> {
  const stored = await storedWorkspaceAuthority(doc.id)
  if (stored.invalid) {
    traceWorkspaceAccess(doc, profile, stored.authority, "visitor", "invalid")
    return "visitor"
  }
  const authority = stored.authority
  const genesisOwner = authorities(authority).find(owner => owner.personId === doc.ownerPersonId)
  if (!authority && typeof indexedDB === "undefined" && doc.ownerPersonId === profile.identity.personId) {
    const root = { personId: profile.identity.personId, publicKey: profile.identity.publicKey,
      certificates: [profile.certificate] }
    return decideWorkspaceRole(doc, profile, {
      version: 1, workspaceId: doc.id, genesisOwnerPersonId: root.personId,
      ownerPersonId: root.personId, ownerPublicKey: root.publicKey,
      ownerCertificates: root.certificates, ownerHistory: [], epoch: 1,
      updatedAt: new Date().toISOString(), catalog: {},
    }, root)
  }
  if (!authority || !genesisOwner) {
    traceWorkspaceAccess(doc, profile, authority, "visitor", "missing")
    return "visitor"
  }
  try {
    const role = await decideWorkspaceRole(doc, profile, authority, genesisOwner)
    traceWorkspaceAccess(doc, profile, authority, role, "valid")
    return role
  } catch (error) {
    traceWorkspaceAccess(doc, profile, authority, "unavailable", "error")
    throw error
  }
}

/** Opt-in, bounded access diagnostics. Extra identity fields stay in the local
 * trace snapshot; telemetry's allowlist intentionally drops them. */
function traceWorkspaceAccess(doc: WorkspaceDocumentV2, profile: LocalProfile, authority: StoredWorkspaceAuthority | null,
  role: WorkspaceRole | "unavailable", validation: "valid" | "invalid" | "missing" | "error") {
  if (typeof window === "undefined" || new URLSearchParams(window.location.search).get("syncTrace") !== "1") return
  const catalog = authority?.catalog as {
    deviceRevocations?: Array<{ record?: { payload?: { personId?: string; deviceId?: string } } }>
    revocations?: Array<{ payload?: { personId?: string; epoch?: number } }>
  } | undefined
  const deviceRevocations = catalog?.deviceRevocations ?? []
  const personRevocations = catalog?.revocations ?? []
  const profilePersonId = profile.identity.personId
  const currentDeviceId = profile.device.deviceId
  const matchingDeviceRevocations = deviceRevocations.filter(item =>
    item.record?.payload?.personId === profilePersonId && item.record?.payload?.deviceId === currentDeviceId)
  const matchingPersonRevocations = personRevocations.filter(item => item.payload?.personId === profilePersonId)
  const grant = authority?.localGrant as WorkspaceGrant | undefined
  void import("./meshTrace").then(({ meshTrace }) => meshTrace("workspace.access.resolution", {
    workspaceId: doc.id.slice(0, 8),
    profilePersonPrefix: profilePersonId.slice(0, 8),
    documentOwnerPrefix: doc.ownerPersonId.slice(0, 8),
    authorityOwnerPrefix: authority?.ownerPersonId.slice(0, 8) ?? "",
    currentDevicePrefix: currentDeviceId.slice(0, 8),
    localGrantPersonPrefix: grant?.payload.personId.slice(0, 8) ?? "",
    localGrantEpoch: grant?.payload.accessEpoch ?? null,
    role,
    authorityValidation: validation,
    profileIsAuthorityOwner: profilePersonId === authority?.ownerPersonId,
    profileIsDocumentOwner: profilePersonId === doc.ownerPersonId,
    deviceRevocationCount: deviceRevocations.length,
    personRevocationCount: personRevocations.length,
    localDeviceRevoked: matchingDeviceRevocations.length > 0,
    localPersonRevocationCount: matchingPersonRevocations.length,
    localPersonRevocationEpoch: Math.max(0, ...matchingPersonRevocations.map(item => item.payload?.epoch ?? 0)),
  })).catch(() => {})
}

/** Immutable grant identity embedded in each newly authored editor change. */
export async function localChangeAuthorityGrantHash(workspaceId: string, personId: string, allowVisitorProfile = false): Promise<string | undefined> {
  if (typeof indexedDB === "undefined") return undefined
  const stored = await storedWorkspaceAuthority(workspaceId)
  const authority = stored.authority
  if (stored.invalid) throw new Error("Workspace authority is unavailable")
  if (!authority) throw new Error("Workspace authority is unavailable")
  if (authority.ownerPersonId === personId) return undefined
  const grant = authority.localGrant as WorkspaceGrant | undefined
  if (!grant || grant.payload.workspaceId !== workspaceId || grant.payload.personId !== personId ||
    (grant.payload.role !== "editor" && !(allowVisitorProfile && grant.payload.role === "visitor"))) {
    throw new Error(allowVisitorProfile ? "Workspace profile grant is unavailable" : "Workspace editor grant is unavailable")
  }
  return sha256Base64Url(new TextEncoder().encode(canonicalizeJson(grant)))
}

async function decideWorkspaceRole(doc: WorkspaceDocumentV2, profile: LocalProfile, authority: StoredWorkspaceAuthority,
  genesisOwner: WorkspaceAuthority): Promise<WorkspaceRole> {
  const catalog = authority.catalog as {
    ownershipTransfers?: WorkspaceOwnershipTransfer[]
    successionClaims?: WorkspaceSuccessionClaim[]
    revocations?: unknown[]
    deviceRevocations?: WorkspaceDeviceRevocation[]
    departures?: Array<{ record: unknown; authority: WorkspaceAuthority }>
  } | undefined
  const localCertificates = uniqueCertificates(profile, await defaultProofStore.listCertificates().catch(() => []))
  const role = await (await import("./workspaceAccess")).decideAccess(doc as Automerge.Doc<WorkspaceDocumentV2>, {
    snapshot: {
      workspaceId: doc.id, genesisOwner, genesisEpoch: 1,
      expectedCurrentOwner: { personId: authority.ownerPersonId, publicKey: authority.ownerPublicKey,
        certificates: authority.ownerCertificates as DeviceCertificate[] },
      ownershipTransfers: catalog?.ownershipTransfers ?? [], successionClaims: catalog?.successionClaims ?? [],
      revocations: catalog?.revocations ?? [],
      deviceRevocations: (catalog?.deviceRevocations ?? []).map(value => ({ record: value.record, signer: value.authority })),
      departures: catalog?.departures ?? [],
    },
    identity: { personId: profile.identity.personId, publicKey: profile.identity.publicKey,
      certificates: localCertificates },
    deviceId: profile.device.deviceId,
    grant: authority.localGrant as WorkspaceGrant | undefined,
    departures: catalog?.departures ?? [],
    legacyAuthorityEvidence: (catalog as { breakGlassClaims?: unknown[] } | undefined)?.breakGlassClaims ?? [],
  })
  await assertCurrentAccessAuthority(doc.id, authority)
  return role
}

async function assertCurrentAccessAuthority(workspaceId: string, authority: StoredWorkspaceAuthority) {
  if (typeof indexedDB === "undefined") return
  if (canonicalizeJson({ ...(await storedWorkspaceAuthority(workspaceId)).authority, updatedAt: "" }) !== canonicalizeJson({ ...authority, updatedAt: "" }))
    throw new Error("Workspace authority changed during access validation. Retry.")
}

export async function effectiveWorkspaceOwner(workspaceId: string, genesisOwnerPersonId: string) {
  if (typeof indexedDB === "undefined") return genesisOwnerPersonId
  return (await storedWorkspaceAuthority(workspaceId)).authority?.ownerPersonId ?? genesisOwnerPersonId
}

export async function workspaceWritesBlocked(workspaceId: string) {
  if (typeof indexedDB === "undefined") return false
  const stored = await storedWorkspaceAuthority(workspaceId)
  if (stored.invalid) throw new Error("Workspace authority could not be verified")
  return Boolean(stored.authority && meshRustRuntime().state.hasAuthorityConflict(stored.authority))
}

function authorities(credential: StoredWorkspaceAuthority | null) {
  if (!credential) return []
  return [{ personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey,
    certificates: credential.ownerCertificates as DeviceCertificate[] },
  ...((credential.ownerHistory ?? []) as WorkspaceAuthority[])]
}

export async function prepareLocalChangeAuthorizations(doc: Automerge.Doc<WorkspaceDocumentV2>, profile: LocalProfile, hashes: string[]) {
  const credential = typeof indexedDB === "undefined" ? undefined : (await storedWorkspaceAuthority(doc.id)).authority
  if (typeof indexedDB !== "undefined" && !credential) throw new Error("Workspace authority is unavailable. Import this board as a new board.")
  const ownerPersonId = credential?.ownerPersonId ?? doc.ownerPersonId
  const certificates = (await defaultProofStore.listCertificates()).filter(cert => cert.payload.personId === profile.identity.personId)
  if (!certificates.some(cert => cert.payload.deviceId === profile.device.deviceId)) certificates.push(profile.certificate)
  const signed = await signEnvelope(profile.privateKeys.devicePrivateKey, {
    kind: "workspace-changes" as const, version: 1 as const, workspaceId: doc.id, hashes,
    personId: profile.identity.personId, deviceId: profile.device.deviceId,
  }, profile.device.deviceId)
  return [{ signed, publicKey: profile.identity.publicKey, certificates,
    ...(profile.identity.personId !== ownerPersonId ? { grant: credential?.localGrant as WorkspaceGrant } : {}),
    ownerPublicKey: credential?.ownerPublicKey ?? profile.identity.publicKey,
    ownerCertificates: credential?.ownerCertificates as DeviceCertificate[] ?? certificates,
  }] satisfies Authorization[]
}

export async function authorizeLocalChanges(doc: Automerge.Doc<WorkspaceDocumentV2>, profile: LocalProfile, hashes: string[]) {
  const authorizations = await prepareLocalChangeAuthorizations(doc, profile, hashes)
  await putRecords(doc.id, authorizations)
  return authorizations
}
export async function exportAuthorizations(bytes: Uint8Array) {
  const doc = Automerge.load<WorkspaceDocumentV2>(bytes)
  try { return await records(doc.id) }
  finally { Automerge.free(doc) }
}

/**
 * Carries signed write proofs with the authority evidence Rust needs to admit
 * them. The receiver verifies this evidence before it uses any of it and does
 * not store it as a side effect of validation.
 */
export async function exportAuthorizationBundle(bytes: Uint8Array, knownProfile?: LocalProfile): Promise<Extract<IncomingAuthorizationBundle, { version: 1 }>> {
  const doc = Automerge.load<WorkspaceDocumentV2>(bytes)
  try { return await exportDocumentAuthorizationBundle(doc, knownProfile) }
  finally { Automerge.free(doc) }
}

export async function exportDocumentAuthorizationBundle(doc: Automerge.Doc<WorkspaceDocumentV2>, knownProfile?: LocalProfile): Promise<Extract<IncomingAuthorizationBundle, { version: 1 }>> {
  let authority = (await storedWorkspaceAuthority(doc.id)).authority
  if (!authority && typeof indexedDB === "undefined" && knownProfile?.identity.personId === doc.ownerPersonId) {
    authority = {
      version: 1, workspaceId: doc.id, genesisOwnerPersonId: knownProfile.identity.personId,
      ownerPersonId: knownProfile.identity.personId, ownerPublicKey: knownProfile.identity.publicKey,
      ownerCertificates: uniqueCertificates(knownProfile, await defaultProofStore.listCertificates()),
      epoch: 1, updatedAt: new Date().toISOString(), catalog: {},
    }
  }
  const evidence = workspaceWriteAuthorityEvidence(doc, authority)
  if (!evidence) throw new Error("Workspace authority is unavailable for write authorization")
  const snapshot = await readWorkspaceSnapshot(doc.id)
  const rawEvidence = (snapshot?.causalEvidence?.authorizationEvidence ?? []) as Authorization[]
  return { version: 1, records: mergeAuthorizationRecords(await records(doc.id), rawEvidence), authority: evidence }
}

function workspaceWriteAuthorityEvidence(doc: WorkspaceDocumentV2, authority: StoredWorkspaceAuthority | null): WorkspaceWriteAuthorityEvidence | undefined {
  if (!authority) return undefined
  const owners = authorities(authority)
  const genesisOwner = owners.find(owner => owner.personId === doc.ownerPersonId)
  if (!genesisOwner) return undefined
  const catalog = authority.catalog as {
    ownershipTransfers?: WorkspaceOwnershipTransfer[]
    successionClaims?: WorkspaceSuccessionClaim[]
    revocations?: unknown[]
    deviceRevocations?: WorkspaceDeviceRevocation[]
    departures?: Array<{ record: unknown; authority: WorkspaceAuthority }>
    breakGlassClaims?: unknown[]
  } | undefined
  // A removed recovery path must never be silently treated as valid evidence.
  assertSupportedAuthorityCatalog(catalog)
  return {
    genesisOwner,
    genesisEpoch: 1,
    currentOwner: owners[0]!,
    currentEpoch: authority.epoch,
    ownershipTransfers: catalog?.ownershipTransfers ?? [],
    successionClaims: catalog?.successionClaims ?? [],
    revocations: catalog?.revocations ?? [],
    deviceRevocations: (catalog?.deviceRevocations ?? []).map(value => ({ record: value.record, signer: value.authority })),
    departures: catalog?.departures ?? [],
  }
}

function assertSupportedAuthorityCatalog(catalog: { breakGlassClaims?: unknown[] } | undefined): void {
  if ((catalog?.breakGlassClaims ?? []).length) throw new Error("Legacy break-glass authority is unsupported")
}

async function incomingCredential(workspaceId: string): Promise<StoredWorkspaceAuthority | null> {
  try { return (await storedWorkspaceAuthority(workspaceId)).authority } catch (error) {
    if (typeof indexedDB === "undefined" && /IndexedDB is not available/i.test(error instanceof Error ? error.message : String(error))) return null
    throw error
  }
}

function authorizationBundle(raw: unknown): IncomingAuthorizationBundle {
  const bundle = raw as IncomingAuthorizationBundle
  if (!bundle || ![1, 2].includes(bundle.version) || !bundle.authority ||
    (bundle.version === 1 ? !Array.isArray(bundle.records) : !Array.isArray(bundle.pages))) {
    throw new Error("The peer needs an update: missing workspace authority evidence")
  }
  return bundle
}

function normalizeAuthorityDepartures(authority: WorkspaceWriteAuthorityEvidence): WorkspaceWriteAuthorityEvidence {
  const departures = (authority as { departures?: unknown }).departures
  if (departures === undefined) return { ...authority, departures: [] }
  if (!Array.isArray(departures)) throw new Error("Invalid workspace authority departures")
  return authority
}

export async function validateIncomingChanges(local: Automerge.Doc<WorkspaceDocumentV2> | undefined, remote: Automerge.Doc<WorkspaceDocumentV2>, raw: unknown): Promise<void> {
  await validateIncomingChangeAuthorizations(local, remote, raw)
}

/** Validation is deliberately side-effect free so callers can reject an entire
 * enrollment batch before a workspace, proof, or authority record is written. */
export async function validateIncomingChangeAuthorizations(local: Automerge.Doc<WorkspaceDocumentV2> | undefined,
  remote: Automerge.Doc<WorkspaceDocumentV2>, raw: unknown): Promise<Authorization[]> {
  return (await evaluateIncomingWorkspaceAdmission(local, remote, raw)).verifiedAuthorizations
}

/** Reclassifies complete raw history, including hashes already stored locally. */
export async function evaluateIncomingWorkspaceAdmission(local: Automerge.Doc<WorkspaceDocumentV2> | undefined,
  remote: Automerge.Doc<WorkspaceDocumentV2>, raw: unknown, priorEvidenceRecords: Authorization[] = []): Promise<WorkspaceAdmissionResult & { rawBytes: Uint8Array }> {
  const credential = await incomingCredential(remote.id)
  if (credential && meshRustRuntime().state.hasAuthorityConflict(credential)) throw new Error("Workspace writes paused: conflicting ownership records")
  const unnormalizedBundle = authorizationBundle(raw)
  const bundle = { ...unnormalizedBundle, authority: normalizeAuthorityDepartures(unnormalizedBundle.authority) }
  const frozenCredential = canonicalizeJson(credential)
  const knownAuthority = local ? workspaceWriteAuthorityEvidence(local, credential) ?? null : null
  const rawRecords = (bundle.version === 1 ? bundle.records : bundle.pages.flat()) as Authorization[]
  const allRecords = mergeAuthorizationRecords([...await records(remote.id), ...priorEvidenceRecords], rawRecords)
  const combinedBundle: IncomingAuthorizationBundle = { version: 1, records: allRecords, authority: bundle.authority }
  const rawDoc = local ? Automerge.merge(Automerge.clone(local), remote) : remote
  const rawBytes = Automerge.save(rawDoc)
  if (local) Automerge.free(rawDoc)
  const plan = await runWorkspaceAdmission({ workspaceId: remote.id,
    // Admission workers transfer input buffers. Keep the original raw union
    // alive for atomic persistence and replication after the worker returns.
    local: undefined, remote: rawBytes.slice(),
    authorization: combinedBundle, knownAuthority,
    now: Date.now(),
  })
  // Off-thread validation yields while control evidence can change. A result
  // verified against earlier rights cannot authorize a commit under new rights.
  const currentCredential = await incomingCredential(remote.id)
  if (canonicalizeJson(currentCredential) !== frozenCredential ||
    (currentCredential && meshRustRuntime().state.hasAuthorityConflict(currentCredential))) {
    throw new Error("Workspace authority changed during validation. Retry synchronization.")
  }
  return { ...plan, rawBytes, authorizationEvidence: plan.verifiedAuthorizations }
}

/** Persists only proofs that a completed admission has already verified. */
async function persistIncomingChangeAuthorizations(workspaceId: string, verified: unknown[]): Promise<boolean> {
  return putRecords(workspaceId, verified as Authorization[])
}

/** @deprecated Use validateIncomingChangeAuthorizations then persistIncomingChangeAuthorizations. */
export async function validateIncomingChangesWithProofStatus(local: Automerge.Doc<WorkspaceDocumentV2> | undefined, remote: Automerge.Doc<WorkspaceDocumentV2>, raw: unknown): Promise<boolean> {
  return persistIncomingChangeAuthorizations(remote.id, await validateIncomingChangeAuthorizations(local, remote, raw))
}
