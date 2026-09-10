import type { Artifact, ArtifactInput, Document, DocumentInput, Lead, LeadInput, LeadStatus, Template, TemplateInput, Workspace } from "../types"

export type CommandContext = {
  id: (prefix: "lead" | "doc" | "template" | "artifact") => string
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
      templates: workspace.templates,
      artifacts: workspace.artifacts.filter((artifact) => artifact.leadId !== leadId),
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

export function createTemplate(workspace: Workspace, input: TemplateInput, context: CommandContext) {
  const timestamp = context.now()
  const template: Template = { ...input, id: context.id("template"), createdAt: timestamp, updatedAt: timestamp }
  return { template, workspace: { ...workspace, templates: [template, ...workspace.templates] } }
}

export function updateTemplate(workspace: Workspace, templateId: string, patch: Partial<TemplateInput>, timestamp: string) {
  const current = workspace.templates.find((template) => template.id === templateId)
  if (!current) return { template: undefined, workspace }
  const template: Template = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: timestamp }
  return { template, workspace: { ...workspace, templates: workspace.templates.map((item) => item.id === templateId ? template : item) } }
}

export function createArtifact(workspace: Workspace, input: ArtifactInput, context: CommandContext) {
  const timestamp = context.now()
  const artifact: Artifact = { ...input, id: context.id("artifact"), createdAt: timestamp, updatedAt: timestamp }
  return { artifact, workspace: { ...workspace, artifacts: [artifact, ...workspace.artifacts] } }
}

export function artifactsFor(workspace: Workspace, leadId: string) {
  return workspace.artifacts.filter((artifact) => artifact.leadId === leadId)
}
