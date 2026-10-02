import { entityKind, isItem, type WorkspaceDocumentV2 } from "./model"
import { canonicalizeJson } from "./identity"
import type { Command } from "./commandTypes"

export type WorkspaceRole = "owner" | "editor" | "visitor"

export type WorkspaceCapability =
  | "workspace.rename"
  | "content.write"
  | "chat.write"
  | "chat.profile"
  | "board.configure"
  | "workspace.import"
  | "access.manage"

const roleCapabilities: Record<WorkspaceRole, ReadonlySet<WorkspaceCapability>> = {
  owner: new Set<WorkspaceCapability>([
    "workspace.rename",
    "content.write",
    "chat.write",
    "chat.profile",
    "board.configure",
    "workspace.import",
    "access.manage",
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
}

export function canWorkspace(role: WorkspaceRole, capability: WorkspaceCapability) {
  return roleCapabilities[role]?.has(capability) ?? false
}

export function assertWorkspaceCapability(role: WorkspaceRole, capability: WorkspaceCapability) {
  if (!canWorkspace(role, capability)) throw new Error(capabilityErrors[capability])
}

export function assertWorkspaceCommand(role: WorkspaceRole, doc: WorkspaceDocumentV2, command: Command): void {
  const capability = commandCapabilities[command.kind]
  if (capability === null) return // createWorkspace handler rejects commands on existing documents.
  const entityId = "entityId" in command ? command.entityId : ""
  assertWorkspaceCapability(role, capability === "entity" ? entityCapability(doc.entities[entityId]) : capability)
}

const commandCapabilities: Record<Command["kind"], WorkspaceCapability | "entity" | null> = {
  createWorkspace: null,
  migrateWorkspaceFormat: "board.configure",
  renameWorkspace: "workspace.rename",
  setWorkspaceArchived: "board.configure",
  createBoard: "board.configure",
  createColumn: "board.configure",
  createItem: "content.write",
  patchItem: "content.write",
  restoreItemVersion: "content.write",
  moveEntity: "entity",
  renameEntity: "entity",
  setEntityArchived: "entity",
  restoreAndMove: "entity",
  createField: "board.configure",
  patchField: "board.configure",
  createFieldOption: "board.configure",
  patchFieldOption: "board.configure",
  addDocument: "content.write",
  patchDocument: "content.write",
  createTemplate: "board.configure",
  patchTemplate: "board.configure",
  recordArtifact: "content.write",
  updateBoardSchema: "board.configure",
  updateWorkspaceSettings: "board.configure",
}

function entityCapability(entity: WorkspaceDocumentV2["entities"][string] | undefined): WorkspaceCapability {
  return entity && (isItem(entity) || entity.kind === "document" || entity.kind === "artifact")
    ? "content.write"
    : "board.configure"
}

export function assertWorkspaceTransition(role: WorkspaceRole, before: WorkspaceDocumentV2, after: WorkspaceDocumentV2) {
  if (role === "visitor") assertWorkspaceCapability(role, "content.write")
  const { entities: beforeEntities, title: beforeTitle, ...beforeRoot } = before
  const { entities: afterEntities, title: afterTitle, ...afterRoot } = after
  assertRootChanges(role, beforeTitle, afterTitle, beforeRoot, afterRoot)
  for (const id of new Set([...Object.keys(beforeEntities), ...Object.keys(afterEntities)])) {
    const a = beforeEntities[id], b = afterEntities[id]
    if (canonicalizeJson(a ?? null) === canonicalizeJson(b ?? null)) continue
    assertEntityTransition(role, a, b, afterEntities)
  }
}

function assertRootChanges(role: WorkspaceRole, beforeTitle: string, afterTitle: string, beforeRoot: object, afterRoot: object): void {
  if (beforeTitle !== afterTitle) assertWorkspaceCapability(role, "workspace.rename")
  if (canonicalizeJson(beforeRoot) !== canonicalizeJson(afterRoot)) assertWorkspaceCapability(role, "board.configure")
}

function assertEntityTransition(role: WorkspaceRole, before: WorkspaceDocumentV2["entities"][string] | undefined, after: WorkspaceDocumentV2["entities"][string] | undefined, entities: WorkspaceDocumentV2["entities"]): void {
  if (!isContentChange(before, after)) return assertWorkspaceCapability(role, "board.configure")
  assertWorkspaceCapability(role, "content.write")
  const parent = entities[after.placement.parentId ?? ""]
  if (isItem(after) && !(parent && (isItem(parent) || parent.kind === "column"))) throw new Error("Invalid item parent")
}

function isContentChange(before: WorkspaceDocumentV2["entities"][string] | undefined, after: WorkspaceDocumentV2["entities"][string] | undefined): after is WorkspaceDocumentV2["entities"][string] {
  return Boolean(after && (isItem(after) || after.kind === "document" || after.kind === "artifact") && (!before || entityKind(before) === entityKind(after)))
}
