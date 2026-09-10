import { describe, expect, it } from "vitest"
import {
  compareRanks,
  calculateRankBetween,
  sortEntitiesByRank,
  getAncestryPath,
  derivePlacementIssues,
  isEntityVisible,
  getVisibleChildren,
  renumberSiblings,
} from "./ancestry"
import type { Task, Column, Board, WorkspaceEntity } from "./model"

describe("Ancestry, rational ranks, and placement projection (Task 1.4)", () => {
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
    const taskA: Task = {
      id: "task_a",
      kind: "task",
      title: "Task A",
      placement: { parentId: "col_1", rank: "1/1" },
      deleted: false,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }
    const taskB: Task = {
      id: "task_b",
      kind: "task",
      title: "Task B",
      placement: { parentId: "col_1", rank: "1/1" }, // same rank
      deleted: false,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }

    const sorted1 = sortEntitiesByRank([taskB, taskA])
    expect(sorted1.map((t) => t.id)).toEqual(["task_a", "task_b"])

    // Renumbering equal ranks separates them into consecutive integers
    const renumbered = renumberSiblings([taskB, taskA])
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

    // Task cycle: A -> B -> A
    const taskA: Task = {
      id: "task_a",
      kind: "task",
      title: "A",
      placement: { parentId: "task_b", rank: "0/1" },
      deleted: false,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }
    const taskB: Task = {
      id: "task_b",
      kind: "task",
      title: "B",
      placement: { parentId: "task_a", rank: "0/1" },
      deleted: false,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }

    // Task with missing parent
    const taskMissing: Task = {
      id: "task_orphan",
      kind: "task",
      title: "Orphan",
      placement: { parentId: "non_existent_id", rank: "0/1" },
      deleted: false,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }

    // Task with invalid parent kind (task parent is board)
    const taskBadParent: Task = {
      id: "task_bad_parent",
      kind: "task",
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
      [taskA.id]: taskA,
      [taskB.id]: taskB,
      [taskMissing.id]: taskMissing,
      [taskBadParent.id]: taskBadParent,
    }

    const issues = derivePlacementIssues(entities)
    expect(issues).toHaveLength(4)

    const cycleIssueA = issues.find((i) => i.entityId === "task_a")
    expect(cycleIssueA?.type).toBe("cycle")

    const orphanIssue = issues.find((i) => i.entityId === "task_orphan")
    expect(orphanIssue?.type).toBe("missing-parent")

    const badParentIssue = issues.find((i) => i.entityId === "task_bad_parent")
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

    const liveChild: Task = {
      id: "child_live",
      kind: "task",
      title: "Live Child",
      placement: { parentId: "col_1", rank: "0/1" },
      deleted: false, // Child is NOT deleted, but parent column is deleted
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }

    const deletedChild: Task = {
      id: "child_deleted",
      kind: "task",
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
