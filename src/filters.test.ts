import { describe, expect, it } from "vitest"
import { defaultBoardFilters, matchesItemFilters } from "./filters"
import type { Item } from "./domain/model"

const item: Item = {
  id: "item-1", title: "Dune", body: "", deleted: false,
  placement: { parentId: "todo", rank: "0/1" }, createdAt: "2026-09-08", updatedAt: "2026-09-08",
  values: { genre: "sci-fi", score: 9, read: true, due: "2026-09-30" },
}

describe("schema-driven board filters", () => {
  it("keeps every item with defaults", () => {
    expect(matchesItemFilters(item, "todo", defaultBoardFilters())).toBe(true)
  })

  it("intersects column, stable select option, boolean, numeric, and date filters", () => {
    expect(matchesItemFilters(item, "todo", {
      columnId: "todo",
      fieldValues: { genre: "sci-fi", read: "__true" },
      numberRanges: { score: { min: "8", max: "10" } },
      dateRanges: { due: { min: "2026-09-01", max: "2026-10-01" } },
    })).toBe(true)
    expect(matchesItemFilters(item, "todo", {
      columnId: "done", fieldValues: {}, numberRanges: {}, dateRanges: {},
    })).toBe(false)
    expect(matchesItemFilters(item, "todo", {
      columnId: "", fieldValues: { genre: "essay" }, numberRanges: {}, dateRanges: {},
    })).toBe(false)
  })
})
