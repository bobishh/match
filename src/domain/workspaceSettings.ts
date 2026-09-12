import type { Board, DocumentTemplate, LegacyWritingTemplate, WorkspaceDocumentV2 } from "./model"
import { compareRanks } from "./ancestry"
import { projectBoardSchema, validateBoardSchemaDraft, type BoardSchemaDraft, type SchemaValidationError } from "./schema"

export type WorkspaceDocumentTemplateDraft = {
  id?: string
  title: string
  markdown: string
}

export type WorkspaceSettingsDraft = {
  formatVersion: 1
  workspace: { title: string }
  board: BoardSchemaDraft
  documentTemplates: WorkspaceDocumentTemplateDraft[]
}

export type WorkspaceSettingsValidationResult = {
  valid: boolean
  errors: SchemaValidationError[]
}

function unknownKeys(value: Record<string, unknown>, allowed: string[], path: string, errors: SchemaValidationError[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ path: `${path}/${key}`, message: "Unknown setting" })
  }
}

export function projectWorkspaceSettings(doc: WorkspaceDocumentV2, boardId?: string): WorkspaceSettingsDraft {
  const board = boardId
    ? doc.entities[boardId] as Board | undefined
    : Object.values(doc.entities).find((entity): entity is Board => entity.kind === "board" && !entity.deleted)
  if (!board || board.kind !== "board") throw new Error("Active board not found")

  const documentTemplates = Object.values(doc.entities)
    .filter((entity): entity is DocumentTemplate | LegacyWritingTemplate =>
      (entity.kind === "document_template" || entity.kind === "template") && !entity.deleted
    )
    .sort((a, b) => compareRanks(a.placement.rank, b.placement.rank))
    .map((template) => ({ id: template.id, title: template.title, markdown: template.markdown }))

  return {
    formatVersion: 1,
    workspace: { title: doc.title },
    board: projectBoardSchema(doc, board.id),
    documentTemplates,
  }
}

export function validateWorkspaceSettingsDraft(
  draft: unknown,
  doc?: WorkspaceDocumentV2,
): WorkspaceSettingsValidationResult {
  const errors: SchemaValidationError[] = []
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    return { valid: false, errors: [{ path: "", message: "Workspace settings must be a JSON object" }] }
  }
  const value = draft as Record<string, any>
  unknownKeys(value, ["formatVersion", "workspace", "board", "documentTemplates"], "", errors)

  if (value.formatVersion !== 1) errors.push({ path: "/formatVersion", message: "formatVersion must be 1" })
  if (!value.workspace || typeof value.workspace !== "object" || Array.isArray(value.workspace)) {
    errors.push({ path: "/workspace", message: "workspace must be an object" })
  } else {
    unknownKeys(value.workspace, ["title"], "/workspace", errors)
    if (typeof value.workspace.title !== "string" || !value.workspace.title.trim()) {
      errors.push({ path: "/workspace/title", message: "Workspace title is required" })
    }
  }

  const boardValidation = validateBoardSchemaDraft(value.board)
  errors.push(...boardValidation.errors.map((error) => ({
    path: `/board${error.path}`,
    message: error.message,
  })))
  if (value.board && typeof value.board === "object" && !Array.isArray(value.board)) {
    unknownKeys(value.board, ["boardId", "boardTitle", "entityName", "columns", "fields"], "/board", errors)
    if (typeof value.board.boardId !== "string" || !value.board.boardId) {
      errors.push({ path: "/board/boardId", message: "boardId is required" })
    } else if (doc) {
      const board = doc.entities[value.board.boardId]
      if (!board || board.kind !== "board") errors.push({ path: "/board/boardId", message: "boardId must identify this workspace board" })
    }
    if (doc && typeof value.board.boardId === "string") {
      const seenColumnIds = new Set<string>()
      for (const [index, column] of (Array.isArray(value.board.columns) ? value.board.columns : []).entries()) {
        if (column && typeof column === "object" && !Array.isArray(column)) {
          unknownKeys(column, ["id", "title", "archive"], `/board/columns/${index}`, errors)
        }
        if (typeof column?.id !== "string") continue
        if (seenColumnIds.has(column.id)) errors.push({ path: `/board/columns/${index}/id`, message: "Column id is duplicated" })
        seenColumnIds.add(column.id)
        const entity = doc.entities[column.id]
        if (!entity || entity.kind !== "column" || entity.placement.parentId !== value.board.boardId) {
          errors.push({ path: `/board/columns/${index}/id`, message: "id must identify a column on this board" })
        }
      }
      const seenFieldIds = new Set<string>()
      for (const [index, field] of (Array.isArray(value.board.fields) ? value.board.fields : []).entries()) {
        if (typeof field?.id !== "string") continue
        if (seenFieldIds.has(field.id)) errors.push({ path: `/board/fields/${index}/id`, message: "Field id is duplicated" })
        seenFieldIds.add(field.id)
        const entity = doc.entities[field.id]
        if (!entity || entity.kind !== "field" || entity.placement.parentId !== value.board.boardId) {
          errors.push({ path: `/board/fields/${index}/id`, message: "id must identify a field on this board" })
        } else if (field.valueType !== entity.valueType) {
          errors.push({ path: `/board/fields/${index}/valueType`, message: "Field type cannot change" })
        }
      }
    }
  }

  if (!Array.isArray(value.documentTemplates)) {
    errors.push({ path: "/documentTemplates", message: "documentTemplates must be an array" })
  } else {
    const seenTemplateIds = new Set<string>()
    value.documentTemplates.forEach((template: unknown, index: number) => {
      const path = `/documentTemplates/${index}`
      if (!template || typeof template !== "object" || Array.isArray(template)) {
        errors.push({ path, message: "Document template must be an object" })
        return
      }
      const item = template as Record<string, unknown>
      unknownKeys(item, ["id", "title", "markdown"], path, errors)
      if (item.id !== undefined && typeof item.id !== "string") errors.push({ path: `${path}/id`, message: "id must be a string" })
      if (typeof item.id === "string" && seenTemplateIds.has(item.id)) errors.push({ path: `${path}/id`, message: "Template id is duplicated" })
      if (typeof item.id === "string") seenTemplateIds.add(item.id)
      if (typeof item.title !== "string" || !item.title.trim()) errors.push({ path: `${path}/title`, message: "Template title is required" })
      if (typeof item.markdown !== "string") errors.push({ path: `${path}/markdown`, message: "Template markdown must be a string" })
      if (doc && typeof item.id === "string") {
        const entity = doc.entities[item.id]
        if (!entity || (entity.kind !== "document_template" && entity.kind !== "template")) {
          errors.push({ path: `${path}/id`, message: "id must identify a document template" })
        }
      }
    })
  }

  return { valid: errors.length === 0, errors }
}
