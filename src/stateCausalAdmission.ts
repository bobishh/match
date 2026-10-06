import * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceDocumentV2 } from "./domain/model"
import { validateWorkspaceDoc } from "./domain/model"
import { exportAuthorizationBundle, evaluateIncomingWorkspaceAdmission, workspaceWritesBlocked } from "./sync/changeAuthorization"
import type { WorkspaceChangeAuthorization } from "./sync/workspaceChangeProofStore"
import { peerStore } from "./sync/peerStore"
import { defaultStorage } from "./storage"
import { withWorkspaceMutation } from "./workspaceMutation"
import { stateRuntime } from "./stateContext"

export async function assertWorkspaceWritesAllowed(workspaceId?: string): Promise<void> {
  if (!workspaceId) return
  if (typeof indexedDB !== "undefined" && await peerStore.getPendingOwnershipTransfer(workspaceId))
    throw new Error("Ownership transfer is awaiting confirmation. Reconnect and retry the same recipient.")
  if (await workspaceWritesBlocked(workspaceId)) throw new Error("Workspace writes paused: conflicting ownership records")
}

export async function reclassifyStoredWorkspace(workspaceId: string, storage = defaultStorage): Promise<{
  doc: Automerge.Doc<WorkspaceDocumentV2> | undefined
  changed: boolean
}> {
  return withWorkspaceMutation(workspaceId, async () => {
    const loaded = await storage.loadWorkspaceDoc(workspaceId)
    if (!loaded) return { doc: undefined, changed: false }
    const evidence = await storage.loadCausalEvidence(workspaceId)
    const rawBytes = evidence ? new Uint8Array(evidence.bytes) : Automerge.save(loaded.doc)
    const raw = Automerge.load<WorkspaceDocumentV2>(rawBytes)
    try {
      const authorization = await exportAuthorizationBundle(rawBytes, stateRuntime.currentProfile ?? undefined)
      const admission = await evaluateIncomingWorkspaceAdmission(raw, raw, authorization,
        (evidence?.authorizationEvidence ?? []) as WorkspaceChangeAuthorization[])
      const doc = Automerge.load<WorkspaceDocumentV2>(admission.authorizedDocument)
      const validation = validateWorkspaceDoc(doc)
      if (!validation.ok) {
        Automerge.free(doc)
        throw new Error(`Invalid authorized workspace projection: ${validation.error.message}`)
      }
      if (doc.ownerPersonId !== loaded.doc.ownerPersonId) {
        Automerge.free(doc)
        throw new Error("Workspace ownership cannot change through reclassification.")
      }
      const result = await storage.commitWorkspace(workspaceId, doc, Automerge.save(doc),
        admission.verifiedAuthorizations as WorkspaceChangeAuthorization[], undefined, {
          bytes: admission.rawBytes,
          decisions: admission.decisions,
          authorizationEvidence: admission.authorizationEvidence,
        })
      const documentChanged = !sameHeads(doc, loaded.doc)
      return { doc, changed: documentChanged || result.proofChanged || result.causalChanged }
    } finally { Automerge.free(raw) }
  })
}

function sameHeads(left: Automerge.Doc<WorkspaceDocumentV2>, right: Automerge.Doc<WorkspaceDocumentV2>): boolean {
  return Automerge.getHeads(left).sort().join() === Automerge.getHeads(right).sort().join()
}
