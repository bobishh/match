import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"

export const proofPagingCapabilities = ["proof-paging-v2"] as const

export function supportsProofPaging(value: unknown): boolean {
  return Array.isArray(value) && value.includes("proof-paging-v2")
}

/** Reject unnegotiated manifests before requests, admission or durable writes. */
export function assertProofPagingNegotiated(snapshot: Uint8Array, ids: string[], supported: boolean): void {
  if (supported) return
  const entries = meshRustRuntime().state.decodeWorkspaceSet(snapshot, ids)
  if (entries.some(entry => entry.authorization && typeof entry.authorization === "object"
    && "kind" in entry.authorization && entry.authorization.kind === "workspace-authorization-manifest")) {
    throw new Error("Peer did not negotiate proof paging; update the app")
  }
}
