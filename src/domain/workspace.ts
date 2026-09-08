import type { Document, DocumentInput, Lead, LeadInput, LeadStatus, Workspace } from "../types"

export type CommandContext = {
  id: (prefix: "lead" | "doc") => string
  now: () => string
}

export function createLead(workspace: Workspace, input: LeadInput, context: CommandContext) {
  const timestamp = context.now()
  const lead: Lead = { ...input, id: context.id("lead"), createdAt: timestamp, updatedAt: timestamp }
  return { lead, workspace: { ...workspace, leads: [lead, ...workspace.leads] } }
}

export function updateLead(workspace: Workspace, leadId: string, patch: Partial<LeadInput>, timestamp: string) {
  const current = workspace.leads.find((lead) => lead.id === leadId)
  if (!current) return { lead: undefined, workspace }
  const lead: Lead = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: timestamp }
  return { lead, workspace: { ...workspace, leads: workspace.leads.map((item) => item.id === leadId ? lead : item) } }
}

export function moveLead(workspace: Workspace, leadId: string, status: LeadStatus, timestamp: string) {
  return updateLead(workspace, leadId, { status }, timestamp)
}

export function deleteLead(workspace: Workspace, leadId: string) {
  return {
    workspace: {
      leads: workspace.leads.filter((lead) => lead.id !== leadId),
      documents: workspace.documents.filter((document) => document.leadId !== leadId),
    },
  }
}

export function createDocument(workspace: Workspace, input: DocumentInput, context: CommandContext) {
  const timestamp = context.now()
  const document: Document = { ...input, id: context.id("doc"), createdAt: timestamp, updatedAt: timestamp }
  return { document, workspace: { ...workspace, documents: [document, ...workspace.documents] } }
}

export function updateDocument(workspace: Workspace, documentId: string, patch: Partial<DocumentInput>, timestamp: string) {
  const current = workspace.documents.find((document) => document.id === documentId)
  if (!current) return { document: undefined, workspace }
  const document: Document = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: timestamp }
  return { document, workspace: { ...workspace, documents: workspace.documents.map((item) => item.id === documentId ? document : item) } }
}

export function deleteDocument(workspace: Workspace, documentId: string) {
  return { workspace: { ...workspace, documents: workspace.documents.filter((document) => document.id !== documentId) } }
}

export function documentsFor(workspace: Workspace, leadId: string) {
  return workspace.documents.filter((document) => document.leadId === leadId)
}
