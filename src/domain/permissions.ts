import { entityKind, isItem, type WorkspaceDocumentV2 } from "./model"
import { canonicalizeJson } from "./identity"

export type WorkspaceRole = "owner" | "editor" | "visitor"

export type WorkspaceCapability =
  | "workspace.rename"
  | "content.write"
  | "chat.write"
  | "chat.profile"
  | "board.configure"
  | "workspace.import"
  | "access.manage"
  | "history.repair"

const roleCapabilities: Record<WorkspaceRole, ReadonlySet<WorkspaceCapability>> = {
  owner: new Set<WorkspaceCapability>([
    "workspace.rename",
    "content.write",
    "chat.write",
    "chat.profile",
    "board.configure",
    "workspace.import",
    "access.manage",
    "history.repair",
  ]),
  editor: new Set<WorkspaceCapability>(["workspace.rename", "content.write", "chat.write", "chat.profile"]),
  visitor: new Set<WorkspaceCapability>(["chat.profile"]),
}

const capabilityErrors: Record<WorkspaceCapability, string> = {
  "workspace.rename": "Only owners and editors can rename this workspace",
  "content.write": "Visitors can only view this workspace",
  "chat.write": "Visitors can only view this workspace",
  "chat.profile": "Workspace profile updates are not allowed",
  "board.configure": "Only the owner can edit board structure",
  "workspace.import": "Only the owner can import into this workspace",
  "access.manage": "Only the owner can manage workspace access",
  "history.repair": "Only the owner can repair history signatures",
}

export function canWorkspace(role: WorkspaceRole, capability: WorkspaceCapability) {
  return roleCapabilities[role]?.has(capability) ?? false
}

export function assertWorkspaceCapability(role: WorkspaceRole, capability: WorkspaceCapability) {
  if (!canWorkspace(role, capability)) throw new Error(capabilityErrors[capability])
}

export function assertWorkspaceTransition(role: WorkspaceRole, before: WorkspaceDocumentV2, after: WorkspaceDocumentV2) {
  if (role === "visitor") assertWorkspaceCapability(role, "content.write")
  const { entities: beforeEntities, title: beforeTitle, ...beforeRoot } = before
  const { entities: afterEntities, title: afterTitle, ...afterRoot } = after
  if (beforeTitle !== afterTitle) assertWorkspaceCapability(role, "workspace.rename")
  if (canonicalizeJson(beforeRoot) !== canonicalizeJson(afterRoot)) assertWorkspaceCapability(role, "board.configure")
  for (const id of new Set([...Object.keys(beforeEntities), ...Object.keys(afterEntities)])) {
    const a = beforeEntities[id], b = afterEntities[id]
    if (canonicalizeJson(a ?? null) === canonicalizeJson(b ?? null)) continue
    if (!b || !(isItem(b) || b.kind === "document" || b.kind === "artifact") || (a && entityKind(a) !== entityKind(b))) {
      assertWorkspaceCapability(role, "board.configure")
      continue
    }
    assertWorkspaceCapability(role, "content.write")
    const parent = afterEntities[b.placement.parentId ?? ""]
    if (isItem(b) && !(parent && (isItem(parent) || parent.kind === "column"))) throw new Error("Invalid item parent")
  }
}
