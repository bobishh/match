import type { WorkspaceMeshCredential, WorkspacePeerRecord } from "./peerStore"
import type { WorkspaceMemberBundle } from "./meshRecords"
import { isGrantRevoked, revocations } from "./durableMeshBase"

export function inspectRevocationGeneration(credential: WorkspaceMeshCredential, personId: string,
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
