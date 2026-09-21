import * as Automerge from "@automerge/automerge/slim"
import { bootstrapIdentity, canonicalizeJson, publicKeyId, signEnvelope, verifyEnvelope, type LocalProfile, type SignedEnvelope } from "../domain/identity"
import { isItem } from "../domain/model"
import type { WorkspaceDocumentV2, WorkspaceGrant, DeviceCertificate } from "../domain/model"
import { defaultProofStore } from "../domain/proofs"
import { peerStore, type WorkspaceAuthorityRecord, type WorkspaceMeshCredential } from "./peerStore"
import { loadChat } from "../chat/service"
import type { ChatRecord } from "../chat/records"
import { hasConflictingOwnershipTransfers, verifyDeviceChain, verifyWorkspaceGrant, type WorkspaceAuthority, type WorkspaceOwnershipTransfer,
  type WorkspaceSuccessionClaim } from "./meshRecords"
import type { WorkspaceBreakGlassClaim } from "./meshRecords"

import { assertWorkspaceCapability, assertWorkspaceTransition, type WorkspaceRole } from "../domain/permissions"
export class WorkspaceChangeRejected extends Error {
  constructor(message: string) { super(message); this.name = "WorkspaceChangeRejected" }
}

type StoredWorkspaceAuthority = WorkspaceMeshCredential | WorkspaceAuthorityRecord

async function storedWorkspaceAuthority(workspaceId: string): Promise<{ authority: StoredWorkspaceAuthority | null; invalid: boolean }> {
  try {
    const credential = await peerStore.getWorkspaceCredential(workspaceId)
    if (credential) return { authority: credential, invalid: false }
    return { authority: await peerStore.getWorkspaceAuthority(workspaceId), invalid: false }
  } catch {
    return { authority: null, invalid: typeof indexedDB !== "undefined" }
  }
}

function uniqueCertificates(profile: LocalProfile, certificates: DeviceCertificate[]) {
  const values = [profile.certificate, ...certificates].filter(certificate =>
    certificate?.payload?.personId === profile.identity.personId)
  return [...new Map(values.map(certificate => [certificate.signature, certificate])).values()]
}

async function recoverWorkspaceAuthority(doc: WorkspaceDocumentV2, profile: LocalProfile): Promise<StoredWorkspaceAuthority | null> {
  const stored = await storedWorkspaceAuthority(doc.id)
  if (stored.authority || stored.invalid) return stored.authority
  if (typeof indexedDB === "undefined") return null

  const grants = (await defaultProofStore.listGrants(doc.id))
    .filter(grant => grant.payload.personId === profile.identity.personId)
  const profiles = await loadChat(doc.id).then(snapshot => snapshot.profiles).catch(() => [])
  const candidates = new Map<string, WorkspaceAuthority>()
  const rememberAuthority = async (publicKey: string | undefined, certificates: DeviceCertificate[] | undefined) => {
    if (!publicKey || !Array.isArray(certificates)) return
    try {
      const personId = await publicKeyId(publicKey)
      candidates.set(personId, { personId, publicKey, certificates })
    } catch {}
  }
  for (const profileRecord of profiles) {
    const authority = (profileRecord.record as ChatRecord | undefined)?.authority
    await rememberAuthority(authority?.publicKey, authority?.certificates)
  }
  for (const authorization of await records(doc.id).catch(() => [])) {
    await rememberAuthority(authorization.ownerPublicKey, authorization.ownerCertificates)
  }

  const verified: Array<{ authority: WorkspaceAuthority; grant: WorkspaceGrant }> = []
  for (const grant of grants) for (const authority of candidates.values()) {
    try {
      await verifyWorkspaceGrant(grant, {
        workspaceId: doc.id,
        personId: profile.identity.personId,
        ownerPersonId: authority.personId,
        ownerPublicKey: authority.publicKey,
        ownerCertificates: authority.certificates,
      })
      verified.push({ authority, grant })
    } catch {}
  }

  // A grant signed by another verified identity proves that genesis ownership moved.
  // Multiple foreign owners are ambiguous without the missing transfer chain: remain read-only.
  const foreign = [...new Map(verified
    .filter(item => item.authority.personId !== profile.identity.personId)
    .map(item => [item.authority.personId, item])).values()]
  if (foreign.length === 1) {
    const item = foreign[0]!
    const recovered: WorkspaceAuthorityRecord = {
      version: 1,
      workspaceId: doc.id,
      genesisOwnerPersonId: doc.ownerPersonId,
      ownerPersonId: item.authority.personId,
      ownerPublicKey: item.authority.publicKey,
      ownerCertificates: item.authority.certificates,
      ownerHistory: doc.ownerPersonId === profile.identity.personId
        ? [{ personId: profile.identity.personId, publicKey: profile.identity.publicKey,
            certificates: uniqueCertificates(profile, await defaultProofStore.listCertificates()) }]
        : [],
      localGrant: item.grant,
      epoch: 1,
      updatedAt: new Date().toISOString(),
      catalog: {},
    }
    await peerStore.putWorkspaceAuthority(recovered)
    return recovered
  }

  const certificatePool = await defaultProofStore.listCertificates()
  const hasForeignGrantEvidence = grants.some(grant => certificatePool.some(certificate =>
    certificate.payload.deviceId === grant.signerKeyId && certificate.payload.personId !== profile.identity.personId))
  if (hasForeignGrantEvidence || doc.ownerPersonId !== profile.identity.personId || !profile.privateKeys.identityPrivateKey) return null
  const recovered: WorkspaceAuthorityRecord = {
    version: 1,
    workspaceId: doc.id,
    genesisOwnerPersonId: doc.ownerPersonId,
    ownerPersonId: profile.identity.personId,
    ownerPublicKey: profile.identity.publicKey,
    ownerCertificates: uniqueCertificates(profile, certificatePool),
    epoch: 1,
    updatedAt: new Date().toISOString(),
    catalog: {},
  }
  await peerStore.putWorkspaceAuthority(recovered)
  return recovered
}

type Authorization = {
  signed: SignedEnvelope<{ kind: "workspace-changes"; version: 1; workspaceId: string; hashes: string[]; personId: string; deviceId: string }>
  publicKey: string
  certificates: DeviceCertificate[]
  grant?: WorkspaceGrant
  ownerPublicKey: string
  ownerCertificates: DeviceCertificate[]
}
type PendingHistoryRepair = { bytes: Uint8Array; hashes: string[]; authorization: Authorization[] }
const historyRepairs = new Map<string, PendingHistoryRepair>()

function isDiscriminatorCleanup(doc: Automerge.Doc<WorkspaceDocumentV2>, change: Automerge.DecodedChange) {
  if (!change.deps.length || !change.ops.length) return false
  const before = Automerge.view(doc, change.deps)
  const expected = JSON.parse(JSON.stringify(before)) as WorkspaceDocumentV2
  const itemObjects = new Map(Object.values(before.entities).filter(isItem).map(item => [Automerge.getObjectId(item), item.id]))
  for (const op of change.ops) {
    if (op.action !== "del" || op.key !== "kind" || !itemObjects.has(op.obj)) return false
    const id = itemObjects.get(op.obj)!
    if (!["task", "item"].includes((before.entities[id] as any).kind)) return false
    delete (expected.entities[id] as any).kind
  }
  return canonicalizeJson(expected) === canonicalizeJson(Automerge.view(doc, [change.hash]))
}

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
    return { bytes: pending.bytes, authorization: [...pending.authorization, ...await records(workspaceId)] }
  } finally { Automerge.free(doc) }
}

let dbPromise: Promise<IDBDatabase> | undefined
const memory = new Map<string, Authorization[]>()
function database() {
  return dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("match-write-authorizations-v1", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("records")
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function records(id: string): Promise<Authorization[]> {
  if (typeof indexedDB === "undefined") return memory.get(id) ?? []
  const db = await database()
  return new Promise((resolve, reject) => {
    const request = db.transaction("records").objectStore("records").get(id)
    request.onsuccess = () => resolve(request.result ?? [])
    request.onerror = () => reject(request.error)
  })
}
async function putRecords(id: string, incoming: Authorization[]) {
  const merge = (existing: Authorization[]) => [...new Map([...existing, ...incoming].map(record => [record.signed.signature, record])).values()]
  if (typeof indexedDB === "undefined") { memory.set(id, merge(memory.get(id) ?? [])); return }
  const db = await database()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("records", "readwrite")
    const store = tx.objectStore("records")
    const get = store.get(id)
    get.onsuccess = () => store.put(merge(get.result ?? []), id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}
export async function workspaceRole(doc: WorkspaceDocumentV2, profile: LocalProfile): Promise<WorkspaceRole> {
  const authority = await recoverWorkspaceAuthority(doc, profile)
  if (authority?.ownerPersonId === profile.identity.personId && authority.ownerPublicKey === profile.identity.publicKey) return "owner"
  if (!authority && typeof indexedDB === "undefined" && doc.ownerPersonId === profile.identity.personId) return "owner"
  if (!authority) return "visitor"
  const grant = authority.localGrant as WorkspaceGrant | undefined
  if (!grant || grant.payload.personId !== profile.identity.personId || grant.payload.workspaceId !== doc.id) return "visitor"
  const revoked = ((authority.catalog as { revocations?: Array<{ payload?: { personId?: string } }> } | undefined)?.revocations ?? [])
    .some(record => record?.payload?.personId === profile.identity.personId)
  if (revoked || (await peerStore.listPeers(doc.id)).some(peer => peer.personId === profile.identity.personId && peer.revokedAt)) return "visitor"
  for (const owner of authorities(authority)) {
    try {
      const role = await verifiedGrantRole(grant, doc.id, profile.identity.personId, [owner])
      if (role) return role === "editor" ? "editor" : "visitor"
    } catch {}
  }
  return "visitor"
}

export async function effectiveWorkspaceOwner(workspaceId: string, genesisOwnerPersonId: string) {
  if (typeof indexedDB === "undefined") return genesisOwnerPersonId
  return (await storedWorkspaceAuthority(workspaceId)).authority?.ownerPersonId ?? genesisOwnerPersonId
}

function hasAuthorityConflict(credential: StoredWorkspaceAuthority | null) {
  const claims = ((credential?.catalog as { successionClaims?: WorkspaceSuccessionClaim[] } | undefined)?.successionClaims ?? [])
    .filter(claim => claim?.payload?.epoch === credential?.epoch)
  const transfers = ((credential?.catalog as { ownershipTransfers?: WorkspaceOwnershipTransfer[] } | undefined)?.ownershipTransfers ?? [])
  const breakGlass = ((credential?.catalog as { breakGlassClaims?: WorkspaceBreakGlassClaim[] } | undefined)?.breakGlassClaims ?? [])
    .filter(claim => claim?.payload?.kind === "workspace-break-glass")
  const recoveryTargets = new Map<string, Set<string>>()
  for (const claim of breakGlass) {
    const key = `${claim.payload.fromOwnerPersonId}:${claim.payload.epoch}`
    const targets = recoveryTargets.get(key) ?? new Set<string>()
    targets.add(claim.payload.toOwnerPersonId)
    recoveryTargets.set(key, targets)
  }
  return new Set(claims.map(claim => claim.payload.toOwnerPersonId)).size > 1 ||
    [...recoveryTargets.values()].some(targets => targets.size > 1) || hasConflictingOwnershipTransfers(transfers)
}

export async function workspaceWritesBlocked(workspaceId: string) {
  if (typeof indexedDB === "undefined") return false
  const stored = await storedWorkspaceAuthority(workspaceId)
  return stored.invalid || hasAuthorityConflict(stored.authority)
}

function authorities(credential: StoredWorkspaceAuthority | null) {
  if (!credential) return []
  return [{ personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey,
    certificates: credential.ownerCertificates as DeviceCertificate[] },
  ...((credential.ownerHistory ?? []) as WorkspaceAuthority[])]
}

async function verifiedGrantRole(grant: WorkspaceGrant | undefined, workspaceId: string, personId: string,
  owners: WorkspaceAuthority[]): Promise<WorkspaceRole | undefined> {
  for (const owner of owners) {
    try {
      return await verifyWorkspaceGrant(grant, { workspaceId, personId, ownerPersonId: owner.personId,
        ownerPublicKey: owner.publicKey, ownerCertificates: owner.certificates })
    } catch {}
  }
  if (grant) throw new Error("Invalid workspace grant signature")
}

function authoritiesWithEmbeddedCertificates(owners: WorkspaceAuthority[], record: Authorization): WorkspaceAuthority[] {
  if (!Array.isArray(record.ownerCertificates) || record.ownerCertificates.length > 32) return owners
  return owners.map(owner => {
    if (owner.publicKey !== record.ownerPublicKey) return owner
    const certificates = [...new Map([...owner.certificates, ...record.ownerCertificates]
      .map(certificate => [certificate.signature, certificate])).values()]
    return { ...owner, certificates }
  })
}

function historicalOwnerHashes(remote: Automerge.Doc<WorkspaceDocumentV2>, transfers: Array<WorkspaceOwnershipTransfer | WorkspaceSuccessionClaim | WorkspaceBreakGlassClaim>) {
  const changes = Automerge.getAllChanges(remote).map(change => Automerge.decodeChange(change))
  const byHash = new Map(changes.map(change => [change.hash, change]))
  const result = new Map<string, Set<string>>()
  for (const transfer of transfers) {
    const personId = transfer?.payload?.fromOwnerPersonId
    const heads = transfer?.payload?.workspaceHeads
    if (!personId || !Array.isArray(heads)) continue
    const allowed = result.get(personId) ?? new Set<string>()
    const queue = [...heads]
    while (queue.length) {
      const hash = queue.pop()!
      if (allowed.has(hash)) continue
      allowed.add(hash)
      for (const dep of byHash.get(hash)?.deps ?? []) queue.push(dep)
    }
    result.set(personId, allowed)
  }
  return result
}
export async function authorizeLocalChanges(doc: Automerge.Doc<WorkspaceDocumentV2>, profile: LocalProfile, hashes: string[]) {
  const credential = typeof indexedDB === "undefined" ? undefined : await recoverWorkspaceAuthority(doc, profile)
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
  const profile = await bootstrapIdentity("My Device")
  const existing = await records(doc.id)
  const covered = new Set(existing.flatMap(record => record.signed.payload.hashes))
  const missing = Automerge.getAllChanges(doc).map(change => Automerge.decodeChange(change).hash).filter(hash => !covered.has(hash))
  // The owner checkpoints pre-permission history. Editors cannot bless legacy changes.
  const authority = typeof indexedDB === "undefined" ? null : (await storedWorkspaceAuthority(doc.id)).authority
  if (missing.length && (authority?.ownerPersonId ?? doc.ownerPersonId) === profile.identity.personId) {
    for (let offset = 0; offset < missing.length; offset += 256) await authorizeLocalChanges(doc, profile, missing.slice(offset, offset + 256))
  }
  return records(doc.id)
}
export async function validateIncomingChanges(local: Automerge.Doc<WorkspaceDocumentV2> | undefined, remote: Automerge.Doc<WorkspaceDocumentV2>, raw: unknown) {
  let credential: StoredWorkspaceAuthority | null = null
  try {
    credential = (await storedWorkspaceAuthority(remote.id)).authority
  } catch (error) {
    if (typeof indexedDB !== "undefined" || !/IndexedDB is not available/i.test(error instanceof Error ? error.message : String(error))) throw error
  }
  if (hasAuthorityConflict(credential)) throw new Error("Workspace writes paused: conflicting ownership records")
  const genesisOwner = local?.ownerPersonId ?? remote.ownerPersonId
  if (!genesisOwner || remote.ownerPersonId !== genesisOwner) throw new Error("Untrusted workspace owner")
  const expectedOwner = credential?.ownerPersonId ?? genesisOwner
  const ownerSet = authorities(credential)
  const catalog = credential?.catalog as { ownershipTransfers?: WorkspaceOwnershipTransfer[]; successionClaims?: WorkspaceSuccessionClaim[]
    breakGlassClaims?: WorkspaceBreakGlassClaim[] } | undefined
  const transfers = [...(catalog?.ownershipTransfers ?? []), ...(catalog?.successionClaims ?? []),
    ...(catalog?.breakGlassClaims ?? []).filter(claim => claim?.payload?.kind === "workspace-break-glass")]
  const historicalHashes = historicalOwnerHashes(remote, transfers)
  if (!Array.isArray(raw) || raw.length > 20000 || new TextEncoder().encode(JSON.stringify(raw)).length > 16 * 1024 * 1024) throw new Error("The peer needs an update: missing write authorizations")
  const known = new Set(local ? Automerge.getAllChanges(local).map(change => Automerge.decodeChange(change).hash) : [])
  const changes = Automerge.getAllChanges(remote).filter(change => !known.has(Automerge.decodeChange(change).hash))
  // Proofs must propagate even when this replica already has the corresponding changes.
  const needed = new Set(Automerge.getAllChanges(remote).map(change => Automerge.decodeChange(change).hash))
  const allowed = new Map<string, WorkspaceRole>()
  const verified: Authorization[] = []
  for (const record of raw as Authorization[]) {
    const p = record?.signed?.payload
    if (!p || !Array.isArray(p.hashes) || p.hashes.length > 256 || !p.hashes.some(hash => needed.has(hash))) continue
    if (p.kind !== "workspace-changes" || p.version !== 1 || p.workspaceId !== remote.id || record.signed.signerKeyId !== p.deviceId) throw new Error("Invalid write authorization")
    const key = await verifyDeviceChain({ personId: p.personId, publicKey: record.publicKey, deviceId: p.deviceId, certificates: record.certificates })
    if (!await verifyEnvelope(record.signed, key)) throw new Error("Invalid write signature")
    let role: WorkspaceRole = "owner"
    if (p.personId !== expectedOwner) {
      const storedOwners = ownerSet.length ? ownerSet : [{ personId: expectedOwner,
        publicKey: record.ownerPublicKey, certificates: record.ownerCertificates }]
      const grantOwners = authoritiesWithEmbeddedCertificates(storedOwners, record)
      const grantRole = await verifiedGrantRole(record.grant, remote.id, p.personId, grantOwners)
      const historical = historicalHashes.get(p.personId)
      if (grantRole !== "editor" && !historical) throw new Error("Visitors cannot write workspace changes")
      let revoked = false
      try {
        revoked = (await peerStore.listPeers(remote.id)).some(peer => peer.personId === p.personId && peer.revokedAt)
      } catch (error) {
        if (typeof indexedDB !== "undefined" || !/IndexedDB is not available/i.test(error instanceof Error ? error.message : String(error))) throw error
      }
      if (revoked) throw new Error("Workspace access revoked")
      role = grantRole === "editor" ? "editor" : "owner"
    }
    for (const hash of p.hashes) {
      const hashRole = role === "owner" && p.personId !== expectedOwner && !historicalHashes.get(p.personId)?.has(hash)
        ? undefined : role
      if (hashRole && allowed.get(hash) !== "owner") allowed.set(hash, hashRole)
    }
    verified.push(record)
  }
  const unsigned = changes.map(change => Automerge.decodeChange(change)).filter(change => !allowed.has(change.hash))
  for (const change of changes) {
    const decoded = Automerge.decodeChange(change)
    const role = allowed.get(decoded.hash)
    if (role === "editor") {
      if (!decoded.deps.length) throw new Error("Only the owner can create a workspace")
      assertWorkspaceTransition("editor", Automerge.view(remote, decoded.deps), Automerge.view(remote, [decoded.hash]))
    }
  }
  if (unsigned.length) {
    historyRepairs.delete(remote.id)
    if (unsigned.every(change => isDiscriminatorCleanup(remote, change))) {
      if (historyRepairs.size >= 64) historyRepairs.delete(historyRepairs.keys().next().value!)
      historyRepairs.set(remote.id, { bytes: Automerge.save(remote), hashes: unsigned.map(change => change.hash), authorization: verified })
    }
    const decoded = unsigned[0]!
    throw new WorkspaceChangeRejected(`Unsigned workspace change rejected: ${decoded.hash} (actor ${decoded.actor}, ${decoded.message || "no change message"})`)
  }
  await putRecords(remote.id, verified)
  const pending = historyRepairs.get(remote.id)
  if (pending?.hashes.every(hash => needed.has(hash) && allowed.has(hash))) historyRepairs.delete(remote.id)
}
