export type WorkspaceAccessInput = Record<string, unknown> & {
  snapshot: Record<string, unknown> & { document: Uint8Array }
}
export type AccessWorkerRequest = { id: number; diagnosticsEnabled?: boolean; input: WorkspaceAccessInput }
