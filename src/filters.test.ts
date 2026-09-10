import { describe, expect, it } from "vitest"
import { defaultBoardFilters, matchesTaskFilters } from "./filters"
import type { Task } from "./domain/model"

const task: Task = {
  id: "task-1", kind: "task", title: "Dune", body: "", deleted: false,
  placement: { parentId: "todo", rank: "0/1" }, createdAt: "2026-09-08", updatedAt: "2026-09-08",
  values: { genre: "sci-fi", score: 9, read: true, due: "2026-09-30" },
}

describe("schema-driven board filters", () => {
  it("keeps every task with defaults", () => {
    expect(matchesTaskFilters(task, "todo", defaultBoardFilters())).toBe(true)
  })

  it("intersects column, stable select option, boolean, numeric, and date filters", () => {
    expect(matchesTaskFilters(task, "todo", {
      columnId: "todo",
      fieldValues: { genre: "sci-fi", read: "__true" },
      numberRanges: { score: { min: "8", max: "10" } },
      dateRanges: { due: { min: "2026-09-01", max: "2026-10-01" } },
    })).toBe(true)
    expect(matchesTaskFilters(task, "todo", {
      columnId: "done", fieldValues: {}, numberRanges: {}, dateRanges: {},
    })).toBe(false)
    expect(matchesTaskFilters(task, "todo", {
      columnId: "", fieldValues: { genre: "essay" }, numberRanges: {}, dateRanges: {},
    })).toBe(false)
  })
})
