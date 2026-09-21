import type { DeviceCertificate } from "../domain/model"
import {
  verifyWorkspaceBreakGlassClaim,
  type WorkspaceAuthority,
  type WorkspaceBreakGlassClaim,
} from "./meshRecords"
import type { WorkspaceMeshCredential } from "./peerStore"

export type BreakGlassHost = {
  getProfile: () => Promise<{ identity: { personId: string } }>
  claims: (credential: WorkspaceMeshCredential) => WorkspaceBreakGlassClaim[]
  catalog: (credential: WorkspaceMeshCredential) => Record<string, unknown>
  authorities: (credential: WorkspaceMeshCredential) => WorkspaceAuthority[]
  revokedPeople: (credential: WorkspaceMeshCredential) => Set<string>
  conflict: (claims: WorkspaceBreakGlassClaim[]) => boolean
  putCredential: (credential: WorkspaceMeshCredential) => Promise<void>
  transferCredential: (previousOwner: string, credential: WorkspaceMeshCredential) => Promise<void>
}

function ordered(records: Map<string, WorkspaceBreakGlassClaim>) {
  return [...records.values()].sort((a, b) => a.payload.epoch - b.payload.epoch || a.signature.localeCompare(b.signature))
}

async function retainHistorical(host: BreakGlassHost, credential: WorkspaceMeshCredential,
  known: Map<string, WorkspaceBreakGlassClaim>, accepted: Map<string, WorkspaceBreakGlassClaim>): Promise<boolean> {
  let changed = false
  for (const value of known.values()) {
    if (accepted.has(value.signature) || (value.payload?.epoch ?? 0) > credential.epoch) continue
    const authority = host.authorities(credential).find(owner => owner.personId === value.payload?.fromOwnerPersonId)
    if (!authority) continue
    const record = await verifyWorkspaceBreakGlassClaim(value, credential.workspaceId, authority,
      value.payload.epoch - 1, host.authorities(credential))
    accepted.set(record.signature, record)
    changed = true
  }
  return changed
}

async function persistClaims(host: BreakGlassHost, credential: WorkspaceMeshCredential,
  accepted: Map<string, WorkspaceBreakGlassClaim>): Promise<WorkspaceMeshCredential> {
  const next = { ...credential, catalog: { ...host.catalog(credential), breakGlassClaims: ordered(accepted) } }
  await host.putCredential(next)
  return next
}

function nextClaims(credential: WorkspaceMeshCredential, known: Map<string, WorkspaceBreakGlassClaim>) {
  return [...known.values()].filter(value => value.payload?.epoch === credential.epoch + 1 &&
    value.payload.fromOwnerPersonId === credential.ownerPersonId).sort((a, b) => a.signature.localeCompare(b.signature))
}

async function verifyCandidates(host: BreakGlassHost, credential: WorkspaceMeshCredential,
  candidates: WorkspaceBreakGlassClaim[], accepted: Map<string, WorkspaceBreakGlassClaim>): Promise<WorkspaceBreakGlassClaim[]> {
  const authority: WorkspaceAuthority = { personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey,
    certificates: credential.ownerCertificates as DeviceCertificate[] }
  const verified: WorkspaceBreakGlassClaim[] = []
  for (const value of candidates) {
    const record = await verifyWorkspaceBreakGlassClaim(value, credential.workspaceId, authority, credential.epoch,
      host.authorities(credential))
    if (host.revokedPeople(credential).has(record.payload.toOwnerPersonId)) throw new Error("New owner access is revoked")
    accepted.set(record.signature, record)
    verified.push(record)
  }
  return verified
}

async function adoptClaim(host: BreakGlassHost, credential: WorkspaceMeshCredential, record: WorkspaceBreakGlassClaim,
  accepted: Map<string, WorkspaceBreakGlassClaim>): Promise<WorkspaceMeshCredential> {
  const payload = record.payload
  const profile = await host.getProfile()
  const authority: WorkspaceAuthority = { personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey,
    certificates: credential.ownerCertificates as DeviceCertificate[] }
  const history = [...((credential.ownerHistory ?? []) as WorkspaceAuthority[])]
  if (!history.some(owner => owner.personId === authority.personId)) history.push(authority)
  const withoutGrant = { ...credential }
  delete withoutGrant.localGrant
  const next: WorkspaceMeshCredential = {
    ...withoutGrant,
    ...(profile.identity.personId === payload.toOwnerPersonId ? {} : credential.localGrant ? { localGrant: credential.localGrant } : {}),
    ownerPersonId: payload.toOwnerPersonId,
    ownerPublicKey: payload.toOwnerPublicKey,
    ownerCertificates: payload.toOwnerCertificates,
    ownerHistory: history,
    epoch: payload.epoch,
    updatedAt: payload.claimedAt,
    catalog: { ...host.catalog(credential), breakGlassClaims: ordered(accepted), successionPolicy: undefined, successionVotes: [] },
  }
  await host.transferCredential(credential.ownerPersonId, next)
  return next
}

export async function mergeBreakGlassClaims(host: BreakGlassHost, initial: WorkspaceMeshCredential,
  raw: WorkspaceBreakGlassClaim[]): Promise<WorkspaceMeshCredential> {
  let credential = initial
  const known = new Map(host.claims(credential).map(record => [record.signature, record]))
  for (const record of raw) if (record?.signature) known.set(record.signature, record)
  const accepted = new Map(host.claims(credential).map(record => [record.signature, record]))
  let dirty = await retainHistorical(host, credential, known, accepted)
  if (host.conflict(ordered(accepted))) return persistClaims(host, credential, accepted)
  while (true) {
    const candidates = nextClaims(credential, known)
    if (!candidates.length) break
    const verified = await verifyCandidates(host, credential, candidates, accepted)
    if (host.conflict(verified)) return persistClaims(host, credential, accepted)
    credential = await adoptClaim(host, credential, verified[0]!, accepted)
    dirty = false
  }
  return dirty ? persistClaims(host, credential, accepted) : credential
}
