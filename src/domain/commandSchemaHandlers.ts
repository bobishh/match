import type { CommandHandler } from "./commandHandlerTypes"
import { err } from "./commandTypes"
import { validateBoardSchemaDraft } from "./schema"
import { validateWorkspaceSettingsDraft } from "./workspaceSettings"
import { applyBoardSchemaSettings, applyDocumentTemplates } from "./commandSupport"

export const updateBoardSchema: CommandHandler<"updateBoardSchema"> = (doc, command, context) => {
  const board = doc.entities[command.boardId]
  if (!board || board.kind !== "board") return err("not_found", `Board ${command.boardId} not found`)
  if (!headsMatch(context.beforeHeads, command.expectedHeads)) return err("conflict", "Concurrent edits arrived while schema draft was open")
  const validation = validateBoardSchemaDraft(command.schema, doc)
  if (!validation.valid) return validationError(validation.errors)
  const changedEntityIds = [command.boardId]
  return { ok: true, value: { changedEntityIds, apply: draft => applyBoardSchemaSettings(draft, command.boardId, command.schema, context.nowIso, changedEntityIds) } }
}

export const updateWorkspaceSettings: CommandHandler<"updateWorkspaceSettings"> = (doc, command, context) => {
  const validation = validateWorkspaceSettingsDraft(command.settings, doc)
  if (!validation.valid) return validationError(validation.errors)
  if (!headsMatch(context.beforeHeads, command.expectedHeads)) return err("conflict", "Concurrent edits arrived while workspace settings were open")
  const changedEntityIds: string[] = []
  return { ok: true, value: { changedEntityIds, apply: draft => {
    draft.title = command.settings.workspace.title.trim()
    applyBoardSchemaSettings(draft, command.settings.board.boardId, command.settings.board, context.nowIso, changedEntityIds)
    applyDocumentTemplates(draft, command.settings.documentTemplates, context.nowIso, changedEntityIds)
  } } }
}

function headsMatch(actual: string[], expected?: string[]): boolean {
  if (!expected?.length) return true
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((head, index) => head === sorted[index])
}

function validationError(errors: Array<{ message: string; path: string }>) {
  const error = errors[0]
  return {
    ok: false as const,
    error: { code: "invalid_input" as const, message: error.message, field: error.path },
  }
}
