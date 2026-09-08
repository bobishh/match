import { describe, expect, it } from "vitest"
import { createDocument, createLead, deleteDocument, deleteLead, documentsFor, moveLead, updateDocument, updateLead } from "./workspace"
import type { CommandContext } from "./workspace"
import type { Workspace } from "../types"

const context: CommandContext = {
  id: (prefix) => `${prefix}_1`,
  now: () => "2026-09-08T12:00:00.000Z",
}

const empty: Workspace = { leads: [], documents: [] }

describe("workspace commands", () => {
  it("creates a lead without mutating the current workspace", () => {
    const result = createLead(empty, { company: "Cleo", role: "Ruby", status: "lead", priority: "p0" }, context)

    expect(empty.leads).toHaveLength(0)
    expect(result.lead).toMatchObject({ id: "lead_1", company: "Cleo", priority: "p0", createdAt: context.now() })
    expect(result.workspace.leads).toEqual([result.lead])
  })

  it("updates and moves a lead while preserving identity and creation time", () => {
    const created = createLead(empty, { company: "Cleo", role: "Ruby", status: "lead" }, context)
    const updated = updateLead(created.workspace, created.lead.id, { priority: "p1" }, "2026-09-09T12:00:00.000Z")
    const moved = moveLead(updated.workspace, created.lead.id, "applied", "2026-09-10T12:00:00.000Z")

    expect(moved.lead).toMatchObject({ id: "lead_1", createdAt: context.now(), updatedAt: "2026-09-10T12:00:00.000Z", priority: "p1", status: "applied" })
  })

  it("creates, reads, and updates documents on a lead", () => {
    const lead = createLead(empty, { company: "Cleo", role: "Ruby", status: "lead" }, context)
    const created = createDocument(lead.workspace, { leadId: lead.lead.id, kind: "cv", title: "Base CV", format: "markdown" }, context)
    const updated = updateDocument(created.workspace, created.document.id, { title: "Cleo CV" }, "2026-09-09T12:00:00.000Z")

    expect(documentsFor(updated.workspace, lead.lead.id)).toEqual([expect.objectContaining({ id: "doc_1", title: "Cleo CV" })])
  })

  it("deletes a document and cascades lead deletion to its documents", () => {
    const lead = createLead(empty, { company: "Cleo", role: "Ruby", status: "lead" }, context)
    const document = createDocument(lead.workspace, { leadId: lead.lead.id, kind: "cv", title: "CV", format: "markdown" }, context)

    expect(deleteDocument(document.workspace, document.document.id).workspace.documents).toEqual([])
    expect(deleteLead(document.workspace, lead.lead.id).workspace).toEqual({ leads: [], documents: [] })
  })
})
