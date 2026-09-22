import * as Automerge from "@automerge/automerge/slim"
import { canonicalizeJson } from "../domain/identity"
import { isItem, type WorkspaceDocumentV2 } from "../domain/model"

type LegacyEntity = { kind?: unknown }

export function isDiscriminatorCleanup(doc: Automerge.Doc<WorkspaceDocumentV2>, change: Automerge.DecodedChange) {
  if (!change.deps.length || !change.ops.length) return false
  const before = Automerge.view(doc, change.deps)
  const expected = JSON.parse(JSON.stringify(before)) as WorkspaceDocumentV2
  const itemObjects = new Map(Object.values(before.entities).filter(isItem).map(item => [Automerge.getObjectId(item), item.id]))
  for (const op of change.ops) {
    if (op.action !== "del" || op.key !== "kind" || !itemObjects.has(op.obj)) return false
    const id = itemObjects.get(op.obj)!
    if (!["task", "item"].includes((before.entities[id] as LegacyEntity).kind as string)) return false
    delete (expected.entities[id] as LegacyEntity).kind
  }
  return canonicalizeJson(expected) === canonicalizeJson(Automerge.view(doc, [change.hash]))
}
