import type { DeviceCertificate } from "../domain/model"
import type { LocalProfile } from "../domain/identity"
import {
  verifyWorkspaceSuccessionClaim,
  verifyWorkspaceSuccessionPolicy,
  verifyWorkspaceSuccessionVote,
  type WorkspaceAuthority,
  type WorkspaceSuccessionClaim,
  type WorkspaceSuccessionPolicy,
  type WorkspaceSuccessionVote,
} from "./meshRecords"
import type { WorkspaceMeshCredential } from "./peerStore"

export type SuccessionHost = {
  getProfile: () => Promise<LocalProfile>
  getPolicy: (credential: WorkspaceMeshCredential) => WorkspaceSuccessionPolicy | undefined
  getVotes: (credential: WorkspaceMeshCredential) => WorkspaceSuccessionVote[]
  getClaims: (credential: WorkspaceMeshCredential) => WorkspaceSuccessionClaim[]
  getCatalog: (credential: WorkspaceMeshCredential) => Record<string, unknown>
  getAuthorities: (credential: WorkspaceMeshCredential) => WorkspaceAuthority[]
  revokedPeople: (credential: WorkspaceMeshCredential) => Set<string>
  revokedBefore: (credential: WorkspaceMeshCredential, epoch: number) => Set<string>
  putCredential: (credential: WorkspaceMeshCredential) => Promise<void>
  getCredential: (workspaceId: string) => Promise<WorkspaceMeshCredential | null>
  transferCredential: (previousOwner: string, credential: WorkspaceMeshCredential) => Promise<void>
  updateTransferredPeers: (credential: WorkspaceMeshCredential, payload: WorkspaceSuccessionClaim["payload"]) => Promise<void>
  sessionCount: () => number
  publishAll: () => Promise<void>
}

const authorityFor = (credential: WorkspaceMeshCredential): WorkspaceAuthority => ({
  personId: credential.ownerPersonId,
  publicKey: credential.ownerPublicKey,
  certificates: credential.ownerCertificates as DeviceCertificate[],
})

function catalogSnapshot(host: SuccessionHost, credential: WorkspaceMeshCredential) {
  return JSON.stringify({
    policy: host.getPolicy(credential),
    votes: host.getVotes(credential),
    claims: host.getClaims(credential),
  })
}

async function selectPolicy(host: SuccessionHost, credential: WorkspaceMeshCredential,
  rawPolicy: WorkspaceSuccessionPolicy | undefined): Promise<WorkspaceSuccessionPolicy | undefined> {
  let policy = host.getPolicy(credential)
  if (rawPolicy?.payload?.ownerPersonId === credential.ownerPersonId && rawPolicy.payload.epoch === credential.epoch) {
    const verified = await verifyWorkspaceSuccessionPolicy(rawPolicy, credential.workspaceId, authorityFor(credential))
    if (!policy || verified.payload.updatedAt > policy.payload.updatedAt ||
      (verified.payload.updatedAt === policy.payload.updatedAt && verified.signature > policy.signature)) policy = verified
  }
  if (!policy || policy.payload.ownerPersonId !== credential.ownerPersonId || policy.payload.epoch !== credential.epoch) return undefined
  return verifyWorkspaceSuccessionPolicy(policy, credential.workspaceId, authorityFor(credential))
}

async function collectVotes(host: SuccessionHost, credential: WorkspaceMeshCredential, policy: WorkspaceSuccessionPolicy | undefined,
  rawVotes: WorkspaceSuccessionVote[]): Promise<WorkspaceSuccessionVote[]> {
  if (!policy) return []
  const votes = new Map<string, WorkspaceSuccessionVote>()
  for (const raw of [...host.getVotes(credential), ...rawVotes]) {
    if (raw?.signed?.payload?.policySignature !== policy.signature) continue
    const vote = await verifyWorkspaceSuccessionVote(raw, policy, raw.signed.payload.candidatePersonId,
      authorityFor(credential), host.revokedPeople(credential), Date.now())
    const prior = votes.get(vote.signed.payload.voterPersonId)
    if (!prior || vote.signed.signature < prior.signed.signature) votes.set(vote.signed.payload.voterPersonId, vote)
  }
  return [...votes.values()].sort((a, b) => a.signed.payload.voterPersonId.localeCompare(b.signed.payload.voterPersonId))
}

async function collectClaims(host: SuccessionHost, credential: WorkspaceMeshCredential,
  rawClaims: WorkspaceSuccessionClaim[]): Promise<Map<string, WorkspaceSuccessionClaim>> {
  const claims = new Map<string, WorkspaceSuccessionClaim>()
  for (const claim of host.getClaims(credential)) if (claim?.signature) claims.set(claim.signature, claim)
  for (const claim of rawClaims) await verifyAndStoreClaim(host, credential, claim, claims)
  return claims
}

async function verifyAndStoreClaim(host: SuccessionHost, credential: WorkspaceMeshCredential, claim: WorkspaceSuccessionClaim,
  claims: Map<string, WorkspaceSuccessionClaim>): Promise<void> {
  if (!claim?.signature) return
  if (claim.payload?.epoch === credential.epoch + 1 && claim.payload.fromOwnerPersonId === credential.ownerPersonId) {
    const verified = await verifyWorkspaceSuccessionClaim(claim, credential.workspaceId, authorityFor(credential), credential.epoch,
      host.revokedPeople(credential))
    claims.set(verified.signature, verified)
    return
  }
  if (claim.payload?.epoch !== credential.epoch) return
  const previousOwner = host.getAuthorities(credential).find(owner => owner.personId === claim.payload.fromOwnerPersonId)
  if (!previousOwner) return
  const revokedAtClaim = host.revokedBefore(credential, claim.payload.epoch)
  const verified = await verifyWorkspaceSuccessionClaim(claim, credential.workspaceId, previousOwner,
    claim.payload.epoch - 1, revokedAtClaim)
  claims.set(verified.signature, verified)
}

async function adoptPendingClaims(host: SuccessionHost, initial: WorkspaceMeshCredential,
  claims: Map<string, WorkspaceSuccessionClaim>): Promise<WorkspaceMeshCredential> {
  let credential = initial
  const pending = [...claims.values()].sort((a, b) => a.payload.epoch - b.payload.epoch || a.signature.localeCompare(b.signature))
  for (const raw of pending) {
    if (raw.payload.epoch <= credential.epoch || raw.payload.fromOwnerPersonId !== credential.ownerPersonId) continue
    credential = await adoptClaim(host, credential, raw, claims)
  }
  return credential
}

async function adoptClaim(host: SuccessionHost, credential: WorkspaceMeshCredential, raw: WorkspaceSuccessionClaim,
  claims: Map<string, WorkspaceSuccessionClaim>): Promise<WorkspaceMeshCredential> {
  const previousOwner = authorityFor(credential)
  const claim = await verifyWorkspaceSuccessionClaim(raw, credential.workspaceId, previousOwner, credential.epoch,
    host.revokedPeople(credential))
  const payload = claim.payload
  const profile = await host.getProfile()
  const history = [...((credential.ownerHistory ?? []) as WorkspaceAuthority[])]
  if (!history.some(owner => owner.personId === previousOwner.personId)) history.push(previousOwner)
  const localGrant = profile.identity.personId === payload.toOwnerPersonId ? undefined
    : profile.identity.personId === payload.fromOwnerPersonId ? payload.formerOwnerGrant : credential.localGrant
  const next: WorkspaceMeshCredential = {
    ...credential,
    ownerPersonId: payload.toOwnerPersonId,
    ownerPublicKey: payload.toOwnerPublicKey,
    ownerCertificates: payload.toOwnerCertificates,
    ownerHistory: history,
    ...(localGrant ? { localGrant } : {}),
    epoch: payload.epoch,
    updatedAt: payload.claimedAt,
    catalog: { ...host.getCatalog(credential), successionPolicy: undefined, successionVotes: [],
      successionClaims: [...claims.values()].sort((a, b) => a.payload.epoch - b.payload.epoch) },
  }
  await host.transferCredential(previousOwner.personId, next)
  await host.updateTransferredPeers(next, payload)
  return next
}

export async function mergeSuccessionState(host: SuccessionHost, initial: WorkspaceMeshCredential,
  rawPolicy: WorkspaceSuccessionPolicy | undefined, rawVotes: WorkspaceSuccessionVote[],
  rawClaims: WorkspaceSuccessionClaim[]): Promise<WorkspaceMeshCredential> {
  if (!rawPolicy && rawVotes.length === 0 && rawClaims.length === 0 && !host.getPolicy(initial) &&
    host.getVotes(initial).length === 0 && host.getClaims(initial).length === 0) return initial
  const before = catalogSnapshot(host, initial)
  const policy = await selectPolicy(host, initial, rawPolicy)
  const votes = await collectVotes(host, initial, policy, rawVotes)
  const claims = await collectClaims(host, initial, rawClaims)
  let credential = await adoptPendingClaims(host, initial, claims)
  if (credential.ownerPersonId === initial.ownerPersonId) {
    const catalog = { ...host.getCatalog(credential), successionPolicy: policy, successionVotes: votes,
      successionClaims: [...claims.values()].sort((a, b) => a.payload.epoch - b.payload.epoch || a.signature.localeCompare(b.signature)) }
    if (JSON.stringify({ policy, votes, claims: catalog.successionClaims }) !== before) {
      await host.putCredential({ ...credential, updatedAt: new Date().toISOString(), catalog })
      credential = await host.getCredential(credential.workspaceId) ?? credential
    }
  }
  if (catalogSnapshot(host, credential) !== before && host.sessionCount() > 0) queueMicrotask(() => { void host.publishAll() })
  return credential
}
