import * as Automerge from "@automerge/automerge/slim"
import type {
  CommandResult,
  CommandErrorCode,
  WorkspaceDocumentV2,
  WorkspaceEntity,
  Task,
  Column,
  Board,
  FieldDefinition,
  FieldValue,
  AttachedDocument,
  DocumentTemplate,
  LegacyWritingTemplate,
  PdfArtifact,
  TransactionReceipt,
  FileReference,
  TransactionMetadataV1,
  ChangeProof,
  Heads,
} from "./model"
import { validateBoardSchemaDraft, type BoardSchemaDraft } from "./schema"
import { validateWorkspaceSettingsDraft, type WorkspaceSettingsDraft } from "./workspaceSettings"
import { validatePlacementParent } from "./model"
import {
  calculateRankBetween,
  compareRanks,
  getChildren,
  getAncestryPath,
  renumberSiblings,
} from "./ancestry"
import { validateTaskValues, patchFieldDefinition } from "./fields"
import {
  createActorBinding,
  createChangeProof,
  canonicalizeJson,
  sha256Base64Url,
  type LocalProfile,
} from "./identity"

export type Command =
  | { kind: "upgradeJobSearchRejected"; boardId: string }
  | { kind: "createWorkspace"; title: string; preset: "job-search" | "blank" }
  | { kind: "renameWorkspace"; title: string }
  | { kind: "setWorkspaceDeleted"; deleted: boolean }
  | { kind: "createBoard"; title: string; preset: "job-search" | "blank" }
  | { kind: "createColumn"; boardId: string; title: string; beforeId?: string | null }
  | { kind: "createTask"; id?: string; parentId: string; title: string; body?: string; values?: Record<string, FieldValue> }
  | { kind: "patchTask"; entityId: string; title?: string; body?: string; values?: Record<string, FieldValue> }
  | { kind: "moveEntity"; entityId: string; parentId: string; beforeId?: string | null }
  | { kind: "renameEntity"; entityId: string; title: string }
  | { kind: "setEntityDeleted"; entityId: string; deleted: boolean }
  | { kind: "restoreAndMove"; entityId: string; parentId: string; beforeId?: string | null }
  | { kind: "createField"; boardId: string; title: string; valueType: string; required: boolean; min?: number | null; max?: number | null; options?: Record<string, { title: string }> }
  | { kind: "patchField"; fieldId: string; title?: string; required?: boolean; min?: number | null; max?: number | null; valueType?: string }
  | { kind: "createFieldOption"; fieldId: string; title: string; beforeId?: string | null }
  | { kind: "patchFieldOption"; fieldId: string; optionId: string; title?: string; deleted?: boolean }
  | { kind: "addDocument"; taskId: string; documentKind: "cv" | "cover_letter" | "note" | "attachment"; title: string; format: "markdown" | "html" | "pdf" | "path"; content?: string | null; localPath?: string }
  | { kind: "patchDocument"; documentId: string; title?: string; content?: string | null }
  | { kind: "createTemplate"; title: string; markdown: string }
  | { kind: "patchTemplate"; templateId: string; title?: string; markdown?: string }
  | { kind: "recordArtifact"; taskId: string; templateId: string; title: string; artifactKind: "cv" | "cover_letter"; pdf: FileReference; sourceMarkdown?: FileReference | null }
  | { kind: "updateBoardSchema"; boardId: string; schema: BoardSchemaDraft; expectedHeads?: Heads }
  | { kind: "updateWorkspaceSettings"; settings: WorkspaceSettingsDraft; expectedHeads?: Heads }

function err<T>(code: CommandErrorCode, message: string, field?: string): CommandResult<T> {
  return { ok: false, error: { code, message, field } }
}

function findRootBoardId(entities: Record<string, WorkspaceEntity>, entityId: string): string | null {
  const visited = new Set<string>()
  let curr: WorkspaceEntity | undefined = entities[entityId]
  while (curr) {
    if (visited.has(curr.id)) return null
    visited.add(curr.id)
    if (curr.kind === "board") return curr.id
    if (curr.placement.parentId === null) return null
    curr = entities[curr.placement.parentId]
  }
  return null
}

function computeInsertionRank(
  entities: Record<string, WorkspaceEntity>,
  parentId: string | null,
  beforeId?: string | null
): { rank: string; renumbered?: Record<string, string> } {
  const siblings = getChildren(entities, parentId)
  if (siblings.length === 0) {
    return { rank: "0/1" }
  }

  if (!beforeId) {
    const last = siblings[siblings.length - 1]
    return { rank: calculateRankBetween(last.placement.rank, null) }
  }

  const targetIdx = siblings.findIndex((s) => s.id === beforeId)
  if (targetIdx === -1) {
    const last = siblings[siblings.length - 1]
    return { rank: calculateRankBetween(last.placement.rank, null) }
  }

  if (targetIdx === 0) {
    const first = siblings[0]
    return { rank: calculateRankBetween(null, first.placement.rank) }
  }

  const prev = siblings[targetIdx - 1]
  const target = siblings[targetIdx]

  if (prev.placement.rank === target.placement.rank) {
    // Equal ranks: renumber siblings
    const renumbered = renumberSiblings(siblings)
    const map: Record<string, string> = {}
    for (const r of renumbered) {
      map[r.id] = r.placement.rank
    }
    // targetIdx is now between targetIdx-1 and targetIdx
    const newPrevRank = `${targetIdx - 1}/1`
    const newTargetRank = `${targetIdx}/1`
    return {
      rank: calculateRankBetween(newPrevRank, newTargetRank),
      renumbered: map,
    }
  }

  return { rank: calculateRankBetween(prev.placement.rank, target.placement.rank) }
}

function applyBoardSchemaSettings(
  draft: WorkspaceDocumentV2,
  boardId: string,
  schema: BoardSchemaDraft,
  nowIso: string,
  changedEntityIds: string[],
) {
  const board = draft.entities[boardId] as Board
  board.title = schema.boardTitle.trim()
  board.entityName = schema.entityName.trim()
  board.updatedAt = nowIso
  changedEntityIds.push(boardId)

  const existingColumns = Object.values(draft.entities).filter(
    (entity): entity is Column => entity.kind === "column" && entity.placement.parentId === boardId
  )
  const columnIds = new Set<string>()
  schema.columns.forEach((column, index) => {
    const id = column.id || `col-${crypto.randomUUID()}`
    columnIds.add(id)
    const existing = draft.entities[id]
    if (existing?.kind === "column") {
      existing.title = column.title.trim()
      existing.displayHint = column.displayHint || "normal"
      existing.placement = { parentId: boardId, rank: `${index}/1` }
      existing.deleted = false
      existing.updatedAt = nowIso
    } else {
      draft.entities[id] = {
        id,
        kind: "column",
        title: column.title.trim(),
        displayHint: column.displayHint || "normal",
        placement: { parentId: boardId, rank: `${index}/1` },
        deleted: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      }
    }
    changedEntityIds.push(id)
  })
  for (const column of existingColumns) {
    if (!columnIds.has(column.id) && !column.deleted) {
      const target = draft.entities[column.id] as Column
      target.deleted = true
      target.updatedAt = nowIso
      changedEntityIds.push(column.id)
    }
  }

  const existingFields = Object.values(draft.entities).filter(
    (entity): entity is FieldDefinition => entity.kind === "field" && entity.placement.parentId === boardId
  )
  const fieldIds = new Set<string>()
  schema.fields.forEach((field, index) => {
    const id = field.id || `field-${crypto.randomUUID()}`
    fieldIds.add(id)
    const existing = draft.entities[id]
    let target: any
    if (existing?.kind === "field") {
      target = existing
      target.title = field.title.trim()
      target.valueType = field.valueType
      target.required = field.required
      target.placement = { parentId: boardId, rank: `${index}/1` }
      target.deleted = false
      target.updatedAt = nowIso
    } else {
      target = {
        id,
        kind: "field",
        title: field.title.trim(),
        valueType: field.valueType,
        required: field.required,
        placement: { parentId: boardId, rank: `${index}/1` },
        deleted: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      }
      draft.entities[id] = target
      target = draft.entities[id]
    }
    changedEntityIds.push(id)

    if (field.valueType === "number") {
      target.min = field.min ?? null
      target.max = field.max ?? null
    } else if (field.valueType === "select") {
      if (!target.options) target.options = {}
      const optionIds = new Set<string>()
      ;(field.options || []).forEach((option, optionIndex) => {
        const optionId = option.id || `opt-${crypto.randomUUID()}`
        optionIds.add(optionId)
        target.options[optionId] = {
          id: optionId,
          title: option.title.trim(),
          rank: `${optionIndex}/1`,
          deleted: false,
        }
      })
      for (const optionId of Object.keys(target.options)) {
        if (!optionIds.has(optionId)) target.options[optionId].deleted = true
      }
    } else {
      delete target.min
      delete target.max
      delete target.options
    }
  })
  for (const field of existingFields) {
    if (!fieldIds.has(field.id) && !field.deleted) {
      const target = draft.entities[field.id] as FieldDefinition
      target.deleted = true
      target.updatedAt = nowIso
      changedEntityIds.push(field.id)
    }
  }
}

export async function executeCommand(
  doc: Automerge.Doc<WorkspaceDocumentV2>,
  command: Command,
  profile: LocalProfile,
  actorId?: string
): Promise<CommandResult<{ newDoc: Automerge.Doc<WorkspaceDocumentV2>; receipt: TransactionReceipt; proof: ChangeProof }>> {
  const txId = crypto.randomUUID()
  const nowIso = new Date().toISOString()
  const beforeHeads = Automerge.getHeads(doc).sort()
  const changedEntityIds: string[] = []

  let applyFn: ((draft: WorkspaceDocumentV2) => void) | null = null

  switch (command.kind) {
    case "renameWorkspace": {
      if (!command.title.trim()) return err("invalid_input", "Workspace name is required", "title")
      applyFn = draft => { draft.title = command.title.trim() }
      break
    }

    case "upgradeJobSearchRejected": {
      const board = doc.entities[command.boardId] as Board | undefined
      if (board?.kind !== "board" || board.preset?.key !== "job-search") {
        return err("invalid_input", "Expected a Job search board")
      }
      const additions: Array<{ binding: string; entity: WorkspaceEntity }> = []
      const definitions = [
        { binding: "status.rejected", kind: "column", title: "Rejected" },
        { binding: "field.rejectionReason", kind: "field", title: "Rejection reason" },
      ] as const
      for (const definition of definitions) {
        // Existing bindings include intentionally soft-deleted schema elements.
        if (board.preset.bindings[definition.binding]) continue
        const existing = Object.values(doc.entities).find((entity) =>
          entity.kind === definition.kind && entity.placement.parentId === board.id && entity.title === definition.title
        )
        const id = existing?.id ?? `${board.id}:${definition.binding}`
        if (!existing && doc.entities[id]) return err("invalid_input", "Preset upgrade ID collision")
        const rank = computeInsertionRank(doc.entities, board.id,
          definition.kind === "column" ? board.preset.bindings["status.offer"] : null).rank
        const base = { id, title: definition.title, placement: { parentId: board.id, rank }, deleted: false, createdAt: nowIso, updatedAt: nowIso }
        const entity: WorkspaceEntity = existing ?? (definition.kind === "column"
          ? { ...base, kind: "column", displayHint: "normal" }
          : { ...base, kind: "field", valueType: "text", required: false })
        additions.push({ binding: definition.binding, entity })
        changedEntityIds.push(id)
      }
      changedEntityIds.push(board.id)
      applyFn = (draft) => {
        const target = draft.entities[board.id] as Board
        for (const { binding, entity } of additions) {
          if (!draft.entities[entity.id]) draft.entities[entity.id] = entity
          target.preset!.bindings[binding] = entity.id
        }
      }
      break
    }
    case "createTask": {
      if (!command.title || !command.title.trim()) {
        return err("invalid_input", "Task title is required", "title")
      }
      const parent = doc.entities[command.parentId]
      if (!parent) return err("not_found", `Parent ${command.parentId} not found`)
      const validParent = validatePlacementParent("task", parent.kind)
      if (!validParent.ok) return err("invalid_parent", validParent.error.message)

      // Validate board fields
      const boardId = findRootBoardId(doc.entities, command.parentId)
      if (boardId) {
        const board = doc.entities[boardId] as Board | undefined
        const bindings = board?.preset?.bindings ?? {}
        const companyFieldId = bindings["field.company"]
        const roleFieldId = bindings["field.role"]

        const taskValues = { ...(command.values ?? {}) }
        if (companyFieldId && !taskValues[companyFieldId]) {
          taskValues[companyFieldId] = command.title.includes(" — ")
            ? command.title.split(" — ")[0].trim()
            : command.title.trim()
        }
        if (roleFieldId && !taskValues[roleFieldId]) {
          taskValues[roleFieldId] = command.title.includes(" — ")
            ? command.title.split(" — ").slice(1).join(" — ").trim()
            : command.title.trim()
        }
        command.values = taskValues

        const boardFields = Object.values(doc.entities).filter(
          (e): e is FieldDefinition => e.kind === "field" && e.placement.parentId === boardId
        )
        const valRes = validateTaskValues(boardFields, command.values)
        if (!valRes.ok) {
          const firstErrKey = Object.keys(valRes.errors)[0]
          return err("invalid_input", valRes.errors[firstErrKey], firstErrKey)
        }
      }

      const taskId = command.id ?? crypto.randomUUID()
      const { rank, renumbered } = computeInsertionRank(doc.entities, command.parentId)
      changedEntityIds.push(taskId)

      applyFn = (draft) => {
        if (renumbered) {
          for (const [id, newRank] of Object.entries(renumbered)) {
            if (draft.entities[id]) draft.entities[id].placement = { ...draft.entities[id].placement, rank: newRank }
          }
        }
        draft.entities[taskId] = {
          id: taskId,
          kind: "task",
          title: command.title.trim(),
          body: command.body ?? "",
          placement: { parentId: command.parentId, rank },
          deleted: false,
          createdAt: nowIso,
          updatedAt: nowIso,
          values: command.values ?? {},
        }
      }
      break
    }

    case "patchTask": {
      const task = doc.entities[command.entityId]
      if (!task || task.kind !== "task") return err("not_found", `Task ${command.entityId} not found`)
      if (command.title !== undefined && !command.title.trim()) {
        return err("invalid_input", "Task title cannot be empty", "title")
      }

      if (command.values) {
        const boardId = findRootBoardId(doc.entities, task.id)
        if (boardId) {
          const boardFields = Object.values(doc.entities).filter(
            (e): e is FieldDefinition => e.kind === "field" && e.placement.parentId === boardId
          )
          const mergedValues = { ...task.values, ...command.values }
          const valRes = validateTaskValues(boardFields, mergedValues)
          if (!valRes.ok) {
            const firstErr = Object.keys(valRes.errors)[0]
            return err("invalid_input", valRes.errors[firstErr], firstErr)
          }
        }
      }

      changedEntityIds.push(command.entityId)
      applyFn = (draft) => {
        const t = draft.entities[command.entityId] as Task
        if (command.title !== undefined) t.title = command.title.trim()
        if (command.body !== undefined) t.body = command.body
        if (command.values) {
          for (const [k, v] of Object.entries(command.values)) {
            t.values[k] = v
          }
        }
        t.updatedAt = nowIso
      }
      break
    }

    case "moveEntity": {
      const entity = doc.entities[command.entityId]
      if (!entity) return err("not_found", `Entity ${command.entityId} not found`)

      // Check cycle
      if (command.parentId === command.entityId) {
        return err("cycle", "Cannot place an entity under itself")
      }
      const { path } = getAncestryPath(doc.entities, command.parentId)
      if (path.includes(command.entityId)) {
        return err("cycle", "Cannot place an entity under its descendant")
      }

      // Check target parent kind
      const targetParent = doc.entities[command.parentId]
      if (!targetParent) return err("not_found", `Target parent ${command.parentId} not found`)
      const validParent = validatePlacementParent(entity.kind, targetParent.kind)
      if (!validParent.ok) return err("invalid_parent", validParent.error.message)

      // Cross-board move check
      const currentBoard = findRootBoardId(doc.entities, entity.id)
      const targetBoard = findRootBoardId(doc.entities, command.parentId)
      if (currentBoard && targetBoard && currentBoard !== targetBoard) {
        return err("cross_board_move", "Cross-board moves are not supported")
      }

      const { rank, renumbered } = computeInsertionRank(doc.entities, command.parentId, command.beforeId)
      changedEntityIds.push(command.entityId)

      applyFn = (draft) => {
        if (renumbered) {
          for (const [id, newRank] of Object.entries(renumbered)) {
            if (draft.entities[id]) draft.entities[id].placement = { ...draft.entities[id].placement, rank: newRank }
          }
        }
        draft.entities[command.entityId].placement = { parentId: command.parentId, rank }
        draft.entities[command.entityId].updatedAt = nowIso
      }
      break
    }

    case "renameEntity": {
      const entity = doc.entities[command.entityId]
      if (!entity) return err("not_found", `Entity ${command.entityId} not found`)
      if (!command.title || !command.title.trim()) {
        return err("invalid_input", "Title cannot be empty", "title")
      }
      changedEntityIds.push(command.entityId)
      applyFn = (draft) => {
        draft.entities[command.entityId].title = command.title.trim()
        draft.entities[command.entityId].updatedAt = nowIso
      }
      break
    }

    case "setEntityDeleted": {
      const entity = doc.entities[command.entityId]
      if (!entity) return err("not_found", `Entity ${command.entityId} not found`)
      changedEntityIds.push(command.entityId)
      applyFn = (draft) => {
        draft.entities[command.entityId].deleted = command.deleted
        draft.entities[command.entityId].updatedAt = nowIso
      }
      break
    }

    case "restoreAndMove": {
      const entity = doc.entities[command.entityId]
      if (!entity) return err("not_found", `Entity ${command.entityId} not found`)

      // Check cycle and target parent
      if (command.parentId === command.entityId) return err("cycle", "Cannot place under itself")
      const { path } = getAncestryPath(doc.entities, command.parentId)
      if (path.includes(command.entityId)) return err("cycle", "Cannot place under descendant")

      const targetParent = doc.entities[command.parentId]
      if (!targetParent) return err("not_found", `Target parent ${command.parentId} not found`)
      const validParent = validatePlacementParent(entity.kind, targetParent.kind)
      if (!validParent.ok) return err("invalid_parent", validParent.error.message)

      const { rank, renumbered } = computeInsertionRank(doc.entities, command.parentId, command.beforeId)
      changedEntityIds.push(command.entityId)

      applyFn = (draft) => {
        if (renumbered) {
          for (const [id, newRank] of Object.entries(renumbered)) {
            if (draft.entities[id]) draft.entities[id].placement = { ...draft.entities[id].placement, rank: newRank }
          }
        }
        draft.entities[command.entityId].deleted = false
        draft.entities[command.entityId].placement = { parentId: command.parentId, rank }
        draft.entities[command.entityId].updatedAt = nowIso
      }
      break
    }

    case "createColumn": {
      if (!command.title || !command.title.trim()) {
        return err("invalid_input", "Column title cannot be empty", "title")
      }
      const board = doc.entities[command.boardId]
      if (!board || board.kind !== "board") return err("not_found", `Board ${command.boardId} not found`)

      const colId = crypto.randomUUID()
      const { rank, renumbered } = computeInsertionRank(doc.entities, command.boardId, command.beforeId)
      changedEntityIds.push(colId)

      applyFn = (draft) => {
        if (renumbered) {
          for (const [id, newRank] of Object.entries(renumbered)) {
            if (draft.entities[id]) draft.entities[id].placement = { ...draft.entities[id].placement, rank: newRank }
          }
        }
        draft.entities[colId] = {
          id: colId,
          kind: "column",
          title: command.title.trim(),
          placement: { parentId: command.boardId, rank },
          displayHint: "normal",
          deleted: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
      }
      break
    }

    case "createField": {
      if (!command.title || !command.title.trim()) {
        return err("invalid_input", "Field title cannot be empty", "title")
      }
      const board = doc.entities[command.boardId]
      if (!board || board.kind !== "board") return err("not_found", `Board ${command.boardId} not found`)

      const fieldId = crypto.randomUUID()
      const { rank } = computeInsertionRank(doc.entities, command.boardId)
      changedEntityIds.push(fieldId)

      const fieldBase = {
        id: fieldId,
        kind: "field" as const,
        title: command.title.trim(),
        placement: { parentId: command.boardId, rank },
        deleted: false,
        createdAt: nowIso,
        updatedAt: nowIso,
        required: command.required,
      }

      applyFn = (draft) => {
        if (command.valueType === "select") {
          const opts: Record<string, any> = {}
          if (command.options) {
            let idx = 0
            for (const opt of Object.values(command.options)) {
              const optId = crypto.randomUUID()
              opts[optId] = { id: optId, title: opt.title, rank: `${idx++}/1`, deleted: false }
            }
          }
          draft.entities[fieldId] = {
            ...fieldBase,
            valueType: "select",
            options: opts,
          }
        } else if (command.valueType === "number") {
          draft.entities[fieldId] = {
            ...fieldBase,
            valueType: "number",
            min: command.min ?? null,
            max: command.max ?? null,
          }
        } else {
          draft.entities[fieldId] = {
            ...fieldBase,
            valueType: command.valueType as any,
          }
        }
      }
      break
    }

    case "patchField": {
      const field = doc.entities[command.fieldId]
      if (!field || field.kind !== "field") return err("not_found", `Field ${command.fieldId} not found`)
      const patchRes = patchFieldDefinition(field, command)
      if (!patchRes.ok) return patchRes

      changedEntityIds.push(command.fieldId)
      applyFn = (draft) => {
        draft.entities[command.fieldId] = patchRes.value
      }
      break
    }

    case "createTemplate": {
      if (!command.title || !command.title.trim()) {
        return err("invalid_input", "Template title is required", "title")
      }
      const templateId = (command as any).id ?? crypto.randomUUID()
      const { rank, renumbered } = computeInsertionRank(doc.entities, null)
      changedEntityIds.push(templateId)
      applyFn = (draft) => {
        if (renumbered) {
          for (const [id, newRank] of Object.entries(renumbered)) {
            draft.entities[id].placement = { parentId: draft.entities[id].placement.parentId, rank: newRank }
          }
        }
        draft.entities[templateId] = {
          id: templateId,
          kind: "document_template",
          title: command.title.trim(),
          markdown: command.markdown ?? "",
          placement: { parentId: null, rank },
          deleted: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
      }
      break
    }

    case "patchTemplate": {
      const entity = doc.entities[command.templateId]
      if (!entity || (entity.kind !== "document_template" && entity.kind !== "template")) return err("not_found", `Document template ${command.templateId} not found`)
      changedEntityIds.push(command.templateId)
      applyFn = (draft) => {
        const t = draft.entities[command.templateId] as DocumentTemplate
        if (command.title !== undefined) t.title = command.title.trim()
        if (command.markdown !== undefined) t.markdown = command.markdown
        t.updatedAt = nowIso
      }
      break
    }

    case "addDocument": {
      if (!command.title || !command.title.trim()) {
        return err("invalid_input", "Document title is required", "title")
      }
      const task = doc.entities[command.taskId]
      if (!task || task.kind !== "task") return err("not_found", `Task ${command.taskId} not found`)
      const docId = (command as any).id ?? crypto.randomUUID()
      const { rank, renumbered } = computeInsertionRank(doc.entities, command.taskId)
      changedEntityIds.push(docId)
      applyFn = (draft) => {
        if (renumbered) {
          for (const [id, newRank] of Object.entries(renumbered)) {
            draft.entities[id].placement = { parentId: draft.entities[id].placement.parentId, rank: newRank }
          }
        }
        draft.entities[docId] = {
          id: docId,
          kind: "document",
          title: command.title.trim(),
          documentKind: command.documentKind,
          format: command.format,
          content: command.content ?? null,
          file: command.localPath
            ? { type: "local-file", fileId: crypto.randomUUID(), fileName: command.localPath }
            : null,
          placement: { parentId: command.taskId, rank },
          deleted: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
      }
      break
    }

    case "patchDocument": {
      const entity = doc.entities[command.documentId]
      if (!entity || entity.kind !== "document") return err("not_found", `Document ${command.documentId} not found`)
      changedEntityIds.push(command.documentId)
      applyFn = (draft) => {
        const d = draft.entities[command.documentId] as AttachedDocument
        if (command.title !== undefined) d.title = command.title.trim()
        if (command.content !== undefined) d.content = command.content
        d.updatedAt = nowIso
      }
      break
    }

    case "recordArtifact": {
      if (!command.title || !command.title.trim()) {
        return err("invalid_input", "Artifact title is required", "title")
      }
      const task = doc.entities[command.taskId]
      if (!task || task.kind !== "task") return err("not_found", `Task ${command.taskId} not found`)
      const artId = (command as any).id ?? crypto.randomUUID()
      const { rank, renumbered } = computeInsertionRank(doc.entities, command.taskId)
      changedEntityIds.push(artId)
      applyFn = (draft) => {
        if (renumbered) {
          for (const [id, newRank] of Object.entries(renumbered)) {
            draft.entities[id].placement = { parentId: draft.entities[id].placement.parentId, rank: newRank }
          }
        }
        draft.entities[artId] = {
          id: artId,
          kind: "artifact",
          title: command.title.trim(),
          artifactKind: command.artifactKind,
          templateId: command.templateId,
          pdf: command.pdf,
          sourceMarkdown: command.sourceMarkdown ?? null,
          placement: { parentId: command.taskId, rank },
          deleted: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
      }
      break
    }

    case "createFieldOption": {
      if (!command.title || !command.title.trim()) {
        return err("invalid_input", "Option title is required", "title")
      }
      const field = doc.entities[command.fieldId]
      if (!field || field.kind !== "field") return err("not_found", `Field ${command.fieldId} not found`)
      if (field.valueType !== "select") return err("invalid_input", `Field ${command.fieldId} is not a select field`)

      const optionId = crypto.randomUUID()
      const existingOpts = Object.values(field.options || {})
        .filter((o) => !o.deleted)
        .sort((a, b) => compareRanks(a.rank, b.rank))

      let rank = "0/1"
      if (command.beforeId) {
        const idx = existingOpts.findIndex((o) => o.id === command.beforeId)
        if (idx === 0) {
          rank = calculateRankBetween(null, existingOpts[0].rank)
        } else if (idx > 0) {
          rank = calculateRankBetween(existingOpts[idx - 1].rank, existingOpts[idx].rank)
        } else if (existingOpts.length > 0) {
          rank = calculateRankBetween(existingOpts[existingOpts.length - 1].rank, null)
        }
      } else if (existingOpts.length > 0) {
        rank = calculateRankBetween(existingOpts[existingOpts.length - 1].rank, null)
      }

      changedEntityIds.push(command.fieldId)
      applyFn = (draft) => {
        const f = draft.entities[command.fieldId] as any
        if (!f.options) f.options = {}
        f.options[optionId] = {
          id: optionId,
          title: command.title.trim(),
          rank,
          deleted: false,
        }
        f.updatedAt = nowIso
      }
      break
    }

    case "patchFieldOption": {
      const field = doc.entities[command.fieldId]
      if (!field || field.kind !== "field") return err("not_found", `Field ${command.fieldId} not found`)
      if (field.valueType !== "select") return err("invalid_input", `Field ${command.fieldId} is not a select field`)
      const opt = field.options?.[command.optionId]
      if (!opt) return err("not_found", `Option ${command.optionId} not found`)

      changedEntityIds.push(command.fieldId)
      applyFn = (draft) => {
        const f = draft.entities[command.fieldId] as any
        const targetOpt = f.options[command.optionId]
        if (command.title !== undefined) targetOpt.title = command.title.trim()
        if (command.deleted !== undefined) targetOpt.deleted = command.deleted
        f.updatedAt = nowIso
      }
      break
    }

    case "updateWorkspaceSettings": {
      const validation = validateWorkspaceSettingsDraft(command.settings, doc)
      if (!validation.valid) {
        const first = validation.errors[0]
        return err("invalid_input", first.message, first.path)
      }
      if (command.expectedHeads && command.expectedHeads.length > 0) {
        const expected = [...command.expectedHeads].sort()
        if (beforeHeads.length !== expected.length || beforeHeads.some((head, index) => head !== expected[index])) {
          return err("conflict", "Concurrent edits arrived while workspace settings were open")
        }
      }

      const boardId = command.settings.board.boardId
      applyFn = (draft) => {
        draft.title = command.settings.workspace.title.trim()
        applyBoardSchemaSettings(draft, boardId, command.settings.board, nowIso, changedEntityIds)

        const existingTemplates = Object.values(draft.entities).filter(
          (entity): entity is DocumentTemplate | LegacyWritingTemplate => entity.kind === "document_template" || entity.kind === "template"
        )
        const templateIds = new Set<string>()
        command.settings.documentTemplates.forEach((template, index) => {
          const id = template.id || `template-${crypto.randomUUID()}`
          templateIds.add(id)
          const existing = draft.entities[id]
          if (existing && (existing.kind === "document_template" || existing.kind === "template")) {
            existing.title = template.title.trim()
            existing.markdown = template.markdown
            existing.placement = { parentId: null, rank: `${index + 1}/1` }
            existing.deleted = false
            existing.updatedAt = nowIso
          } else {
            draft.entities[id] = {
              id,
              kind: "document_template",
              title: template.title.trim(),
              markdown: template.markdown,
              placement: { parentId: null, rank: `${index + 1}/1` },
              deleted: false,
              createdAt: nowIso,
              updatedAt: nowIso,
            }
          }
          changedEntityIds.push(id)
        })
        for (const template of existingTemplates) {
          if (!templateIds.has(template.id) && !template.deleted) {
            template.deleted = true
            template.updatedAt = nowIso
            changedEntityIds.push(template.id)
          }
        }
      }
      break
    }

    case "updateBoardSchema": {
      const board = doc.entities[command.boardId]
      if (!board || board.kind !== "board") return err("not_found", `Board ${command.boardId} not found`)

      if (command.expectedHeads && command.expectedHeads.length > 0) {
        const currentSorted = [...beforeHeads].sort()
        const expectedSorted = [...command.expectedHeads].sort()
        if (currentSorted.length !== expectedSorted.length || currentSorted.some((h, i) => h !== expectedSorted[i])) {
          return err("conflict", "Concurrent edits arrived while schema draft was open")
        }
      }

      const validation = validateBoardSchemaDraft(command.schema)
      if (!validation.valid) {
        const first = validation.errors[0]
        return err("invalid_input", first.message, first.path)
      }

      changedEntityIds.push(command.boardId)

      applyFn = (draft) => {
        const b = draft.entities[command.boardId] as any
        if (command.schema.boardTitle.trim() && b.title !== command.schema.boardTitle.trim()) {
          b.title = command.schema.boardTitle.trim()
          b.updatedAt = nowIso
        }
        if (command.schema.entityName.trim() && b.entityName !== command.schema.entityName.trim()) {
          b.entityName = command.schema.entityName.trim()
          b.updatedAt = nowIso
        }

        // 1. Process columns
        const existingColumns = Object.values(draft.entities).filter(
          (e: any) => e.kind === "column" && e.placement.parentId === command.boardId
        ) as Column[]

        const draftColIds = new Set<string>()
        command.schema.columns.forEach((c, idx) => {
          const colRank = `${idx}/1`
          if (c.id && draft.entities[c.id]) {
            draftColIds.add(c.id)
            const col = draft.entities[c.id] as any
            col.title = c.title.trim()
            if (c.displayHint) col.displayHint = c.displayHint
            col.placement = { parentId: command.boardId, rank: colRank }
            col.deleted = false
            col.updatedAt = nowIso
            changedEntityIds.push(c.id)
          } else {
            const newId = c.id || `col-${crypto.randomUUID()}`
            draftColIds.add(newId)
            draft.entities[newId] = {
              id: newId,
              kind: "column",
              title: c.title.trim(),
              displayHint: c.displayHint || "normal",
              placement: { parentId: command.boardId, rank: colRank },
              deleted: false,
              createdAt: nowIso,
              updatedAt: nowIso,
            }
            changedEntityIds.push(newId)
          }
        })

        // Soft-delete removed columns (preserve child tasks and relationships!)
        for (const existingCol of existingColumns) {
          if (!draftColIds.has(existingCol.id) && !existingCol.deleted) {
            const col = draft.entities[existingCol.id] as any
            col.deleted = true
            col.updatedAt = nowIso
            changedEntityIds.push(existingCol.id)
          }
        }

        // 2. Process fields
        const existingFields = Object.values(draft.entities).filter(
          (e: any) => e.kind === "field" && e.placement.parentId === command.boardId
        ) as FieldDefinition[]

        const draftFieldIds = new Set<string>()
        command.schema.fields.forEach((fld, idx) => {
          const fieldRank = `${idx}/1`
          let targetField: any
          if (fld.id && draft.entities[fld.id]) {
            draftFieldIds.add(fld.id)
            targetField = draft.entities[fld.id]
            targetField.title = fld.title.trim()
            targetField.valueType = fld.valueType
            targetField.required = fld.required
            targetField.placement = { parentId: command.boardId, rank: fieldRank }
            targetField.deleted = false
            targetField.updatedAt = nowIso
            changedEntityIds.push(fld.id)
          } else {
            const newId = fld.id || `field-${crypto.randomUUID()}`
            draftFieldIds.add(newId)
            targetField = {
              id: newId,
              kind: "field",
              title: fld.title.trim(),
              valueType: fld.valueType,
              required: fld.required,
              placement: { parentId: command.boardId, rank: fieldRank },
              deleted: false,
              createdAt: nowIso,
              updatedAt: nowIso,
            }
            draft.entities[newId] = targetField
            targetField = draft.entities[newId]
            changedEntityIds.push(newId)
          }

          if (fld.valueType === "number") {
            targetField.min = fld.min ?? null
            targetField.max = fld.max ?? null
          } else if (fld.valueType === "select") {
            if (!targetField.options) targetField.options = {}
            const draftOptIds = new Set<string>()
            ;(fld.options || []).forEach((opt, optIdx) => {
              const optRank = `${optIdx}/1`
              if (opt.id && targetField.options[opt.id]) {
                draftOptIds.add(opt.id)
                targetField.options[opt.id].title = opt.title.trim()
                targetField.options[opt.id].rank = optRank
                targetField.options[opt.id].deleted = false
              } else {
                const newOptId = opt.id || `opt-${crypto.randomUUID()}`
                draftOptIds.add(newOptId)
                targetField.options[newOptId] = {
                  id: newOptId,
                  title: opt.title.trim(),
                  rank: optRank,
                  deleted: false,
                }
              }
            })

            // Soft-delete removed options
            for (const optId of Object.keys(targetField.options)) {
              if (!draftOptIds.has(optId)) {
                targetField.options[optId].deleted = true
              }
            }
          }
        })

        // Soft-delete removed fields
        for (const existingFld of existingFields) {
          if (!draftFieldIds.has(existingFld.id) && !existingFld.deleted) {
            const fld = draft.entities[existingFld.id] as any
            fld.deleted = true
            fld.updatedAt = nowIso
            changedEntityIds.push(existingFld.id)
          }
        }
      }
      break
    }

    default:
      return err("invalid_input", `Command kind not supported or unknown: ${(command as any).kind}`)
  }

  const metadata: TransactionMetadataV1 = {
    version: 1,
    transactionId: txId,
    action: command.kind,
    entityIds: changedEntityIds,
    personId: profile.identity.personId,
    deviceId: profile.device.deviceId,
  }

  const newDoc = Automerge.change(
    Automerge.clone(doc),
    { message: JSON.stringify(metadata) },
    (draft) => {
      applyFn?.(draft)
    }
  )

  const changeBytes = Automerge.getLastLocalChange(newDoc)
  if (!changeBytes) {
    return err("storage_failed", "Automerge produced no change")
  }

  const decoded = Automerge.decodeChange(changeBytes)
  const changeHash = decoded.hash
  const afterHeads = Automerge.getHeads(newDoc).sort()

  const currentActorId = actorId || profile.device.deviceId
  const actorBinding = await createActorBinding(profile, newDoc.id, currentActorId)
  const bindingHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(actorBinding)))

  const proof = await createChangeProof(profile, newDoc.id, changeHash, bindingHash)

  const receipt: TransactionReceipt = {
    transactionId: txId,
    beforeHeads,
    afterHeads,
    changeHash,
    changedEntityIds,
    saved: true,
  }

  return {
    ok: true,
    value: {
      newDoc,
      receipt,
      proof,
    },
  }
}

export function createCommandQueue(
  initialDoc: Automerge.Doc<WorkspaceDocumentV2>,
  profile: LocalProfile,
  actorId?: string
) {
  let currentDoc = initialDoc
  let queue: Promise<any> = Promise.resolve()

  return {
    getDocument(): Automerge.Doc<WorkspaceDocumentV2> {
      return currentDoc
    },
    transact(command: Command): Promise<CommandResult<{ receipt: TransactionReceipt; proof: ChangeProof }>> {
      const run = async () => {
        const result = await executeCommand(currentDoc, command, profile, actorId)
        if (result.ok) {
          currentDoc = result.value.newDoc
          return {
            ok: true as const,
            value: {
              receipt: result.value.receipt,
              proof: result.value.proof,
            },
          }
        }
        return result
      }
      const next = queue.then(run, run)
      queue = next
      return next
    },
  }
}
