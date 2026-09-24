import type { Board, CardAgingPolicy, Column, FieldDefinition, PriorityPolicy, WorkspaceDocumentV2 } from "./model"
import { getChildren, compareRanks } from "./ancestry"
import { isArchiveColumn } from "./archive"
import { cardAgingPolicySchema, priorityPolicySchema } from "./entitySchemas"
import { validatePriorityPolicy } from "./priority"
import { isItem } from "./model"

type BoardSchemaColumn = { id?: string; title: string; archive?: true }
type BoardSchemaSelectOption = { id?: string; title: string }
type BoardSchemaField = { id?: string; title: string; valueType: "text" | "number" | "boolean" | "select" | "url" | "date" | "datetime"; required: boolean; min?: number | null; max?: number | null; options?: BoardSchemaSelectOption[] }
export type BoardSchemaDraft = { boardId: string; boardTitle: string; entityName: string; columns: BoardSchemaColumn[]; fields: BoardSchemaField[]; priorityPolicy?: PriorityPolicy | null; cardAgingPolicy?: CardAgingPolicy }
export type SchemaValidationError = { path: string; message: string }
export type SchemaValidationResult = { valid: boolean; errors: SchemaValidationError[] }
export type SchemaDiff = {
  cardAgingChange?: { before: string; after: string }
  columnsRenamed: Array<{ id: string; oldTitle: string; newTitle: string }>; columnsReordered: boolean; columnsAdded: Array<{ title: string }>; columnsSoftDeleted: Array<{ id: string; title: string; retainedItemCount: number }>
  fieldsAdded: Array<{ title: string; valueType: string }>; fieldsModified: Array<{ id: string; title: string; changes: string[] }>; fieldsSoftDeleted: Array<{ id: string; title: string }>
  optionsAdded: Array<{ fieldId: string; title: string }>; optionsModified: Array<{ fieldId: string; optionId: string; oldTitle: string; newTitle: string }>; optionsSoftDeleted: Array<{ fieldId: string; optionId: string; title: string }>
}

export function projectBoardSchema(doc: WorkspaceDocumentV2, boardId: string): BoardSchemaDraft {
  const board = doc.entities[boardId] as Board | undefined
  const columns = childEntities<Column>(doc, boardId, "column").map(column => ({ id: column.id, title: column.title, ...(isArchiveColumn(column) ? { archive: true as const } : {}) }))
  const fields = childEntities<FieldDefinition>(doc, boardId, "field").map(projectField)
  return {
    boardId,
    boardTitle: board?.title || "Board",
    entityName: board?.entityName || (board?.preset?.key === "job-search" ? "lead" : "item"),
    columns,
    fields,
    priorityPolicy: board?.priorityPolicy
      ? { ...JSON.parse(JSON.stringify(board.priorityPolicy)), sort: board.priorityPolicy.sort ?? "fit_desc" }
      : null,
    cardAgingPolicy: board?.cardAgingPolicy ?? { version: 1, thresholds: { watch: 7, aged: 14, overdue: 30 } },
  }
}

function childEntities<T extends Column | FieldDefinition>(doc: WorkspaceDocumentV2, parentId: string, kind: T["kind"]): T[] {
  return getChildren(doc.entities, parentId).filter((entity): entity is T => entity.kind === kind && !entity.deleted).sort((a, b) => compareRanks(a.placement.rank, b.placement.rank))
}
function projectField(field: FieldDefinition): BoardSchemaField {
  const result: BoardSchemaField = { id: field.id, title: field.title, valueType: field.valueType, required: field.required }
  if (field.valueType === "number") Object.assign(result, { min: field.min, max: field.max })
  if (field.valueType === "select") result.options = Object.values(field.options).filter(option => !option.deleted).sort((a, b) => compareRanks(a.rank, b.rank)).map(option => ({ id: option.id, title: option.title }))
  return result
}

const valueTypes = new Set(["text", "number", "boolean", "select", "url", "date", "datetime"])
export function validateBoardSchemaDraft(draft: unknown, doc?: WorkspaceDocumentV2): SchemaValidationResult {
  if (!record(draft)) return { valid: false, errors: [{ path: "", message: "Schema draft must be a valid JSON object" }] }
  const errors: SchemaValidationError[] = []
  requiredText(draft.boardTitle, "/boardTitle", "Board title is required", errors)
  requiredText(draft.entityName, "/entityName", "Entity name is required", errors)
  validateColumns(draft.columns, errors); validateFields(draft.fields, errors); validatePolicy(draft, doc, errors); validateAgingPolicy(draft, errors)
  return { valid: errors.length === 0, errors }
}
function validateAgingPolicy(draft: Record<string, unknown>, errors: SchemaValidationError[]): void {
  if (draft.cardAgingPolicy === undefined) return
  const parsed = cardAgingPolicySchema.safeParse(draft.cardAgingPolicy)
  if (!parsed.success) {
    errors.push(...parsed.error.issues.map(issue => ({ path: `/cardAgingPolicy/${issue.path.join("/")}`.replace(/\/$/, ""), message: issue.message })))
    return
  }
}
function validateColumns(value: unknown, errors: SchemaValidationError[]): void {
  if (!Array.isArray(value)) {
    errors.push({ path: "/columns", message: "Columns must be an array" })
    return
  }
  let archive = false
  value.forEach((entry, index) => { archive = validateColumn(entry, index, archive, errors) })
}
function validateColumn(value: unknown, index: number, archive: boolean, errors: SchemaValidationError[]): boolean {
  const path = `/columns/${index}`
  if (!record(value)) { errors.push({ path, message: "Column definition must be an object" }); return archive }
  Object.keys(value).filter(key => !["id", "title", "archive"].includes(key)).forEach(key => errors.push({ path: `${path}/${key}`, message: "Unknown column setting" }))
  requiredText(value.title, `${path}/title`, "Column title is required", errors)
  if (value.archive !== undefined && value.archive !== true) errors.push({ path: `${path}/archive`, message: "archive must be true when present" })
  if (archive && value.archive === true) errors.push({ path: `${path}/archive`, message: "Only one archive column is allowed" })
  return archive || value.archive === true
}
function validateFields(value: unknown, errors: SchemaValidationError[]): void {
  if (!Array.isArray(value)) {
    errors.push({ path: "/fields", message: "Fields must be an array" })
    return
  }
  value.forEach((entry, index) => validateField(entry, index, errors))
}
function validateField(value: unknown, index: number, errors: SchemaValidationError[]): void {
  const path = `/fields/${index}`
  if (!record(value)) {
    errors.push({ path, message: "Field definition must be an object" })
    return
  }
  requiredText(value.title, `${path}/title`, "Field title is required", errors)
  if (typeof value.valueType !== "string" || !valueTypes.has(value.valueType)) errors.push({ path: `${path}/valueType`, message: "valueType must be one of: text, number, boolean, select, url, date, datetime" })
  if (typeof value.required !== "boolean") errors.push({ path: `${path}/required`, message: "required must be a boolean" })
  if (value.valueType === "select") validateOptions(value.options, path, errors)
}
function validateOptions(value: unknown, path: string, errors: SchemaValidationError[]): void {
  if (!Array.isArray(value)) {
    errors.push({ path: `${path}/options`, message: "Select field options must be an array" })
    return
  }
  value.forEach((entry, index) => {
    if (!record(entry)) {
      errors.push({ path: `${path}/options/${index}`, message: "Option must be an object" })
      return
    }
    requiredText(entry.title, `${path}/options/${index}/title`, "Option title is required", errors)
  })
}
function validatePolicy(draft: Record<string, unknown>, doc: WorkspaceDocumentV2 | undefined, errors: SchemaValidationError[]): void {
  if (draft.priorityPolicy == null) return
  const parsed = priorityPolicySchema.safeParse(draft.priorityPolicy)
  if (!parsed.success) {
    errors.push(...parsed.error.issues.map(issue => ({ path: `/priorityPolicy/${issue.path.join("/")}`.replace(/\/$/, ""), message: issue.message })))
    return
  }
  errors.push(...validatePriorityPolicy(parsed.data, doc, typeof draft.boardId === "string" ? draft.boardId : ""))
  if (!Array.isArray(draft.fields)) return
  const ids = new Set(draft.fields.map(value => record(value) && typeof value.id === "string" ? value.id : ""))
  parsed.data.rules.forEach((rule, index) => { if (!ids.has(rule.fieldId)) errors.push({ path: `/priorityPolicy/rules/${index}/fieldId`, message: "Rule field must remain on this board" }) })
  if (!ids.has(parsed.data.priorityFieldId)) errors.push({ path: "/priorityPolicy/priorityFieldId", message: "Priority output field must remain on this board" })
  if (parsed.data.fitFieldId && !ids.has(parsed.data.fitFieldId)) errors.push({ path: "/priorityPolicy/fitFieldId", message: "Fit output field must remain on this board" })
}

export function diffBoardSchema(doc: WorkspaceDocumentV2, boardId: string, draft: BoardSchemaDraft): SchemaDiff {
  const current = projectBoardSchema(doc, boardId)
  const columns = diffColumns(current.columns, draft.columns, doc)
  const fields = diffFields(current.fields, draft.fields)
  const format = (policy: CardAgingPolicy | undefined) => policy ? `${policy.thresholds.watch} / ${policy.thresholds.aged} / ${policy.thresholds.overdue}` : "default"
  const before = format(current.cardAgingPolicy); const after = format(draft.cardAgingPolicy)
  return { ...columns, ...fields, ...(before !== after ? { cardAgingChange: { before, after } } : {}) }
}
function diffColumns(current: BoardSchemaColumn[], draft: BoardSchemaColumn[], doc: WorkspaceDocumentV2): Pick<SchemaDiff, "columnsRenamed" | "columnsReordered" | "columnsAdded" | "columnsSoftDeleted"> {
  const known = byId(current); const incoming = byId(draft)
  const columnsRenamed = draft.flatMap(column => column.id && known.get(column.id)?.title !== column.title ? [{ id: column.id, oldTitle: known.get(column.id)!.title, newTitle: column.title }] : [])
  const columnsAdded = draft.filter(column => !column.id || !known.has(column.id)).map(column => ({ title: column.title }))
  const columnsSoftDeleted = current.flatMap(column => {
    if (!column.id || incoming.has(column.id)) return []
    const retainedItemCount = getChildren(doc.entities, column.id)
      .filter(entity => isItem(entity) && !entity.deleted).length
    return [{ id: column.id, title: column.title, retainedItemCount }]
  })
  return { columnsRenamed, columnsAdded, columnsSoftDeleted, columnsReordered: JSON.stringify(current.map(column => column.id).filter(Boolean)) !== JSON.stringify(draft.map(column => column.id).filter(Boolean)) }
}
function diffFields(current: BoardSchemaField[], draft: BoardSchemaField[]): Pick<SchemaDiff, "fieldsAdded" | "fieldsModified" | "fieldsSoftDeleted" | "optionsAdded" | "optionsModified" | "optionsSoftDeleted"> {
  const known = byId(current); const incoming = byId(draft); const result = emptyFieldDiff()
  draft.forEach(field => { const previous = field.id ? known.get(field.id) : undefined; if (!previous) result.fieldsAdded.push({ title: field.title, valueType: field.valueType }); else addFieldChanges(previous, field, result) })
  current.forEach(field => { if (field.id && !incoming.has(field.id)) result.fieldsSoftDeleted.push({ id: field.id, title: field.title }) })
  return result
}
function addFieldChanges(previous: BoardSchemaField, next: BoardSchemaField, result: ReturnType<typeof emptyFieldDiff>): void {
  const changes = [
    ["title", previous.title, next.title],
    ["required", previous.required, next.required],
    ["type", previous.valueType, next.valueType],
  ].flatMap(([label, before, after]) => (
    before === after ? [] : [`${label}: "${before}" → "${after}"`]
  ))
  if (changes.length && next.id) result.fieldsModified.push({ id: next.id, title: next.title, changes })
  if (previous.valueType === "select" && next.valueType === "select" && next.id) addOptionChanges(previous.options ?? [], next.options ?? [], next.id, result)
}
function addOptionChanges(previous: BoardSchemaSelectOption[], next: BoardSchemaSelectOption[], fieldId: string, result: ReturnType<typeof emptyFieldDiff>): void {
  const known = byId(previous); const incoming = byId(next)
  next.forEach(option => {
    const old = option.id ? known.get(option.id) : undefined
    if (!old) {
      result.optionsAdded.push({ fieldId, title: option.title })
    } else if (old.title !== option.title && option.id) {
      result.optionsModified.push({
        fieldId,
        optionId: option.id,
        oldTitle: old.title,
        newTitle: option.title,
      })
    }
  })
  previous.forEach(option => { if (option.id && !incoming.has(option.id)) result.optionsSoftDeleted.push({ fieldId, optionId: option.id, title: option.title }) })
}
function emptyFieldDiff(): Pick<SchemaDiff, "fieldsAdded" | "fieldsModified" | "fieldsSoftDeleted" | "optionsAdded" | "optionsModified" | "optionsSoftDeleted"> {
  return {
    fieldsAdded: [],
    fieldsModified: [],
    fieldsSoftDeleted: [],
    optionsAdded: [],
    optionsModified: [],
    optionsSoftDeleted: [],
  }
}
function byId<T extends { id?: string }>(values: T[]): Map<string, T> { return new Map(values.flatMap(value => value.id ? [[value.id, value] as [string, T]] : [])) }
function requiredText(value: unknown, path: string, message: string, errors: SchemaValidationError[]): void { if (typeof value !== "string" || !value.trim()) errors.push({ path, message }) }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value) }
