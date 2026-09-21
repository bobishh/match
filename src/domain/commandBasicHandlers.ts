import * as Automerge from "@automerge/automerge/slim"
import type { Board, CommandErrorCode, FieldDefinition, FieldValue, Item, WorkspaceDocumentV2, WorkspaceEntity } from "./model"
import { entityKind, isItem, validatePlacementParent } from "./model"
import { getAncestryPath } from "./ancestry"
import { validateItemValues } from "./fields"
import { seedBoard } from "./seeds"
import { err } from "./commandTypes"
import type { CommandByKind, CommandContext, CommandHandler, PreparedCommand } from "./commandHandlerTypes"
import { applyRenumbering, computeInsertionRank, findRootBoardId } from "./commandSupport"

export const createWorkspace: CommandHandler<"createWorkspace"> = () => err("invalid_input", "createWorkspace cannot be executed on an existing workspace document")

export const setWorkspaceDeleted: CommandHandler<"setWorkspaceDeleted"> = (_doc, command) => ({ ok: true, value: { changedEntityIds: [], apply: draft => { draft.deleted = command.deleted } } })

export const renameWorkspace: CommandHandler<"renameWorkspace"> = (_doc, command) => {
  if (!command.title.trim()) return err("invalid_input", "Workspace name is required", "title")
  return { ok: true, value: { changedEntityIds: [], apply: draft => { draft.title = command.title.trim() } } }
}

export const createBoard: CommandHandler<"createBoard"> = (_doc, command, context) => {
  if (!command.title.trim()) return err("invalid_input", "Board title is required", "title")
  const entities: Record<string, WorkspaceEntity> = {}
  const board = seedBoard(entities, command.title.trim(), command.preset, context.nowIso)
  return { ok: true, value: { changedEntityIds: [board.id, ...Object.keys(entities).filter(id => id !== board.id)], apply: draft => { Object.assign(draft.entities, entities) } } }
}

export const createItem: CommandHandler<"createItem"> = (doc, command, context) => {
  if (!command.title.trim()) return err("invalid_input", "Item title is required", "title")
  const parent = doc.entities[command.parentId]
  if (!parent) return err("not_found", `Parent ${command.parentId} not found`)
  const parentResult = validatePlacementParent("item", entityKind(parent))
  if (!parentResult.ok) return err("invalid_parent", parentResult.error.message)
  const values = itemValuesForCreate(doc, command)
  if (!values.ok) return values
  const itemId = command.id ?? crypto.randomUUID()
  const insertion = computeInsertionRank(doc.entities, command.parentId)
  return { ok: true, value: { changedEntityIds: [itemId], apply: draft => createItemInDraft(draft, command, itemId, values.value, insertion, context.nowIso) } }
}

type CommandFailure = { ok: false; error: { code: CommandErrorCode; message: string; field?: string } }

function itemValuesForCreate(doc: Automerge.Doc<WorkspaceDocumentV2>, command: CommandByKind<"createItem">): { ok: true; value: Record<string, FieldValue> } | CommandFailure {
  const boardId = findRootBoardId(doc.entities, command.parentId)
  if (!boardId) return { ok: true, value: command.values ?? {} }
  const values = addPresetValues(doc, boardId, command.title, command.values ?? {})
  const validation = validateValues(doc, boardId, values)
  if (!validation.ok) return validation
  return { ok: true, value: values }
}

function addPresetValues(doc: Automerge.Doc<WorkspaceDocumentV2>, boardId: string, title: string, source: Record<string, FieldValue>): Record<string, FieldValue> {
  const board = doc.entities[boardId] as Board | undefined
  const values = { ...source }
  const bindings = board?.preset?.bindings ?? {}
  addBoundValue(values, bindings["field.company"], title, 0)
  addBoundValue(values, bindings["field.role"], title, 1)
  return values
}

function addBoundValue(values: Record<string, FieldValue>, fieldId: string | undefined, title: string, segment: number) {
  if (!fieldId || values[fieldId]) return
  const parts = title.split(" — ")
  values[fieldId] = segment ? (parts.slice(segment).join(" — ").trim() || title.trim()) : parts[0].trim()
}

function validateValues(doc: Automerge.Doc<WorkspaceDocumentV2>, boardId: string, values: Record<string, FieldValue>): { ok: true } | CommandFailure {
  const fields = Object.values(doc.entities).filter((entity): entity is FieldDefinition => entity.kind === "field" && entity.placement.parentId === boardId)
  const validation = validateItemValues(fields, values)
  if (validation.ok) return { ok: true }
  const field = Object.keys(validation.errors)[0]
  return err("invalid_input", validation.errors[field], field)
}

function createItemInDraft(draft: WorkspaceDocumentV2, command: CommandByKind<"createItem">, id: string, values: Record<string, FieldValue>, insertion: ReturnType<typeof computeInsertionRank>, nowIso: string) {
  applyRenumbering(draft, insertion.renumbered)
  draft.entities[id] = { id, title: command.title.trim(), body: command.body ?? "", placement: { parentId: command.parentId, rank: insertion.rank }, deleted: false, createdAt: nowIso, updatedAt: nowIso, values }
}

export const patchItem: CommandHandler<"patchItem"> = (doc, command, context) => {
  const item = doc.entities[command.entityId]
  if (!isItem(item)) return err("not_found", `Item ${command.entityId} not found`)
  if (command.title !== undefined && !command.title.trim()) return err("invalid_input", "Item title cannot be empty", "title")
  const validation = validateItemPatch(doc, item, command)
  if (!validation.ok) return validation
  return { ok: true, value: { changedEntityIds: [command.entityId], apply: draft => patchItemInDraft(draft, command, context.nowIso) } }
}

function validateItemPatch(doc: Automerge.Doc<WorkspaceDocumentV2>, item: Item, command: CommandByKind<"patchItem">): PreparedCommand | { ok: true } {
  if (!command.values) return { ok: true }
  const boardId = findRootBoardId(doc.entities, item.id)
  return boardId ? validateValues(doc, boardId, { ...item.values, ...command.values }) : { ok: true }
}

function patchItemInDraft(draft: WorkspaceDocumentV2, command: CommandByKind<"patchItem">, nowIso: string) {
  const item = draft.entities[command.entityId] as Item
  if (command.title !== undefined) item.title = command.title.trim()
  if (command.body !== undefined) item.body = command.body
  Object.assign(item.values, command.values ?? {})
  item.updatedAt = nowIso
}

export const restoreItemVersion: CommandHandler<"restoreItemVersion"> = (doc, command, context) => {
  const item = doc.entities[command.entityId]
  if (!isItem(item)) return err("not_found", `Item ${command.entityId} not found`)
  const historical = Automerge.getHistory(doc).find(entry => entry.change.hash === command.changeHash)?.snapshot.entities[command.entityId]
  if (!isItem(historical)) return err("not_found", "Recorded item version is unavailable")
  const parent = historical.placement.parentId ? doc.entities[historical.placement.parentId] : undefined
  if (!parent || !validatePlacementParent("item", entityKind(parent)).ok) return err("invalid_parent", "Recorded item parent is unavailable")
  const restored = JSON.parse(JSON.stringify(historical)) as Item
  return { ok: true, value: { changedEntityIds: [command.entityId], apply: draft => restoreItemInDraft(draft, command.entityId, restored, context.nowIso) } }
}

function restoreItemInDraft(draft: WorkspaceDocumentV2, id: string, restored: Item, nowIso: string) {
  const item = draft.entities[id] as Item
  item.title = restored.title; item.body = restored.body; item.values = restored.values; item.placement = restored.placement; item.deleted = restored.deleted; item.updatedAt = nowIso
}

export const moveEntity: CommandHandler<"moveEntity"> = (doc, command, context) => moveEntityResult(doc, command, context, false)
export const restoreAndMove: CommandHandler<"restoreAndMove"> = (doc, command, context) => moveEntityResult(doc, command, context, true)

function moveEntityResult(doc: Automerge.Doc<WorkspaceDocumentV2>, command: CommandByKind<"moveEntity"> | CommandByKind<"restoreAndMove">, context: CommandContext, restore: boolean): PreparedCommand {
  const entity = doc.entities[command.entityId]
  if (!entity) return err("not_found", `Entity ${command.entityId} not found`)
  const valid = validateMove(doc, entity, command)
  if (!valid.ok) return valid
  const insertion = computeInsertionRank(doc.entities, command.parentId, command.beforeId)
  return { ok: true, value: { changedEntityIds: [command.entityId], apply: draft => moveEntityInDraft(draft, command, insertion, context.nowIso, restore) } }
}

function validateMove(doc: Automerge.Doc<WorkspaceDocumentV2>, entity: WorkspaceEntity, command: CommandByKind<"moveEntity"> | CommandByKind<"restoreAndMove">): PreparedCommand | { ok: true } {
  if (command.parentId === command.entityId) return err("cycle", "Cannot place an entity under itself")
  if (getAncestryPath(doc.entities, command.parentId).path.includes(command.entityId)) return err("cycle", "Cannot place an entity under its descendant")
  const parent = doc.entities[command.parentId]
  if (!parent) return err("not_found", `Target parent ${command.parentId} not found`)
  const result = validatePlacementParent(entityKind(entity), entityKind(parent))
  if (!result.ok) return err("invalid_parent", result.error.message)
  if (findRootBoardId(doc.entities, entity.id) !== findRootBoardId(doc.entities, command.parentId)) return err("cross_board_move", "Cross-board moves are not supported")
  return { ok: true }
}

function moveEntityInDraft(draft: WorkspaceDocumentV2, command: CommandByKind<"moveEntity"> | CommandByKind<"restoreAndMove">, insertion: ReturnType<typeof computeInsertionRank>, nowIso: string, restore: boolean) {
  applyRenumbering(draft, insertion.renumbered)
  const entity = draft.entities[command.entityId]
  if (restore) entity.deleted = false
  entity.placement = { parentId: command.parentId, rank: insertion.rank }
  entity.updatedAt = nowIso
}

export const renameEntity: CommandHandler<"renameEntity"> = (doc, command, context) => {
  if (!doc.entities[command.entityId]) return err("not_found", `Entity ${command.entityId} not found`)
  if (!command.title.trim()) return err("invalid_input", "Title cannot be empty", "title")
  return { ok: true, value: { changedEntityIds: [command.entityId], apply: draft => { draft.entities[command.entityId].title = command.title.trim(); draft.entities[command.entityId].updatedAt = context.nowIso } } }
}

export const setEntityDeleted: CommandHandler<"setEntityDeleted"> = (doc, command, context) => {
  if (!doc.entities[command.entityId]) return err("not_found", `Entity ${command.entityId} not found`)
  return { ok: true, value: { changedEntityIds: [command.entityId], apply: draft => { draft.entities[command.entityId].deleted = command.deleted; draft.entities[command.entityId].updatedAt = context.nowIso } } }
}
