import type { WorkspaceOwnershipTransfer } from "./meshRecords"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"

export function hasConflictingOwnershipTransfers(records: WorkspaceOwnershipTransfer[]) {
  return meshRustRuntime().state.hasConflictingOwnershipTransfers(records)
}
