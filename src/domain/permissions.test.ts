import { describe, expect, it } from "vitest"
import { hasEntityKind } from "./model"
import { createWorkspaceDoc } from "./seeds"
import { assertWorkspaceCommand, assertWorkspaceTransition, canWorkspace, type WorkspaceCapability, type WorkspaceRole } from "./permissions"
import type { Command } from "./commandTypes"

const capabilities: WorkspaceCapability[] = [
  "workspace.rename",
  "content.write",
  "chat.write",
  "chat.profile",
  "board.configure",
  "workspace.import",
  "access.manage",
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
    const board = Object.values(before.entities).find(entity => hasEntityKind(entity, "board"))!
    const column = Object.values(before.entities).find(entity => hasEntityKind(entity, "column"))!
    before.entities.item = {
      id: "item", title: "Item", body: "", placement: { parentId: column.id, rank: "0/1" },
      archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", values: {},
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

  it("checks typed content commands without diffing workspace entities", () => {
    const doc = createWorkspaceDoc("ws", "Board", "owner", "blank")
    const column = Object.values(doc.entities).find(entity => hasEntityKind(entity, "column"))!
    doc.entities.item = {
      id: "item", title: "Item", body: "", placement: { parentId: column.id, rank: "0/1" },
      archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", values: {},
    }
    const contentCommands: Command[] = [
      { kind: "createItem", parentId: column.id, title: "New" },
      { kind: "patchItem", entityId: "item", body: "Updated" },
      { kind: "patchItem", entityId: "item", foldNarrativeSources: { expectedBody: "", notes: [] } },
      { kind: "restoreItemVersion", entityId: "item", changeHash: "history-hash" },
    ]
    for (const command of contentCommands) expect(() => assertWorkspaceCommand("editor", doc, command)).not.toThrow()

    expect(() => assertWorkspaceCommand("editor", doc, { kind: "renameEntity", entityId: "item", title: "Renamed" })).not.toThrow()
    expect(() => assertWorkspaceCommand("editor", doc, { kind: "renameEntity", entityId: column.id, title: "Renamed" }))
      .toThrow("Only the owner can edit board structure")
    expect(() => assertWorkspaceCommand("editor", doc, { kind: "updateWorkspaceSettings", settings: {} as never }))
      .toThrow("Only the owner can edit board structure")
    expect(() => assertWorkspaceCommand("owner", doc, { kind: "updateWorkspaceSettings", settings: {} as never })).not.toThrow()
    expect(() => assertWorkspaceCommand("editor", doc, { kind: "renameWorkspace", title: "Renamed" })).not.toThrow()
    expect(() => assertWorkspaceCommand("editor", doc, { kind: "setWorkspaceArchived", archived: true }))
      .toThrow("Only the owner can edit board structure")
    expect(() => assertWorkspaceCommand("owner", doc, { kind: "setWorkspaceArchived", archived: true })).not.toThrow()
    expect(() => assertWorkspaceCommand("visitor", doc, { kind: "patchItem", entityId: "item", body: "No" }))
      .toThrow("Visitors can only view this workspace")
  })
})
