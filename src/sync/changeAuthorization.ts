import * as Automerge from "@automerge/automerge/slim"
import { publicKeyId, signEnvelope, type LocalProfile } from "../domain/identity"
import type { WorkspaceDocumentV2, WorkspaceGrant, DeviceCertificate } from "../domain/model"
import { defaultProofStore } from "../domain/proofs"
import { peerStore, type WorkspaceAuthorityRecord, type WorkspaceMeshCredential } from "./peerStore"
import { type WorkspaceAuthority, type WorkspaceOwnershipTransfer,
  type WorkspaceSuccessionClaim, type WorkspaceDeviceRevocation } from "./meshRecords"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { putRecords, records, type WorkspaceChangeAuthorization } from "./workspaceChangeProofStore"
import { isDiscriminatorCleanup } from "./workspaceHistoryRepair"

import { assertWorkspaceCapability, assertWorkspaceTransition, type WorkspaceRole } from "../domain/permissions"
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
      const validated = meshRustRuntime().state.validateScopeAuthority(scope) as {
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

export async function recordGenesisAuthority(doc: Automerge.Doc<WorkspaceDocumentV2>, profile: LocalProfile): Promise<void> {
  const creator = { personId: profile.identity.personId, publicKey: profile.identity.publicKey,
    certificates: [profile.certificate] }
  const payload = meshRustRuntime().state.planScopeGenesis({ scopeId: doc.id,
    documentOwnerPersonId: doc.ownerPersonId, creator }) as {
    kind: "scope-genesis"; version: 1; scopeId: string; creator: typeof creator; controlEpoch: 1
  }
  if (typeof indexedDB === "undefined") return
  const genesis = await signEnvelope(profile.privateKeys.devicePrivateKey, payload, profile.device.deviceId)
  const scopeAuthoritySnapshot = { genesis, grants: [], grantIssuers: [], revocations: [], controlTransfers: [] }
  const validated = meshRustRuntime().state.validateScopeAuthority(scopeAuthoritySnapshot) as {
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
  if (hashes.length) await authorizeLocalChanges(doc, profile, hashes)
}

type Authorization = WorkspaceChangeAuthorization
type WorkspaceWriteAuthorityEvidence = {
  genesisOwner: WorkspaceAuthority
  genesisEpoch: number
  currentOwner: WorkspaceAuthority
  currentEpoch: number
  ownershipTransfers: WorkspaceOwnershipTransfer[]
  successionClaims: WorkspaceSuccessionClaim[]
  revocations: unknown[]
  deviceRevocations: Array<{ record: unknown; signer: WorkspaceAuthority }>
  departures: Array<{ record: unknown; authority: WorkspaceAuthority }>
}
type IncomingAuthorizationBundle = { version: 1; records: unknown[]; authority: WorkspaceWriteAuthorityEvidence }
type PendingHistoryRepair = { bytes: Uint8Array; hashes: string[]; authorization: Authorization[] }
const historyRepairs = new Map<string, PendingHistoryRepair>()

export function pendingHistoryRepair(workspaceId: string) {
  return historyRepairs.get(workspaceId)?.hashes.length ?? 0
}

export async function repairPendingHistory(workspaceId: string, profile: LocalProfile) {
  const pending = historyRepairs.get(workspaceId)
  if (!pending) throw new Error("No repairable history is pending")
  const doc = Automerge.load<WorkspaceDocumentV2>(pending.bytes)
  try {
    assertWorkspaceCapability(await workspaceRole(doc, profile), "history.repair")
    if (await workspaceWritesBlocked(workspaceId)) throw new Error("Workspace ownership is conflicted")
    for (let offset = 0; offset < pending.hashes.length; offset += 256) {
      await authorizeLocalChanges(doc, profile, pending.hashes.slice(offset, offset + 256))
    }
    const bundle = await exportAuthorizationBundle(pending.bytes, profile)
    return { bytes: pending.bytes, authorization: {
      ...bundle, records: [...pending.authorization, ...bundle.records],
    } }
  } finally { Automerge.free(doc) }
}

export async function workspaceRole(doc: WorkspaceDocumentV2, profile: LocalProfile): Promise<WorkspaceRole> {
  const stored = await storedWorkspaceAuthority(doc.id)
  if (stored.invalid) return "visitor"
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
  if (!authority || !genesisOwner) return "visitor"
  return decideWorkspaceRole(doc, profile, authority, genesisOwner)
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
  return meshRustRuntime().state.decideWorkspaceAccess({
    snapshot: {
      workspaceId: doc.id, genesisOwner, genesisEpoch: 1,
      expectedCurrentOwner: { personId: authority.ownerPersonId, publicKey: authority.ownerPublicKey,
        certificates: authority.ownerCertificates as DeviceCertificate[] },
      document: Array.from(Automerge.save(doc)),
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
  }, Date.now())
}

export async function effectiveWorkspaceOwner(workspaceId: string, genesisOwnerPersonId: string) {
  if (typeof indexedDB === "undefined") return genesisOwnerPersonId
  return (await storedWorkspaceAuthority(workspaceId)).authority?.ownerPersonId ?? genesisOwnerPersonId
}

export async function workspaceWritesBlocked(workspaceId: string) {
  if (typeof indexedDB === "undefined") return false
  const stored = await storedWorkspaceAuthority(workspaceId)
  return stored.invalid || Boolean(stored.authority && meshRustRuntime().state.hasAuthorityConflict(stored.authority))
}

function authorities(credential: StoredWorkspaceAuthority | null) {
  if (!credential) return []
  return [{ personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey,
    certificates: credential.ownerCertificates as DeviceCertificate[] },
  ...((credential.ownerHistory ?? []) as WorkspaceAuthority[])]
}

export async function authorizeLocalChanges(doc: Automerge.Doc<WorkspaceDocumentV2>, profile: LocalProfile, hashes: string[]) {
  const credential = typeof indexedDB === "undefined" ? undefined : (await storedWorkspaceAuthority(doc.id)).authority
  if (typeof indexedDB !== "undefined" && !credential) throw new Error("Workspace authority is unavailable. Import this board as a new board.")
  const ownerPersonId = credential?.ownerPersonId ?? doc.ownerPersonId
  const certificates = (await defaultProofStore.listCertificates()).filter(cert => cert.payload.personId === profile.identity.personId)
  if (!certificates.some(cert => cert.payload.deviceId === profile.device.deviceId)) certificates.push(profile.certificate)
  const signed = await signEnvelope(profile.privateKeys.devicePrivateKey, {
    kind: "workspace-changes" as const, version: 1 as const, workspaceId: doc.id, hashes,
    personId: profile.identity.personId, deviceId: profile.device.deviceId,
  }, profile.device.deviceId)
  await putRecords(doc.id, [{ signed, publicKey: profile.identity.publicKey, certificates,
    ...(profile.identity.personId !== ownerPersonId ? { grant: credential?.localGrant as WorkspaceGrant } : {}),
    ownerPublicKey: credential?.ownerPublicKey ?? profile.identity.publicKey,
    ownerCertificates: credential?.ownerCertificates as DeviceCertificate[] ?? certificates,
  }])
}
export async function exportAuthorizations(bytes: Uint8Array) {
  const doc = Automerge.load<WorkspaceDocumentV2>(bytes)
  return records(doc.id)
}

/**
 * Carries signed write proofs with the authority evidence Rust needs to admit
 * them. The receiver verifies this evidence before it uses any of it and does
 * not store it as a side effect of validation.
 */
export async function exportAuthorizationBundle(bytes: Uint8Array, knownProfile?: LocalProfile): Promise<IncomingAuthorizationBundle> {
  const doc = Automerge.load<WorkspaceDocumentV2>(bytes)
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
  return { version: 1, records: await exportAuthorizations(bytes), authority: evidence }
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
  if (!bundle || bundle.version !== 1 || !Array.isArray(bundle.records) || !bundle.authority) {
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

function rejectUnsignedChanges(remote: Automerge.Doc<WorkspaceDocumentV2>, unsigned: Automerge.DecodedChange[],
  verified: Authorization[], message: string): void {
  if (!unsigned.length) return
  historyRepairs.delete(remote.id)
  if (unsigned.every(change => isDiscriminatorCleanup(remote, change))) {
    if (historyRepairs.size >= 64) historyRepairs.delete(historyRepairs.keys().next().value!)
    historyRepairs.set(remote.id, { bytes: Automerge.save(remote), hashes: unsigned.map(change => change.hash), authorization: verified })
  }
  throw new WorkspaceChangeRejected(message)
}

export async function validateIncomingChanges(local: Automerge.Doc<WorkspaceDocumentV2> | undefined, remote: Automerge.Doc<WorkspaceDocumentV2>, raw: unknown): Promise<void> {
  await validateIncomingChangeAuthorizations(local, remote, raw)
}

/** Validation is deliberately side-effect free so callers can reject an entire
 * enrollment batch before a workspace, proof, or authority record is written. */
export async function validateIncomingChangeAuthorizations(local: Automerge.Doc<WorkspaceDocumentV2> | undefined,
  remote: Automerge.Doc<WorkspaceDocumentV2>, raw: unknown): Promise<Authorization[]> {
  const credential = await incomingCredential(remote.id)
  if (credential && meshRustRuntime().state.hasAuthorityConflict(credential)) throw new Error("Workspace writes paused: conflicting ownership records")
  const unnormalizedBundle = authorizationBundle(raw)
  const bundle = { ...unnormalizedBundle, authority: normalizeAuthorityDepartures(unnormalizedBundle.authority) }
  const authority = meshRustRuntime().state.prepareWriteEvidence({ incoming: bundle.authority,
    known: local ? workspaceWriteAuthorityEvidence(local, credential) ?? null : null,
    records: bundle.records, genesisPersonId: local?.ownerPersonId ?? remote.ownerPersonId,
    remoteOwnerPersonId: remote.ownerPersonId }) as WorkspaceWriteAuthorityEvidence
  if (bundle.records.length > 20000 || new TextEncoder().encode(JSON.stringify(bundle)).length > 16 * 1024 * 1024) throw new Error("The peer needs an update: missing write authorizations")
  const knownHashes = local ? Automerge.getAllChanges(local).map(change => Automerge.decodeChange(change).hash) : []
  const changes = Automerge.getAllChanges(remote).map(change => Automerge.decodeChange(change))
  const snapshot = {
    workspaceId: remote.id,
    genesisOwner: authority.genesisOwner,
    genesisEpoch: authority.genesisEpoch,
    expectedCurrentOwner: authority.currentOwner,
    // Known local transition heads must remain available while Rust verifies a
    // stale peer's earlier history; never let incoming evidence erase them.
    document: Array.from(Automerge.save(local ? Automerge.merge(Automerge.clone(local), remote) : remote)),
    ownershipTransfers: authority.ownershipTransfers,
    successionClaims: authority.successionClaims,
    revocations: authority.revocations,
    deviceRevocations: authority.deviceRevocations,
    departures: authority.departures,
  }
  const plan = meshRustRuntime().state.planChangeAdmissionFlow({
    records: bundle.records,
    knownHashes,
    changes: changes.map(change => ({ hash: change.hash, dependencies: change.deps, actor: change.actor,
      message: change.message ?? "" })),
    snapshot,
  }, Date.now()) as {
    neededHashes: string[]
    verifiedAuthorizations: Authorization[]
    admittedChanges: Array<{ hash: string }>
    editorChanges: Array<{ hash: string; dependencies: string[] }>
    unsignedChanges: Array<{ hash: string }>
    unsignedError?: string | null
  }
  for (const change of plan.editorChanges) {
    assertWorkspaceTransition("editor", Automerge.view(remote, change.dependencies), Automerge.view(remote, [change.hash]))
  }
  const decodedByHash = new Map(changes.map(change => [change.hash, change]))
  const unsigned = plan.unsignedChanges.map(change => decodedByHash.get(change.hash)!)
  rejectUnsignedChanges(remote, unsigned, plan.verifiedAuthorizations, plan.unsignedError ?? "Unsigned workspace change rejected")
  const pending = historyRepairs.get(remote.id)
  const admittedHashes = new Set(plan.admittedChanges.map(change => change.hash))
  if (pending?.hashes.every(hash => plan.neededHashes.includes(hash) && admittedHashes.has(hash))) historyRepairs.delete(remote.id)
  return plan.verifiedAuthorizations
}

/** Persists only proofs that a completed admission has already verified. */
export async function persistIncomingChangeAuthorizations(workspaceId: string, verified: unknown[]): Promise<boolean> {
  return putRecords(workspaceId, verified as Authorization[])
}

/** @deprecated Use validateIncomingChangeAuthorizations then persistIncomingChangeAuthorizations. */
export async function validateIncomingChangesWithProofStatus(local: Automerge.Doc<WorkspaceDocumentV2> | undefined, remote: Automerge.Doc<WorkspaceDocumentV2>, raw: unknown): Promise<boolean> {
  return persistIncomingChangeAuthorizations(remote.id, await validateIncomingChangeAuthorizations(local, remote, raw))
}
