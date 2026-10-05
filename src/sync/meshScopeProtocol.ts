import type { RustMeshScopeRuntime } from "@meta-uber/mesh-replication/runtime"

export type ScopeMethod = Exclude<keyof RustMeshScopeRuntime, "free">
export const scopeMethods: Record<ScopeMethod, true> = {
  beginAuthorizationTransfer: true,
  provideProofPage: true,
  provideCachedProofPage: true,
  acceptProofPage: true,
  continueProofReceive: true,
  startDocumentSync: true,
  receiveFrame: true,
  provideDocument: true,
  completeDocumentReceive: true,
  rejectDocumentReceive: true,
  resetDocument: true,
  completeSavedReceive: true,
  publishFrame: true,
  preparePublish: true,
  finishPublish: true,
}
export type ScopeRequestBody = { scopeId: number } & (
  | { kind: "create"; workspaceId: string; secret: string }
  | { kind: "call"; method: ScopeMethod; args: unknown[] }
  | { kind: "validate"; workspaceId: string; document: Uint8Array }
  | { kind: "free" }
)
export type ScopeRequest = ScopeRequestBody & { id: number }
export type ScopeResponse = { id: number } & (
  | { result: unknown }
  | { error: string; fatal?: boolean }
)
