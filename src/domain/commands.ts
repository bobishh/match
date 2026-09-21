import * as Automerge from "@automerge/automerge/slim"
import type {
  ChangeProof,
  CommandResult,
  Heads,
  TransactionMetadataV1,
  TransactionReceipt,
  WorkspaceDocumentV2,
} from "./model"
import { canonicalizeJson, createActorBinding, createChangeProof, sha256Base64Url, type LocalProfile } from "./identity"
import { prepareCommand } from "./commandHandlers"
import { err, type Command, type ExecuteResult } from "./commandTypes"

export { type Command, type ExecuteResult } from "./commandTypes"

export async function executeCommand(
  doc: Automerge.Doc<WorkspaceDocumentV2>, command: Command, profile: LocalProfile, actorId?: string
): Promise<ExecuteResult> {
  const transactionId = crypto.randomUUID()
  const beforeHeads = Automerge.getHeads(doc).sort()
  const prepared = prepareCommand(doc, command, new Date().toISOString(), beforeHeads)
  if (!prepared.ok) return prepared
  const metadata = commandMetadata(transactionId, command.kind, prepared.value.changedEntityIds, profile)
  const newDoc = Automerge.change(Automerge.clone(doc), { message: JSON.stringify(metadata) }, draft => prepared.value.apply(draft))
  const changeBytes = Automerge.getLastLocalChange(newDoc)
  if (!changeBytes) return err("storage_failed", "Automerge produced no change")
  return completeCommand(newDoc, changeBytes, transactionId, beforeHeads, prepared.value.changedEntityIds, profile, actorId)
}

function commandMetadata(transactionId: string, action: Command["kind"], entityIds: string[], profile: LocalProfile): TransactionMetadataV1 {
  return { version: 1, transactionId, action, entityIds, personId: profile.identity.personId, deviceId: profile.device.deviceId }
}

async function completeCommand(
  newDoc: Automerge.Doc<WorkspaceDocumentV2>, changeBytes: Uint8Array, transactionId: string, beforeHeads: Heads,
  changedEntityIds: string[], profile: LocalProfile, actorId?: string
): Promise<ExecuteResult> {
  const changeHash = Automerge.decodeChange(changeBytes).hash
  const binding = await createActorBinding(profile, newDoc.id, actorId || profile.device.deviceId)
  const bindingHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(binding)))
  const proof = await createChangeProof(profile, newDoc.id, changeHash, bindingHash)
  const receipt: TransactionReceipt = {
    transactionId,
    beforeHeads,
    afterHeads: Automerge.getHeads(newDoc).sort(),
    changeHash,
    changedEntityIds,
    saved: true,
  }
  return { ok: true, value: { newDoc, receipt, proof } }
}

export function createCommandQueue(initialDoc: Automerge.Doc<WorkspaceDocumentV2>, profile: LocalProfile, actorId?: string) {
  let currentDoc = initialDoc
  let queue: Promise<unknown> = Promise.resolve()
  return {
    getDocument(): Automerge.Doc<WorkspaceDocumentV2> { return currentDoc },
    transact(command: Command): Promise<CommandResult<{ receipt: TransactionReceipt; proof: ChangeProof }>> {
      const run = async () => queueResult(await executeCommand(currentDoc, command, profile, actorId), value => { currentDoc = value.newDoc })
      const next = queue.then(run, run)
      queue = next
      return next
    },
  }
}

function queueResult(
  result: ExecuteResult,
  save: (value: Extract<ExecuteResult, { ok: true }>["value"]) => void,
): CommandResult<{ receipt: TransactionReceipt; proof: ChangeProof }> {
  if (!result.ok) return result
  save(result.value)
  return { ok: true, value: { receipt: result.value.receipt, proof: result.value.proof } }
}
