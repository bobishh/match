import { describe, expect, it } from "vitest"
import { hasEntityKind } from "./model"
import { archivedItemsForBoard } from "./archive"
import { createWorkspaceDoc } from "./seeds"

describe("board archive projection", () => {
  it("includes archived subitems from the same board", () => {
    const doc = createWorkspaceDoc("workspace", "Board", "owner", "blank")
    const board = Object.values(doc.entities).find(entity => hasEntityKind(entity, "board"))!
    const column = Object.values(doc.entities).find(entity => hasEntityKind(entity, "column"))!
    const now = "2026-09-29T00:00:00.000Z"
    doc.entities.parent = { id: "parent", title: "Parent", body: "", values: {}, placement: { parentId: column.id, rank: "0/1" }, archivedAt: now, createdAt: now, updatedAt: now }
    doc.entities.child = { id: "child", title: "Child", body: "", values: {}, placement: { parentId: "parent", rank: "0/1" }, archivedAt: now, createdAt: now, updatedAt: now }

    expect(archivedItemsForBoard(doc, board.id).map(item => item.id)).toEqual(["parent", "child"])
  })
})
