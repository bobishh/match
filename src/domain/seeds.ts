import type { Board, Column, FieldDefinition, WorkspaceDocumentV2, WorkspaceEntity } from "./model"

type Preset = "job-search" | "blank"
type SeedContext = { boardId: string; nowIso: string; entities: Record<string, WorkspaceEntity>; bindings: Record<string, string> }
type ColumnSeed = { key: string; title: string; archive?: true }
type FieldSeed = { key: string; title: string; valueType: FieldDefinition["valueType"]; required?: boolean; min?: number; max?: number; options?: Array<[string, string]> }

export function createWorkspaceDoc(id: string, title: string, ownerPersonId: string, presetKey: Preset, nowIso = new Date().toISOString()): WorkspaceDocumentV2 {
  const boardId = crypto.randomUUID()
  const context: SeedContext = { boardId, nowIso, entities: {}, bindings: {} }
  seedColumns(context, presetKey === "blank" ? blankColumns : jobColumns)
  if (presetKey === "job-search") seedFields(context, jobFields)
  context.entities[boardId] = createBoard(boardId, title, presetKey, nowIso, context.bindings)
  return { kind: "workspace", formatVersion: 2, id, title, deleted: false, ownerPersonId, entities: context.entities, migration: null }
}

export function seedBoard(entities: Record<string, WorkspaceEntity>, title: string, presetKey: Preset, nowIso = new Date().toISOString()): Board {
  const boardId = crypto.randomUUID()
  const context: SeedContext = { boardId, nowIso, entities, bindings: {} }
  seedColumns(context, presetKey === "blank" ? blankColumns : jobColumns)
  if (presetKey === "job-search") seedFields(context, jobFields)
  const board = createBoard(boardId, title, presetKey, nowIso, context.bindings)
  entities[boardId] = board
  return board
}

function createBoard(id: string, title: string, preset: Preset, nowIso: string, bindings: Record<string, string>): Board {
  return { id, kind: "board", title, entityName: preset === "job-search" ? "lead" : "item", placement: { parentId: null, rank: "0/1" }, deleted: false, createdAt: nowIso, updatedAt: nowIso, preset: { key: preset, version: 1, bindings } }
}

function seedColumns(context: SeedContext, columns: ColumnSeed[]): void {
  columns.forEach((seed, index) => {
    const id = crypto.randomUUID()
    context.bindings[seed.key] = id
    const column: Column = { id, kind: "column", title: seed.title, placement: { parentId: context.boardId, rank: `${index}/1` }, displayHint: seed.archive ? "collapsed" : "normal", deleted: false, createdAt: context.nowIso, updatedAt: context.nowIso }
    if (seed.archive) column.archive = true
    context.entities[id] = column
  })
}

function seedFields(context: SeedContext, fields: FieldSeed[]): void {
  fields.forEach((seed, index) => {
    const id = crypto.randomUUID()
    context.bindings[seed.key] = id
    const base = { id, kind: "field" as const, title: seed.title, placement: { parentId: context.boardId, rank: `${index}/1` }, deleted: false, createdAt: context.nowIso, updatedAt: context.nowIso, required: seed.required ?? false }
    const field = seed.valueType === "number" ? { ...base, valueType: "number" as const, min: seed.min ?? null, max: seed.max ?? null }
      : seed.valueType === "select" ? { ...base, valueType: "select" as const, options: seedOptions(context, seed.options ?? []) }
        : { ...base, valueType: seed.valueType }
    context.entities[id] = field as FieldDefinition
  })
}

function seedOptions(context: SeedContext, options: Array<[string, string]>): Record<string, { id: string; title: string; rank: string; deleted: boolean }> {
  return Object.fromEntries(options.map(([key, title], index) => {
    const id = crypto.randomUUID()
    context.bindings[key] = id
    return [id, { id, title, rank: `${index}/1`, deleted: false }]
  }))
}

const blankColumns: ColumnSeed[] = [["column.todo", "To do"], ["column.doing", "Doing"], ["column.done", "Done"]].map(([key, title]) => ({ key, title }))
const jobColumns: ColumnSeed[] = [["status.lead", "Lead"], ["status.applied", "Applied"], ["status.interview", "Interview"], ["status.rejected", "Rejected"], ["status.offer", "Offer"], ["status.archived", "Archive"]].map(([key, title], index) => ({ key, title, ...(index === 5 ? { archive: true as const } : {}) }))
const jobFields: FieldSeed[] = [
  { key: "field.company", title: "Company", valueType: "text", required: true }, { key: "field.role", title: "Role", valueType: "text", required: true }, { key: "field.url", title: "URL", valueType: "url" }, { key: "field.location", title: "Location", valueType: "text" },
  { key: "field.workMode", title: "Work mode", valueType: "select", options: [["option.workMode.remote", "Remote"], ["option.workMode.hybrid", "Hybrid"], ["option.workMode.onsite", "Onsite"], ["option.workMode.unknown", "Unknown"]] },
  { key: "field.priority", title: "Priority", valueType: "select", options: [["option.priority.p0", "P0"], ["option.priority.p1", "P1"], ["option.priority.p2", "P2"], ["option.priority.p3", "P3"]] },
  { key: "field.fitScore", title: "Fit score", valueType: "number", min: 0, max: 10 }, { key: "field.notes", title: "Notes", valueType: "text" }, { key: "field.sourceText", title: "Source text", valueType: "text" }, { key: "field.rejectionReason", title: "Rejection notes / retrospective", valueType: "text" },
]
