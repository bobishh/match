import * as Automerge from "@automerge/automerge/slim"
import type { Board, CommandErrorCode, FieldDefinition, FieldValue, Item, WorkspaceDocumentV2, WorkspaceEntity } from "./model"
import { entityKind, hasEntityKind, isItem, validatePlacementParent } from "./model"
import { getAncestryPath } from "./ancestry"
import { isArchiveColumn } from "./archive"
import { validateItemValues } from "./fields"
import { isInlineNarrativeNote } from "./narrative"
import { seedBoard } from "./seeds"
import { err } from "./commandTypes"
import type { CommandByKind, CommandContext, CommandHandler, PreparedCommand } from "./commandHandlerTypes"
import { applyRenumbering, computeInsertionRank, findRootBoardId } from "./commandSupport"

export const createWorkspace: CommandHandler<"createWorkspace"> = () => err("invalid_input", "createWorkspace cannot be executed on an existing workspace document")

export const setWorkspaceArchived: CommandHandler<"setWorkspaceArchived"> = (_doc, command, context) => ({ ok: true, value: { changedEntityIds: [], apply: draft => { draft.archivedAt = command.archived ? context.nowIso : null } } })

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
  if (hasEntityKind(parent, "column") && isArchiveColumn(parent)) return err("invalid_parent", "Items cannot be created in Archive")
  const parentResult = validatePlacementParent("item", entityKind(parent))
  if (!parentResult.ok) return err("invalid_parent", parentResult.error.message)
  const values = itemValuesForCreate(doc, command)
  if (!values.ok) return values
  const itemId = command.id ?? crypto.randomUUID()
  const insertion = computeInsertionRank(doc.entities, command.parentId, command.beforeId)
  return { ok: true, value: { changedEntityIds: [itemId], apply: draft => createItemInDraft(draft, command, itemId, values.value, insertion, context.nowIso) } }
}

type CommandFailure = { ok: false; error: { code: CommandErrorCode; message: string; field?: string } }

function itemValuesForCreate(doc: Automerge.Doc<WorkspaceDocumentV2>, command: CommandByKind<"createItem">): { ok: true; value: Record<string, FieldValue> } | CommandFailure {
  const boardId = findRootBoardId(doc.entities, command.parentId)
  if (!boardId) return { ok: true, value: command.values ?? {} }
  const values = addPresetValues(doc, boardId, command.title, command.values ?? {})
  const validation = validateValues(doc, boardId, values, command.body)
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

function validateValues(doc: Automerge.Doc<WorkspaceDocumentV2>, boardId: string, values: Record<string, FieldValue>, body?: string): { ok: true } | CommandFailure {
  const fields = Object.values(doc.entities).filter((entity): entity is FieldDefinition => hasEntityKind(entity, "field") && entity.placement.parentId === boardId)
  const board = doc.entities[boardId]
  const notesFieldId = hasEntityKind(board, "board") ? board.preset?.bindings["field.notes"] : undefined
  const valuesForValidation = { ...values }
  if (notesFieldId && fields.find(field => field.id === notesFieldId)?.valueType === "text" && fields.find(field => field.id === notesFieldId)?.required) {
    const legacyNote = values[notesFieldId]
    valuesForValidation[notesFieldId] = typeof legacyNote === "string" && legacyNote.trim() ? legacyNote : body ?? ""
  }
  const validation = validateItemValues(fields, valuesForValidation)
  if (validation.ok) return { ok: true }
  const field = Object.keys(validation.errors)[0]
  return err("invalid_input", validation.errors[field], field)
}

function createItemInDraft(draft: WorkspaceDocumentV2, command: CommandByKind<"createItem">, id: string, values: Record<string, FieldValue>, insertion: ReturnType<typeof computeInsertionRank>, nowIso: string) {
  applyRenumbering(draft, insertion.renumbered)
  draft.entities[id] = { id, title: command.title.trim(), body: command.body ?? "", placement: { parentId: command.parentId, rank: insertion.rank }, archivedAt: null, createdAt: nowIso, updatedAt: nowIso, lastActivityAt: nowIso, values }
}

export const patchItem: CommandHandler<"patchItem"> = (doc, command, context) => {
  const item = doc.entities[command.entityId]
  if (!isItem(item)) return err("not_found", `Item ${command.entityId} not found`)
  if (command.title !== undefined && !command.title.trim()) return err("invalid_input", "Item title cannot be empty", "title")
  const foldError = validateNarrativeFold(doc, item, command)
  if (!foldError.ok) return foldError
  const validation = validateItemPatch(doc, item, command)
  if (!validation.ok) return validation
  const changedEntityIds = [command.entityId, ...(command.foldNarrativeSources?.notes.map(note => note.id) ?? [])]
  return { ok: true, value: { changedEntityIds, apply: draft => patchItemInDraft(draft, command, context.nowIso) } }
}

function validateNarrativeFold(doc: Automerge.Doc<WorkspaceDocumentV2>, item: Item, command: CommandByKind<"patchItem">): PreparedCommand | { ok: true } {
  const fold = command.foldNarrativeSources
  if (!fold) return { ok: true }
  if (command.body === undefined) return err("invalid_input", "Narrative fold requires a replacement description")
  if (fold.notesFieldId && command.values?.[fold.notesFieldId] !== "") return err("invalid_input", "Narrative fold must clear preset Notes")
  if (item.body !== fold.expectedBody) return err("conflict", "Card description changed. Reopen card and retry.")
  if (fold.notesFieldId && item.values[fold.notesFieldId] !== fold.expectedNotes) return err("conflict", "Card notes changed. Reopen card and retry.")
  const currentNotes = Object.values(doc.entities).filter(entity => entity.kind === "document" && entity.placement.parentId === item.id && !entity.archivedAt && isInlineNarrativeNote(entity))
  if (JSON.stringify(currentNotes.map(note => note.id).sort()) !== JSON.stringify(fold.notes.map(note => note.id).sort())) return err("conflict", "Attached notes changed. Reopen card and retry.")
  const unchanged = fold.notes.every(source => {
    const note = doc.entities[source.id]
    return note?.kind === "document" && note.placement.parentId === item.id && !note.archivedAt && isInlineNarrativeNote(note) && note.title === source.title && note.content === source.content && note.format === source.format
  })
  return unchanged ? { ok: true } : err("conflict", "Attached note changed. Reopen card and retry.")
}

function validateItemPatch(doc: Automerge.Doc<WorkspaceDocumentV2>, item: Item, command: CommandByKind<"patchItem">): PreparedCommand | { ok: true } {
  if (!command.values && command.body === undefined) return { ok: true }
  const boardId = findRootBoardId(doc.entities, item.id)
  return boardId ? validateValues(doc, boardId, { ...item.values, ...command.values }, command.body ?? item.body) : { ok: true }
}

function patchItemInDraft(draft: WorkspaceDocumentV2, command: CommandByKind<"patchItem">, nowIso: string) {
  const item = draft.entities[command.entityId] as Item
  if (command.title !== undefined) item.title = command.title.trim()
  if (command.body !== undefined) item.body = command.body
  Object.assign(item.values, command.values ?? {})
  if (command.foldNarrativeSources) for (const note of command.foldNarrativeSources.notes) {
    const target = draft.entities[note.id]
    if (target?.kind === "document") { target.archivedAt = nowIso; target.updatedAt = nowIso }
  }
  item.updatedAt = nowIso
  item.lastActivityAt = nowIso
}

export const restoreItemVersion: CommandHandler<"restoreItemVersion"> = (doc, command, context) => {
  const item = doc.entities[command.entityId]
  if (!isItem(item)) return err("not_found", `Item ${command.entityId} not found`)
  const change = Automerge.getChangesMetaSince(doc, []).find(entry => entry.hash === command.changeHash)
  if (!change) return err("not_found", "Recorded item version is unavailable")
  const historical = Automerge.view(doc, [change.hash]).entities[command.entityId]
  if (!isItem(historical)) return err("not_found", "Recorded item version is unavailable")
  const parent = historical.placement.parentId ? doc.entities[historical.placement.parentId] : undefined
  if (!parent || !validatePlacementParent("item", entityKind(parent)).ok) return err("invalid_parent", "Recorded item parent is unavailable")
  const restored = JSON.parse(JSON.stringify(historical)) as Item
  return { ok: true, value: { changedEntityIds: [command.entityId], apply: draft => restoreItemInDraft(draft, command.entityId, restored, context.nowIso) } }
}

function restoreItemInDraft(draft: WorkspaceDocumentV2, id: string, restored: Item, nowIso: string) {
  const item = draft.entities[id] as Item
  item.title = restored.title; item.body = restored.body; item.values = restored.values; item.placement = restored.placement; item.archivedAt = restored.archivedAt; item.updatedAt = nowIso; item.lastActivityAt = nowIso
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
  if (hasEntityKind(parent, "column") && isArchiveColumn(parent)) return err("invalid_parent", "Archive items with setEntityArchived")
  const result = validatePlacementParent(entityKind(entity), entityKind(parent))
  if (!result.ok) return err("invalid_parent", result.error.message)
  if (findRootBoardId(doc.entities, entity.id) !== findRootBoardId(doc.entities, command.parentId)) return err("cross_board_move", "Cross-board moves are not supported")
  return { ok: true }
}

function moveEntityInDraft(draft: WorkspaceDocumentV2, command: CommandByKind<"moveEntity"> | CommandByKind<"restoreAndMove">, insertion: ReturnType<typeof computeInsertionRank>, nowIso: string, restore: boolean) {
  applyRenumbering(draft, insertion.renumbered)
  const entity = draft.entities[command.entityId]
  const movedToNewParent = entity.placement.parentId !== command.parentId
  if (restore) entity.archivedAt = null
  entity.placement = { parentId: command.parentId, rank: insertion.rank }
  entity.updatedAt = nowIso
  if (isItem(entity) && movedToNewParent) entity.lastActivityAt = nowIso
}

export const renameEntity: CommandHandler<"renameEntity"> = (doc, command, context) => {
  if (!doc.entities[command.entityId]) return err("not_found", `Entity ${command.entityId} not found`)
  if (!command.title.trim()) return err("invalid_input", "Title cannot be empty", "title")
  return { ok: true, value: { changedEntityIds: [command.entityId], apply: draft => { draft.entities[command.entityId].title = command.title.trim(); draft.entities[command.entityId].updatedAt = context.nowIso } } }
}

export const setEntityArchived: CommandHandler<"setEntityArchived"> = (doc, command, context) => {
  if (!doc.entities[command.entityId]) return err("not_found", `Entity ${command.entityId} not found`)
  return { ok: true, value: { changedEntityIds: [command.entityId], apply: draft => { draft.entities[command.entityId].archivedAt = command.archived ? context.nowIso : null; draft.entities[command.entityId].updatedAt = context.nowIso } } }
}
