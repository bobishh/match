import type { WorkspaceMeshCredential, WorkspacePeerRecord } from "./peerStore"
import type { WorkspaceMemberBundle } from "./meshRecords"
import { isGrantRevoked, revocations } from "./durableMeshBase"
import type { LocalProfile } from "../domain/identity"

function inspectRevocationGeneration(credential: WorkspaceMeshCredential, personId: string,
  peers: WorkspacePeerRecord[]) {
  const existingRevocations = revocations(credential).filter(item => item.payload.personId === personId)
  const activePeers = peers.filter(peer => peer.personId === personId && !peer.revokedAt)
  let maxActiveGrantEpoch: number | null = null
  let unknownActiveGrantCount = 0
  const covered = activePeers.every(peer => {
    const grant = (peer.advertisement as WorkspaceMemberBundle | undefined)?.grant
    const payload = grant?.payload as { accessEpoch?: unknown } | undefined
    if (!payload) {
      unknownActiveGrantCount++
      return false
    }
    const epoch = payload.accessEpoch ?? 1
    if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1) {
      unknownActiveGrantCount++
      return false
    }
    maxActiveGrantEpoch = Math.max(maxActiveGrantEpoch ?? 0, epoch)
    return isGrantRevoked(credential, personId, grant)
  })
  return {
    existingRevocationEpoch: Math.max(0, ...existingRevocations.map(item => item.payload.epoch)),
    maxActiveGrantEpoch,
    activePeerCount: activePeers.length,
    unknownActiveGrantCount,
    covered,
  }
}

export function emptyRevocationGeneration() {
  return { existingRevocationEpoch: 0, maxActiveGrantEpoch: null, activePeerCount: 0, unknownActiveGrantCount: 0, covered: false }
}

export function assertKeeperGrantGeneration(credential: WorkspaceMeshCredential | null | undefined,
  peers: WorkspacePeerRecord[], profile: LocalProfile, personId: string, expectedEpoch: number,
  verifiedIssuedGrantEpochs: number[]): boolean {
  if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1 || !credential
    || credential.ownerPersonId !== profile.identity.personId || credential.ownerPublicKey !== profile.identity.publicKey) {
    throw new Error("Keeper grant generation is no longer authorized for revocation.")
  }
  const active = peers.filter(peer => peer.personId === personId && !peer.revokedAt)
  const epochs = active.map(peer => {
    const payload = (peer.advertisement as WorkspaceMemberBundle | undefined)?.grant?.payload
    return payload?.personId === personId && payload.workspaceId === credential.workspaceId ? payload.accessEpoch ?? 1 : null
  })
  if (epochs.some(epoch => typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1)) {
    throw new Error("Keeper grant generation cannot be verified.")
  }
  if (epochs.some(epoch => (epoch as number) > expectedEpoch)) {
    throw new Error("A newer keeper grant exists; this cancellation cannot revoke it.")
  }
  const newestIssuedEpoch = Math.max(0, ...verifiedIssuedGrantEpochs)
  if (newestIssuedEpoch > expectedEpoch) {
    throw new Error("A newer keeper grant exists; this cancellation cannot revoke it.")
  }
  if (!epochs.includes(expectedEpoch) && newestIssuedEpoch !== expectedEpoch) {
    throw new Error("The exact issued keeper grant is unavailable; refusing generation-less revocation.")
  }
  if (epochs.length || newestIssuedEpoch === expectedEpoch) {
    const latestRevocationEpoch = Math.max(0, ...revocations(credential).filter(item => item.payload.personId === personId)
      .map(item => item.payload.epoch))
    return latestRevocationEpoch <= expectedEpoch
  }
  return false
}

export async function reconcilePriorPersonRevocation(credential: WorkspaceMeshCredential | null | undefined,
  personId: string, peers: () => Promise<WorkspacePeerRecord[]>, merge: () => Promise<void>,
  notify: () => Promise<void>, trace: (details: object) => void) {
  if (!credential) return { completed: false as const }
  const existing = revocations(credential).filter(item => item.payload.personId === personId)
  if (!existing.length) return { completed: false as const }
  const generation = inspectRevocationGeneration(credential, personId, await peers())
  trace(generation)
  if (!generation.covered) return { completed: false as const, generation }
  await merge()
  await notify()
  return { completed: true as const, generation }
}
