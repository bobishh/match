import type { EntityId, Task } from "./domain/model"

export type FilterRange = { min: string; max: string }

export type BoardFilters = {
  columnId: EntityId | ""
  fieldValues: Record<EntityId, string>
  numberRanges: Record<EntityId, FilterRange>
  dateRanges: Record<EntityId, FilterRange>
}

export function defaultBoardFilters(): BoardFilters {
  return { columnId: "", fieldValues: {}, numberRanges: {}, dateRanges: {} }
}

export function activeFilterCount(filters: BoardFilters): number {
  return Number(Boolean(filters.columnId))
    + Object.values(filters.fieldValues).filter(Boolean).length
    + Object.values(filters.numberRanges).filter(range => range.min || range.max).length
    + Object.values(filters.dateRanges).filter(range => range.min || range.max).length
}

function matchesRange(value: unknown, range: FilterRange, kind: "number" | "date") {
  if (!range.min && !range.max) return true
  if (kind === "number") {
    if (typeof value !== "number") return false
    return (!range.min || value >= Number(range.min)) && (!range.max || value <= Number(range.max))
  }
  if (typeof value !== "string") return false
  return (!range.min || value >= range.min) && (!range.max || value <= range.max)
}

export function matchesTaskFilters(task: Task, columnId: EntityId, filters: BoardFilters) {
  if (filters.columnId && filters.columnId !== columnId) return false

  for (const [fieldId, expected] of Object.entries(filters.fieldValues)) {
    if (!expected) continue
    const actual = task.values[fieldId]
    if (expected === "__true" ? actual !== true : expected === "__false" ? actual !== false : actual !== expected) return false
  }
  for (const [fieldId, range] of Object.entries(filters.numberRanges)) {
    if (!matchesRange(task.values[fieldId], range, "number")) return false
  }
  for (const [fieldId, range] of Object.entries(filters.dateRanges)) {
    if (!matchesRange(task.values[fieldId], range, "date")) return false
  }
  return true
}
