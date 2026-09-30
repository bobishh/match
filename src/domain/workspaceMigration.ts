import type { CommandResult, WorkspaceDocumentV2 } from "./model"
import { validateWorkspaceDoc } from "./validation"

type JsonRecord = Record<string, unknown>
type MigrationPlan = { apply: (draft: WorkspaceDocumentV2) => void; changedEntityIds: string[] }

function record(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`)
  return value as JsonRecord
}

function archiveValue(source: JsonRecord, path: string, migratedAt: string): void {
  if (!Object.hasOwn(source, "deleted")) {
    if (!Object.hasOwn(source, "archivedAt")) throw new Error(`${path} has no archive state`)
    return
  }
  if (typeof source.deleted !== "boolean") throw new Error(`${path}.deleted must be boolean`)
  const previous = source.archivedAt
  const timestamp = typeof source.updatedAt === "string" ? source.updatedAt : migratedAt
  if (source.deleted && !Number.isFinite(Date.parse(timestamp))) throw new Error(`${path} has invalid archive time`)
  const next = source.deleted ? timestamp : null
  if (previous !== undefined && previous !== next) throw new Error(`${path} has conflicting archive state`)
  source.archivedAt = next
  delete source.deleted
}

function applyArchive(target: JsonRecord, before: JsonRecord, after: JsonRecord): void {
  if (Object.hasOwn(before, "deleted")) delete target.deleted
  if (before.archivedAt !== after.archivedAt) target.archivedAt = after.archivedAt
}

/** Upgrades a signed format 2 document by appending a field-level Automerge change. */
export function planWorkspaceMigration(input: unknown, migratedAt: string): CommandResult<MigrationPlan> {
  try {
    const before = record(input, "workspace")
    if (before.kind !== "workspace" || before.formatVersion !== 2)
      throw new Error("Expected workspace format 2")
    const after = record(JSON.parse(JSON.stringify(input)), "workspace")
    after.formatVersion = 3
    archiveValue(after, "workspace", migratedAt)
    const entities = record(after.entities, "workspace.entities")
    const changedEntityIds: string[] = []
    for (const [id, rawEntity] of Object.entries(entities)) {
      const entity = record(rawEntity, `entities.${id}`)
      const beforeEntity = record(record(before.entities, "workspace.entities")[id], `entities.${id}`)
      archiveValue(entity, `entities.${id}`, migratedAt)
      if (entity.kind === "column" && Object.hasOwn(entity, "displayHint")) {
        if (entity.displayHint !== "normal" && entity.displayHint !== "collapsed")
          throw new Error(`entities.${id}.displayHint is invalid`)
        delete entity.displayHint
      }
      if (entity.kind === "field" && entity.valueType === "select") {
        for (const [optionId, rawOption] of Object.entries(record(entity.options, `entities.${id}.options`)))
          archiveValue(record(rawOption, `entities.${id}.options.${optionId}`), `entities.${id}.options.${optionId}`, migratedAt)
      }
      if (JSON.stringify(beforeEntity) !== JSON.stringify(entity)) changedEntityIds.push(id)
    }
    const validation = validateWorkspaceDoc(after)
    if (!validation.ok) throw new Error(validation.error.message)
    return { ok: true, value: {
      changedEntityIds,
      apply: draft => {
        const target = draft as unknown as JsonRecord
        target.formatVersion = 3
        applyArchive(target, before, after)
        const targetEntities = record(target.entities, "workspace.entities")
        const beforeEntities = record(before.entities, "workspace.entities")
        for (const id of changedEntityIds) {
          const prior = record(beforeEntities[id], `entities.${id}`)
          const updated = record(entities[id], `entities.${id}`)
          const current = record(targetEntities[id], `entities.${id}`)
          applyArchive(current, prior, updated)
          if (prior.kind === "column" && Object.hasOwn(prior, "displayHint")) delete current.displayHint
          if (prior.kind === "field" && prior.valueType === "select") {
            const priorOptions = record(prior.options, `entities.${id}.options`)
            const updatedOptions = record(updated.options, `entities.${id}.options`)
            const currentOptions = record(current.options, `entities.${id}.options`)
            for (const optionId of Object.keys(priorOptions))
              applyArchive(record(currentOptions[optionId], `entities.${id}.options.${optionId}`),
                record(priorOptions[optionId], `entities.${id}.options.${optionId}`),
                record(updatedOptions[optionId], `entities.${id}.options.${optionId}`))
          }
        }
      },
    } }
  } catch (error) {
    return { ok: false, error: { code: "invalid_input", message: error instanceof Error ? error.message : String(error) } }
  }
}
