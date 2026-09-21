import type { WorkspaceOwnershipTransfer } from "./meshRecords"

export function hasConflictingOwnershipTransfers(records: WorkspaceOwnershipTransfer[]) {
  const successors = new Map<string, Set<string>>()
  for (const record of records) {
    const { epoch, fromOwnerPersonId, toOwnerPersonId } = record.payload
    if (!Number.isSafeInteger(epoch) || epoch < 0 || !fromOwnerPersonId || !toOwnerPersonId) continue
    const key = `${epoch}:${fromOwnerPersonId}`
    const targets = successors.get(key) ?? new Set<string>()
    targets.add(toOwnerPersonId)
    successors.set(key, targets)
  }
  return [...successors.values()].some(targets => targets.size > 1)
}
