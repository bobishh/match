import { describe, expect, it } from "vitest"
import { createWorkspaceDoc } from "./seeds"
import { assertWorkspaceTransition, canWorkspace, type WorkspaceCapability, type WorkspaceRole } from "./permissions"

const capabilities: WorkspaceCapability[] = [
  "workspace.rename",
  "content.write",
  "chat.write",
  "chat.profile",
  "board.configure",
  "workspace.import",
  "access.manage",
  "history.repair",
]

describe("workspace policy", () => {
  it.each([
    ["owner", capabilities],
    ["editor", ["workspace.rename", "content.write", "chat.write", "chat.profile"]],
    ["visitor", ["chat.profile"]],
  ] as const)("gives %s the declared capabilities", (role, allowed) => {
    for (const capability of capabilities) {
      expect(canWorkspace(role as WorkspaceRole, capability)).toBe(allowed.includes(capability as never))
    }
  })

  it("uses the same policy for document transitions", () => {
    const before = createWorkspaceDoc("ws", "Before", "owner", "blank")
    const board = Object.values(before.entities).find(entity => entity.kind === "board")!
    const column = Object.values(before.entities).find(entity => entity.kind === "column")!
    before.entities.item = {
      id: "item", title: "Item", body: "", placement: { parentId: column.id, rank: "0/1" },
      deleted: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", values: {},
    }

    const renamed = structuredClone(before)
    renamed.title = "After"
    expect(() => assertWorkspaceTransition("editor", before, renamed)).not.toThrow()

    const content = structuredClone(before)
    content.entities.item!.title = "Edited"
    expect(() => assertWorkspaceTransition("editor", before, content)).not.toThrow()

    const structure = structuredClone(before)
    structure.entities[board.id]!.title = "Changed board"
    expect(() => assertWorkspaceTransition("editor", before, structure)).toThrow("Only the owner can edit board structure")
    expect(() => assertWorkspaceTransition("visitor", before, renamed)).toThrow("Visitors can only view this workspace")
  })
})
