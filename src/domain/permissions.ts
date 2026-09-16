import { entityKind, isItem, type WorkspaceDocumentV2 } from "./model"
import { canonicalizeJson } from "./identity"

export type WorkspaceRole = "owner" | "editor" | "visitor"

export function assertWorkspaceTransition(role: WorkspaceRole, before: WorkspaceDocumentV2, after: WorkspaceDocumentV2) {
  if (role === "owner") return
  if (role === "visitor") throw new Error("Visitors can only view this workspace")
  const { entities: beforeEntities, ...beforeRoot } = before
  const { entities: afterEntities, ...afterRoot } = after
  if (canonicalizeJson(beforeRoot) !== canonicalizeJson(afterRoot)) throw new Error("Only the owner can edit workspace settings")
  for (const id of new Set([...Object.keys(beforeEntities), ...Object.keys(afterEntities)])) {
    const a = beforeEntities[id], b = afterEntities[id]
    if (canonicalizeJson(a ?? null) === canonicalizeJson(b ?? null)) continue
    if (!b || !(isItem(b) || b.kind === "document" || b.kind === "artifact") || (a && entityKind(a) !== entityKind(b))) throw new Error("Only the owner can edit board structure")
    const parent = afterEntities[b.placement.parentId ?? ""]
    if (isItem(b) && !(parent && (isItem(parent) || parent.kind === "column"))) throw new Error("Invalid item parent")
  }
}
