import type {
  WorkspaceDocumentV2,
  Board,
  Column,
  FieldDefinition,
  FieldOption,
  EntityId,
} from "./model"
import { getChildren, compareRanks } from "./ancestry"

export type BoardSchemaColumn = {
  id?: string
  title: string
  displayHint?: "normal" | "collapsed"
}

export type BoardSchemaSelectOption = {
  id?: string
  title: string
}

export type BoardSchemaField = {
  id?: string
  title: string
  valueType: "text" | "number" | "boolean" | "select" | "url" | "date"
  required: boolean
  min?: number | null
  max?: number | null
  options?: BoardSchemaSelectOption[]
}

export type BoardSchemaDraft = {
  boardId: string
  boardTitle: string
  entityName: string
  columns: BoardSchemaColumn[]
  fields: BoardSchemaField[]
}

export type SchemaValidationError = {
  path: string
  message: string
}

export type SchemaValidationResult = {
  valid: boolean
  errors: SchemaValidationError[]
}

export type SchemaDiff = {
  columnsRenamed: Array<{ id: string; oldTitle: string; newTitle: string }>
  columnsReordered: boolean
  columnsAdded: Array<{ title: string }>
  columnsSoftDeleted: Array<{ id: string; title: string; retainedTaskCount: number }>
  fieldsAdded: Array<{ title: string; valueType: string }>
  fieldsModified: Array<{ id: string; title: string; changes: string[] }>
  fieldsSoftDeleted: Array<{ id: string; title: string }>
  optionsAdded: Array<{ fieldId: string; title: string }>
  optionsModified: Array<{ fieldId: string; optionId: string; oldTitle: string; newTitle: string }>
  optionsSoftDeleted: Array<{ fieldId: string; optionId: string; title: string }>
}

export function projectBoardSchema(
  doc: WorkspaceDocumentV2,
  boardId: string
): BoardSchemaDraft {
  const board = doc.entities[boardId] as Board | undefined
  const boardTitle = board?.title || "Board"
  const entityName = board?.entityName || (board?.preset?.key === "job-search" ? "lead" : "item")

  // Get active columns ordered by placement rank
  const activeColumns = (getChildren(doc.entities, boardId) as Column[])
    .filter((e) => e.kind === "column" && !e.deleted)
    .sort((a, b) => compareRanks(a.placement.rank, b.placement.rank))

  const columns: BoardSchemaColumn[] = activeColumns.map((col) => ({
    id: col.id,
    title: col.title,
    displayHint: col.displayHint,
  }))

  // Get active fields for this board
  const activeFields = (getChildren(doc.entities, boardId) as FieldDefinition[])
    .filter((e) => e.kind === "field" && !e.deleted)
    .sort((a, b) => compareRanks(a.placement.rank, b.placement.rank))

  const fields: BoardSchemaField[] = activeFields.map((fld) => {
    const base: BoardSchemaField = {
      id: fld.id,
      title: fld.title,
      valueType: fld.valueType,
      required: fld.required,
    }

    if (fld.valueType === "number") {
      base.min = fld.min
      base.max = fld.max
    } else if (fld.valueType === "select") {
      const activeOptions = Object.values(fld.options || {})
        .filter((opt) => !opt.deleted)
        .sort((a, b) => compareRanks(a.rank, b.rank))
      base.options = activeOptions.map((opt) => ({
        id: opt.id,
        title: opt.title,
      }))
    }

    return base
  })

  return {
    boardId,
    boardTitle,
    entityName,
    columns,
    fields,
  }
}

const ALLOWED_VALUE_TYPES = new Set(["text", "number", "boolean", "select", "url", "date"])

export function validateBoardSchemaDraft(draft: unknown): SchemaValidationResult {
  const errors: SchemaValidationError[] = []

  if (!draft || typeof draft !== "object") {
    return { valid: false, errors: [{ path: "", message: "Schema draft must be a valid JSON object" }] }
  }

  const d = draft as Record<string, any>

  if (!d.boardTitle || typeof d.boardTitle !== "string" || !d.boardTitle.trim()) {
    errors.push({ path: "/boardTitle", message: "Board title is required" })
  }
  if (!d.entityName || typeof d.entityName !== "string" || !d.entityName.trim()) {
    errors.push({ path: "/entityName", message: "Entity name is required" })
  }

  if (!Array.isArray(d.columns)) {
    errors.push({ path: "/columns", message: "Columns must be an array" })
  } else {
    d.columns.forEach((col: any, idx: number) => {
      if (!col || typeof col !== "object") {
        errors.push({ path: `/columns/${idx}`, message: "Column definition must be an object" })
        return
      }
      if (!col.title || typeof col.title !== "string" || !col.title.trim()) {
        errors.push({ path: `/columns/${idx}/title`, message: "Column title is required" })
      }
      if (col.displayHint && col.displayHint !== "normal" && col.displayHint !== "collapsed") {
        errors.push({ path: `/columns/${idx}/displayHint`, message: "displayHint must be 'normal' or 'collapsed'" })
      }
    })
  }

  if (!Array.isArray(d.fields)) {
    errors.push({ path: "/fields", message: "Fields must be an array" })
  } else {
    d.fields.forEach((fld: any, idx: number) => {
      if (!fld || typeof fld !== "object") {
        errors.push({ path: `/fields/${idx}`, message: "Field definition must be an object" })
        return
      }
      if (!fld.title || typeof fld.title !== "string" || !fld.title.trim()) {
        errors.push({ path: `/fields/${idx}/title`, message: "Field title is required" })
      }
      if (!fld.valueType || !ALLOWED_VALUE_TYPES.has(fld.valueType)) {
        errors.push({
          path: `/fields/${idx}/valueType`,
          message: `valueType must be one of: text, number, boolean, select, url, date`,
        })
      }
      if (typeof fld.required !== "boolean") {
        errors.push({ path: `/fields/${idx}/required`, message: "required must be a boolean" })
      }
      if (fld.valueType === "select") {
        if (!Array.isArray(fld.options)) {
          errors.push({ path: `/fields/${idx}/options`, message: "Select field options must be an array" })
        } else {
          fld.options.forEach((opt: any, optIdx: number) => {
            if (!opt || typeof opt !== "object") {
              errors.push({ path: `/fields/${idx}/options/${optIdx}`, message: "Option must be an object" })
              return
            }
            if (!opt.title || typeof opt.title !== "string" || !opt.title.trim()) {
              errors.push({ path: `/fields/${idx}/options/${optIdx}/title`, message: "Option title is required" })
            }
          })
        }
      }
    })
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

export function diffBoardSchema(
  doc: WorkspaceDocumentV2,
  boardId: string,
  draft: BoardSchemaDraft
): SchemaDiff {
  const current = projectBoardSchema(doc, boardId)

  // Columns
  const currentColsById = new Map<string, BoardSchemaColumn>()
  for (const c of current.columns) {
    if (c.id) currentColsById.set(c.id, c)
  }

  const draftColsById = new Map<string, BoardSchemaColumn>()
  for (const c of draft.columns) {
    if (c.id) draftColsById.set(c.id, c)
  }

  const columnsRenamed: SchemaDiff["columnsRenamed"] = []
  const columnsAdded: SchemaDiff["columnsAdded"] = []
  const columnsSoftDeleted: SchemaDiff["columnsSoftDeleted"] = []

  for (const draftCol of draft.columns) {
    if (!draftCol.id || !currentColsById.has(draftCol.id)) {
      columnsAdded.push({ title: draftCol.title })
    } else {
      const cur = currentColsById.get(draftCol.id)!
      if (cur.title !== draftCol.title) {
        columnsRenamed.push({ id: draftCol.id, oldTitle: cur.title, newTitle: draftCol.title })
      }
    }
  }

  for (const curCol of current.columns) {
    if (curCol.id && !draftColsById.has(curCol.id)) {
      const childTasks = (getChildren(doc.entities, curCol.id) || []).filter(
        (e) => e.kind === "task" && !e.deleted
      )
      columnsSoftDeleted.push({
        id: curCol.id,
        title: curCol.title,
        retainedTaskCount: childTasks.length,
      })
    }
  }

  // Check column reordering
  const currentOrder = current.columns.map((c) => c.id).filter(Boolean)
  const draftOrder = draft.columns.map((c) => c.id).filter(Boolean)
  const columnsReordered = JSON.stringify(currentOrder) !== JSON.stringify(draftOrder)

  // Fields
  const currentFieldsById = new Map<string, BoardSchemaField>()
  for (const f of current.fields) {
    if (f.id) currentFieldsById.set(f.id, f)
  }

  const draftFieldsById = new Map<string, BoardSchemaField>()
  for (const f of draft.fields) {
    if (f.id) draftFieldsById.set(f.id, f)
  }

  const fieldsAdded: SchemaDiff["fieldsAdded"] = []
  const fieldsModified: SchemaDiff["fieldsModified"] = []
  const fieldsSoftDeleted: SchemaDiff["fieldsSoftDeleted"] = []
  const optionsAdded: SchemaDiff["optionsAdded"] = []
  const optionsModified: SchemaDiff["optionsModified"] = []
  const optionsSoftDeleted: SchemaDiff["optionsSoftDeleted"] = []

  for (const draftFld of draft.fields) {
    if (!draftFld.id || !currentFieldsById.has(draftFld.id)) {
      fieldsAdded.push({ title: draftFld.title, valueType: draftFld.valueType })
    } else {
      const cur = currentFieldsById.get(draftFld.id)!
      const changes: string[] = []
      if (cur.title !== draftFld.title) changes.push(`title: "${cur.title}" → "${draftFld.title}"`)
      if (cur.required !== draftFld.required) changes.push(`required: ${cur.required} → ${draftFld.required}`)
      if (cur.valueType !== draftFld.valueType) changes.push(`type: ${cur.valueType} → ${draftFld.valueType}`)
      if (changes.length) {
        fieldsModified.push({ id: draftFld.id, title: draftFld.title, changes })
      }

      // Check options diff if select
      if (draftFld.valueType === "select" && cur.valueType === "select") {
        const curOptsById = new Map<string, BoardSchemaSelectOption>()
        for (const o of cur.options || []) {
          if (o.id) curOptsById.set(o.id, o)
        }
        const draftOptsById = new Map<string, BoardSchemaSelectOption>()
        for (const o of draftFld.options || []) {
          if (o.id) draftOptsById.set(o.id, o)
        }

        for (const o of draftFld.options || []) {
          if (!o.id || !curOptsById.has(o.id)) {
            optionsAdded.push({ fieldId: draftFld.id, title: o.title })
          } else {
            const curOpt = curOptsById.get(o.id)!
            if (curOpt.title !== o.title) {
              optionsModified.push({
                fieldId: draftFld.id,
                optionId: o.id,
                oldTitle: curOpt.title,
                newTitle: o.title,
              })
            }
          }
        }

        for (const curOpt of cur.options || []) {
          if (curOpt.id && !draftOptsById.has(curOpt.id)) {
            optionsSoftDeleted.push({
              fieldId: draftFld.id,
              optionId: curOpt.id,
              title: curOpt.title,
            })
          }
        }
      }
    }
  }

  for (const curFld of current.fields) {
    if (curFld.id && !draftFieldsById.has(curFld.id)) {
      fieldsSoftDeleted.push({ id: curFld.id, title: curFld.title })
    }
  }

  return {
    columnsRenamed,
    columnsReordered,
    columnsAdded,
    columnsSoftDeleted,
    fieldsAdded,
    fieldsModified,
    fieldsSoftDeleted,
    optionsAdded,
    optionsModified,
    optionsSoftDeleted,
  }
}
