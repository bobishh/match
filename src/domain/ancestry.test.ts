import { describe, expect, it } from "vitest"
import {
  compareRanks,
  calculateRankBetween,
  sortEntitiesByRank,
  derivePlacementIssues,
  isEntityVisible,
  getVisibleChildren,
  renumberSiblings,
} from "./ancestry"
import type { Item, Column, Board, WorkspaceEntity } from "./model"

describe("Ancestry, rational ranks, and placement projection (Requirement 1.4)", () => {
  it("compares rational ranks exactly using BigInt arithmetic, not lexicographical string ordering", () => {
    expect(compareRanks("1/10", "1/2")).toBeLessThan(0)
    expect(compareRanks("1/2", "1/10")).toBeGreaterThan(0)
    expect(compareRanks("2/4", "1/2")).toBe(0) // same value
    expect(compareRanks("-1/2", "0/1")).toBeLessThan(0)
    expect(compareRanks("3/2", "4/3")).toBeGreaterThan(0) // 1.5 > 1.333...
  })

  it("calculates correct mediant ranks between distinct ranks, and handles bounds", () => {
    // Before first
    expect(calculateRankBetween(null, "0/1")).toBe("-1/1")
    expect(calculateRankBetween(null, "1/1")).toBe("0/1")

    // After last
    expect(calculateRankBetween("0/1", null)).toBe("1/1")
    expect(calculateRankBetween("2/1", null)).toBe("3/1")

    // Between distinct ranks: mediant of 0/1 and 1/1 is 1/2
    expect(calculateRankBetween("0/1", "1/1")).toBe("1/2")
    // Mediant of 1/2 and 1/1 is 2/3
    expect(calculateRankBetween("1/2", "1/1")).toBe("2/3")
  })

  it("breaks equal-rank ties deterministically by entity ID", () => {
    const itemA: Item = {
      id: "item_a",
      title: "Item A",
      placement: { parentId: "col_1", rank: "1/1" },
      deleted: false,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }
    const itemB: Item = {
      id: "item_b",
      title: "Item B",
      placement: { parentId: "col_1", rank: "1/1" }, // same rank
      deleted: false,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }

    const sorted1 = sortEntitiesByRank([itemB, itemA])
    expect(sorted1.map((t) => t.id)).toEqual(["item_a", "item_b"])

    // Renumbering equal ranks separates them into consecutive integers
    const renumbered = renumberSiblings([itemB, itemA])
    expect(renumbered[0].placement.rank).toBe("0/1")
    expect(renumbered[1].placement.rank).toBe("1/1")
  })

  it("detects cycles, missing parents, and invalid parent kinds deterministically without hanging", () => {
    const board: Board = {
      id: "board_1",
      kind: "board",
      title: "Board",
      placement: { parentId: null, rank: "0/1" },
      deleted: false,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      preset: null,
    }

    const col: Column = {
      id: "col_1",
      kind: "column",
      title: "Col",
      placement: { parentId: "board_1", rank: "0/1" },
      deleted: false,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      displayHint: "normal",
    }

    // Item cycle: A -> B -> A
    const itemA: Item = {
      id: "item_a",
      title: "A",
      placement: { parentId: "item_b", rank: "0/1" },
      deleted: false,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }
    const itemB: Item = {
      id: "item_b",
      title: "B",
      placement: { parentId: "item_a", rank: "0/1" },
      deleted: false,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }

    // Item with missing parent
    const itemMissing: Item = {
      id: "item_orphan",
      title: "Orphan",
      placement: { parentId: "non_existent_id", rank: "0/1" },
      deleted: false,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }

    // Item with invalid parent kind (item parent is board)
    const itemBadParent: Item = {
      id: "item_bad_parent",
      title: "Bad Parent",
      placement: { parentId: "board_1", rank: "0/1" },
      deleted: false,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }

    const entities: Record<string, WorkspaceEntity> = {
      [board.id]: board,
      [col.id]: col,
      [itemA.id]: itemA,
      [itemB.id]: itemB,
      [itemMissing.id]: itemMissing,
      [itemBadParent.id]: itemBadParent,
    }

    const issues = derivePlacementIssues(entities)
    expect(issues).toHaveLength(4)

    const cycleIssueA = issues.find((i) => i.entityId === "item_a")
    expect(cycleIssueA?.type).toBe("cycle")

    const orphanIssue = issues.find((i) => i.entityId === "item_orphan")
    expect(orphanIssue?.type).toBe("missing-parent")

    const badParentIssue = issues.find((i) => i.entityId === "item_bad_parent")
    expect(badParentIssue?.type).toBe("invalid-parent-kind")
  })

  it("enforces inherited visibility: child is hidden if parent is deleted, and separately deleted child stays deleted on parent restore", () => {
    const board: Board = {
      id: "board_1",
      kind: "board",
      title: "Board",
      placement: { parentId: null, rank: "0/1" },
      deleted: false,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      preset: null,
    }

    const col: Column = {
      id: "col_1",
      kind: "column",
      title: "Col",
      placement: { parentId: "board_1", rank: "0/1" },
      deleted: true, // Column is deleted
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      displayHint: "normal",
    }

    const liveChild: Item = {
      id: "child_live",
      title: "Live Child",
      placement: { parentId: "col_1", rank: "0/1" },
      deleted: false, // Child is NOT deleted, but parent column is deleted
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }

    const deletedChild: Item = {
      id: "child_deleted",
      title: "Deleted Child",
      placement: { parentId: "col_1", rank: "1/1" },
      deleted: true, // Child is separately deleted
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }

    const entities: Record<string, WorkspaceEntity> = {
      [board.id]: board,
      [col.id]: col,
      [liveChild.id]: liveChild,
      [deletedChild.id]: deletedChild,
    }

    // Because column is deleted, neither child is visible on board
    expect(isEntityVisible(entities, "child_live")).toBe(false)
    expect(isEntityVisible(entities, "child_deleted")).toBe(false)
    expect(getVisibleChildren(entities, "col_1")).toHaveLength(0)

    // When column is restored (col.deleted = false)
    entities["col_1"] = { ...col, deleted: false }
    expect(isEntityVisible(entities, "child_live")).toBe(true)
    // Separately deleted child must STILL be not visible
    expect(isEntityVisible(entities, "child_deleted")).toBe(false)

    const visibleChildren = getVisibleChildren(entities, "col_1")
    expect(visibleChildren.map((c) => c.id)).toEqual(["child_live"])
  })
})
