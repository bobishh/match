import * as Automerge from "@automerge/automerge/slim"

export function assertScopeDocument(workspaceId: string, candidate: Uint8Array): void {
  const document = Automerge.load<{ id?: unknown }>(candidate)
  try { if (document.id !== workspaceId) throw new Error("Wrong workspace document") }
  finally { Automerge.free(document) }
}
