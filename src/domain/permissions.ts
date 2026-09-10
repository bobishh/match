import type { WorkspaceDocumentV2 } from "./model"
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
    if (!b || !["task", "document", "artifact"].includes(b.kind) || (a && a.kind !== b.kind)) throw new Error("Only the owner can edit board structure")
    if (b.kind === "task" && !["column", "task"].includes(afterEntities[b.placement.parentId ?? ""]?.kind ?? "")) throw new Error("Invalid task parent")
  }
}
