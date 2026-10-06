import type { CommandResult, WorkspaceDocumentV2 } from "./model"
import { validateWorkspaceDoc } from "./validation"

type JsonRecord = Record<string, unknown>
type MigrationPlan = { apply: (draft: WorkspaceDocumentV2) => void; changedEntityIds: string[] }

export function needsWorkspaceStateMigration(input: unknown): boolean {
  if (!input || typeof input !== "object") return false
  const source = input as JsonRecord
  if (source.kind !== "workspace" || source.formatVersion !== 3 || !source.entities || typeof source.entities !== "object") return false
  const entities = Object.values(source.entities as Record<string, JsonRecord>)
  return entities.some(entity => entity?.kind === "board" && entity.archiveColumnId === undefined)
    || entities.some(entity => entity?.kind === "column" && entity.archive === true)
    || entities.some(entity => (entity?.kind === "item" || typeof entity?.body === "string") && (!entity.lifecycle || !entity.workflow || entity.archivedAt !== undefined || typeof entity.lifecycle !== "string" || typeof entity.workflow !== "string"))
}

function record(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`)
  return value as JsonRecord
}

function archiveValue(source: JsonRecord, path: string, migratedAt: string): void {
  if (!Object.hasOwn(source, "deleted")) {
    if (!Object.hasOwn(source, "archivedAt") && !source.lifecycle) throw new Error(`${path} has no archive state`)
    return
  }
  if (typeof source.deleted !== "boolean") throw new Error(`${path}.deleted must be boolean`)
  const previous = source.archivedAt
  if (previous !== undefined && previous !== null && typeof previous !== "string")
    throw new Error(`${path}.archivedAt must be a string or null`)
  if (previous === undefined) {
    const timestamp = typeof source.updatedAt === "string" ? source.updatedAt : migratedAt
    if (source.deleted && !Number.isFinite(Date.parse(timestamp))) throw new Error(`${path} has invalid archive time`)
    source.archivedAt = source.deleted ? timestamp : null
  }
  delete source.deleted
}

function applyArchive(target: JsonRecord, before: JsonRecord, after: JsonRecord): void {
  if (Object.hasOwn(before, "deleted")) delete target.deleted
  if (before.archivedAt !== after.archivedAt) {
    if (after.archivedAt === undefined) delete target.archivedAt
    else target.archivedAt = after.archivedAt
  }
}

/** Upgrades legacy format 2 or state-less format 3 documents with one field-level Automerge change. */
export function planWorkspaceMigration(input: unknown, migratedAt: string): CommandResult<MigrationPlan> {
  try {
    const prepared = prepareMigration(input, migratedAt)
    const validation = validateWorkspaceDoc(prepared.after)
    if (!validation.ok) throw new Error(validation.error.message)
    return { ok: true, value: { changedEntityIds: prepared.changedEntityIds, apply: draft => applyMigration(draft, prepared) } }
  } catch (error) {
    return { ok: false, error: { code: "invalid_input", message: error instanceof Error ? error.message : String(error) } }
  }
}

type PreparedMigration = { before: JsonRecord; after: JsonRecord; changedEntityIds: string[] }

function prepareMigration(input: unknown, migratedAt: string): PreparedMigration {
  const before = record(input, "workspace")
  if (before.kind !== "workspace" || ![2, 3].includes(Number(before.formatVersion))) throw new Error("Expected workspace format 2 or 3")
  const after = record(JSON.parse(JSON.stringify(input)), "workspace")
  if (before.formatVersion === 2) after.formatVersion = 3
  archiveValue(after, "workspace", migratedAt)
  const entities = record(after.entities, "workspace.entities")
  const originalEntities = record(before.entities, "workspace.entities")
  const changedEntityIds: string[] = []
  const legacyArchiveByBoard = new Map<string, string>()
  for (const [id, raw] of Object.entries(entities)) {
    const entity = record(raw, `entities.${id}`)
    const original = record(originalEntities[id], `entities.${id}`)
    migrateEntity(entity, id, migratedAt, entities, legacyArchiveByBoard)
    if (JSON.stringify(original) !== JSON.stringify(entity)) changedEntityIds.push(id)
  }
  migrateBoardArchiveReferences(entities, originalEntities, legacyArchiveByBoard, changedEntityIds)
  return { before, after, changedEntityIds }
}

function migrateEntity(entity: JsonRecord, id: string, migratedAt: string, entities: Record<string, unknown>, legacyArchiveByBoard: Map<string, string>): void {
  archiveValue(entity, `entities.${id}`, migratedAt)
  if (entity.kind === "column") migrateColumn(entity, id, legacyArchiveByBoard)
  if (isItemEntity(entity)) migrateItem(entity, id, migratedAt, entities)
  if (entity.kind === "field" && entity.valueType === "select") migrateOptions(entity, id, migratedAt)
}

function migrateColumn(entity: JsonRecord, id: string, legacyArchiveByBoard: Map<string, string>): void {
  if (entity.archive === true && !entity.archivedAt) {
    const boardId = record(entity.placement, `entities.${id}.placement`).parentId
    if (typeof boardId !== "string") throw new Error(`entities.${id} archive column has no board`)
    const existing = legacyArchiveByBoard.get(boardId)
    if (existing && existing !== id) throw new Error(`Board ${boardId} has multiple archive columns`)
    legacyArchiveByBoard.set(boardId, id)
  }
  delete entity.archive
  if (!Object.hasOwn(entity, "displayHint")) return
  if (entity.displayHint !== "normal" && entity.displayHint !== "collapsed") throw new Error(`entities.${id}.displayHint is invalid`)
  delete entity.displayHint
}

function isItemEntity(entity: JsonRecord): boolean {
  return entity.kind === "item" || typeof entity.body === "string" && Boolean(entity.values) && typeof entity.values === "object"
}

function migrateItem(entity: JsonRecord, id: string, migratedAt: string, entities: Record<string, unknown>): void {
  const placement = record(entity.placement, `entities.${id}.placement`)
  const lifecycle = typeof entity.lifecycle === "string" ? parseTransition(entity.lifecycle) : entity.lifecycle
  entity.lifecycle = JSON.stringify(lifecycle || { state: entity.archivedAt ? "archived" : "active", changedAt: entity.archivedAt ?? entity.updatedAt ?? migratedAt })
  const workflow = typeof entity.workflow === "string" ? parseTransition(entity.workflow) : entity.workflow
  const columnId = workflow ? undefined : containingColumnId(entities, placement.parentId)
  if (workflow) entity.workflow = JSON.stringify(workflow)
  else if (columnId) entity.workflow = JSON.stringify({ columnId, changedAt: entity.updatedAt ?? migratedAt })
  delete entity.archivedAt
}

function migrateOptions(entity: JsonRecord, id: string, migratedAt: string): void {
  const options = record(entity.options, `entities.${id}.options`)
  for (const [optionId, rawOption] of Object.entries(options))
    archiveValue(record(rawOption, `entities.${id}.options.${optionId}`), `entities.${id}.options.${optionId}`, migratedAt)
}

function migrateBoardArchiveReferences(entities: Record<string, unknown>, originals: JsonRecord, archiveByBoard: Map<string, string>, changed: string[]): void {
  for (const [id, raw] of Object.entries(entities)) {
    const entity = record(raw, `entities.${id}`)
    if (entity.kind !== "board") continue
    if (entity.archiveColumnId === undefined) entity.archiveColumnId = archiveByBoard.get(id) ?? null
    const original = record(originals[id], `entities.${id}`)
    if (JSON.stringify(original) !== JSON.stringify(entity) && !changed.includes(id)) changed.push(id)
  }
}

function applyMigration(draft: WorkspaceDocumentV2, prepared: PreparedMigration): void {
  const { before, after, changedEntityIds } = prepared
  const target = draft as unknown as JsonRecord
  target.formatVersion = 3
  applyArchive(target, before, after)
  const targetEntities = record(target.entities, "workspace.entities")
  const beforeEntities = record(before.entities, "workspace.entities")
  const afterEntities = record(after.entities, "workspace.entities")
  for (const id of changedEntityIds) {
    const prior = record(beforeEntities[id], `entities.${id}`)
    const updated = record(afterEntities[id], `entities.${id}`)
    const current = record(targetEntities[id], `entities.${id}`)
    applyArchive(current, prior, updated)
    applyTransitionFields(current, prior, updated)
    if (prior.kind === "column") clearLegacyColumnFlags(current, prior)
    if (prior.kind === "field" && prior.valueType === "select") applyOptionArchives(current, prior, updated, id)
  }
}

function applyTransitionFields(current: JsonRecord, prior: JsonRecord, updated: JsonRecord): void {
  for (const key of ["lifecycle", "workflow", "archiveColumnId", "collapsible"]) {
    if (JSON.stringify(prior[key]) === JSON.stringify(updated[key])) continue
    if (updated[key] === undefined) delete current[key]
    else current[key] = JSON.parse(JSON.stringify(updated[key])) as unknown
  }
}

function clearLegacyColumnFlags(current: JsonRecord, prior: JsonRecord): void {
  if (Object.hasOwn(prior, "archive")) delete current.archive
  if (Object.hasOwn(prior, "displayHint")) delete current.displayHint
}

function applyOptionArchives(current: JsonRecord, prior: JsonRecord, updated: JsonRecord, id: string): void {
  const priorOptions = record(prior.options, `entities.${id}.options`)
  const updatedOptions = record(updated.options, `entities.${id}.options`)
  const currentOptions = record(current.options, `entities.${id}.options`)
  for (const optionId of Object.keys(priorOptions))
    applyArchive(record(currentOptions[optionId], `entities.${id}.options.${optionId}`),
      record(priorOptions[optionId], `entities.${id}.options.${optionId}`),
      record(updatedOptions[optionId], `entities.${id}.options.${optionId}`))
}

function parseTransition(value: string): JsonRecord | undefined {
  try { return record(JSON.parse(value), "transition") } catch { return undefined }
}

function containingColumnId(entities: Record<string, unknown>, parentId: unknown): string | undefined {
  const visited = new Set<string>()
  let currentId = typeof parentId === "string" ? parentId : null
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    const entity = entities[currentId] as JsonRecord | undefined
    if (!entity) return undefined
    if (entity.kind === "column") return currentId
    const placement = entity.placement as JsonRecord | undefined
    currentId = typeof placement?.parentId === "string" ? placement.parentId : null
  }
  return undefined
}
