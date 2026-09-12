import * as Automerge from "@automerge/automerge/slim"
import { bootstrapIdentity, signEnvelope, verifyEnvelope, type LocalProfile, type SignedEnvelope } from "../domain/identity"
import type { WorkspaceDocumentV2, WorkspaceGrant, DeviceCertificate } from "../domain/model"
import { defaultProofStore } from "../domain/proofs"
import { peerStore } from "./peerStore"
import { verifyDeviceChain, verifyWorkspaceGrant, type WorkspaceAuthority, type WorkspaceOwnershipTransfer,
  type WorkspaceSuccessionClaim } from "./meshRecords"

import { assertWorkspaceTransition, type WorkspaceRole } from "../domain/permissions"
type Authorization = {
  signed: SignedEnvelope<{ kind: "workspace-changes"; version: 1; workspaceId: string; hashes: string[]; personId: string; deviceId: string }>
  publicKey: string
  certificates: DeviceCertificate[]
  grant?: WorkspaceGrant
  ownerPublicKey: string
  ownerCertificates: DeviceCertificate[]
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
  const credential = typeof indexedDB === "undefined" ? null : await peerStore.getWorkspaceCredential(doc.id)
  if ((credential?.ownerPersonId ?? doc.ownerPersonId) === profile.identity.personId) return "owner"
  if (!credential) return "visitor"
  const grant = credential?.localGrant as WorkspaceGrant | undefined
  if (!grant || grant.payload.personId !== profile.identity.personId || grant.payload.workspaceId !== doc.id) return "visitor"
  if ((await peerStore.listPeers(doc.id)).some(peer => peer.personId === profile.identity.personId && peer.revokedAt)) return "visitor"
  return grant.payload.role === "editor" ? "editor" : "visitor"
}

export async function effectiveWorkspaceOwner(workspaceId: string, genesisOwnerPersonId: string) {
  if (typeof indexedDB === "undefined") return genesisOwnerPersonId
  return (await peerStore.getWorkspaceCredential(workspaceId))?.ownerPersonId ?? genesisOwnerPersonId
}

function hasSuccessionConflict(credential: Awaited<ReturnType<typeof peerStore.getWorkspaceCredential>>) {
  const claims = ((credential?.catalog as { successionClaims?: WorkspaceSuccessionClaim[] } | undefined)?.successionClaims ?? [])
    .filter(claim => claim?.payload?.epoch === credential?.epoch)
  return new Set(claims.map(claim => claim.payload.toOwnerPersonId)).size > 1
}

export async function workspaceWritesBlocked(workspaceId: string) {
  if (typeof indexedDB === "undefined") return false
  return hasSuccessionConflict(await peerStore.getWorkspaceCredential(workspaceId))
}

function authorities(credential: Awaited<ReturnType<typeof peerStore.getWorkspaceCredential>>) {
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

function historicalOwnerHashes(remote: Automerge.Doc<WorkspaceDocumentV2>, transfers: Array<WorkspaceOwnershipTransfer | WorkspaceSuccessionClaim>) {
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
  const credential = typeof indexedDB === "undefined" ? undefined : await peerStore.getWorkspaceCredential(doc.id)
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
  const credential = typeof indexedDB === "undefined" ? null : await peerStore.getWorkspaceCredential(doc.id)
  if (missing.length && (credential?.ownerPersonId ?? doc.ownerPersonId) === profile.identity.personId) {
    for (let offset = 0; offset < missing.length; offset += 256) await authorizeLocalChanges(doc, profile, missing.slice(offset, offset + 256))
  }
  return records(doc.id)
}
export async function validateIncomingChanges(local: Automerge.Doc<WorkspaceDocumentV2> | undefined, remote: Automerge.Doc<WorkspaceDocumentV2>, raw: unknown) {
  const credential = await peerStore.getWorkspaceCredential(remote.id)
  if (hasSuccessionConflict(credential)) throw new Error("Workspace writes paused: conflicting ownership recovery claims")
  const genesisOwner = local?.ownerPersonId ?? remote.ownerPersonId
  if (!genesisOwner || remote.ownerPersonId !== genesisOwner) throw new Error("Untrusted workspace owner")
  const expectedOwner = credential?.ownerPersonId ?? genesisOwner
  const ownerSet = authorities(credential)
  const catalog = credential?.catalog as { ownershipTransfers?: WorkspaceOwnershipTransfer[]; successionClaims?: WorkspaceSuccessionClaim[] } | undefined
  const transfers = [...(catalog?.ownershipTransfers ?? []), ...(catalog?.successionClaims ?? [])]
  const historicalHashes = historicalOwnerHashes(remote, transfers)
  if (!Array.isArray(raw) || raw.length > 20000 || new TextEncoder().encode(JSON.stringify(raw)).length > 16 * 1024 * 1024) throw new Error("The peer needs an update: missing write authorizations")
  const known = new Set(local ? Automerge.getAllChanges(local).map(change => Automerge.decodeChange(change).hash) : [])
  const changes = Automerge.getAllChanges(remote).filter(change => !known.has(Automerge.decodeChange(change).hash))
  const needed = new Set(changes.map(change => Automerge.decodeChange(change).hash))
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
      if ((await peerStore.listPeers(remote.id)).some(peer => peer.personId === p.personId && peer.revokedAt)) throw new Error("Workspace access revoked")
      role = grantRole === "editor" ? "editor" : "owner"
    }
    for (const hash of p.hashes) {
      const hashRole = role === "owner" && p.personId !== expectedOwner && !historicalHashes.get(p.personId)?.has(hash)
        ? undefined : role
      if (hashRole && allowed.get(hash) !== "owner") allowed.set(hash, hashRole)
    }
    verified.push(record)
  }
  for (const change of changes) {
    const decoded = Automerge.decodeChange(change)
    const role = allowed.get(decoded.hash)
    if (!role) throw new Error("Unsigned workspace change rejected")
    if (role === "editor") {
      if (!decoded.deps.length) throw new Error("Only the owner can create a workspace")
      assertWorkspaceTransition("editor", Automerge.view(remote, decoded.deps), Automerge.view(remote, [decoded.hash]))
    }
  }
  await putRecords(remote.id, verified)
}
