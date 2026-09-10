export type LeadStatus = "lead" | "applied" | "interview" | "rejected" | "offer" | "archived"
export type LeadPriority = "p0" | "p1" | "p2" | "p3"
export type DocumentKind = "cv" | "cover_letter" | "note" | "attachment"
export type DocumentFormat = "markdown" | "html" | "pdf" | "path"
export type ArtifactKind = "cv" | "cover_letter"

export type Lead = {
  id: string
  company: string
  role: string
  url?: string
  location?: string
  workMode?: "remote" | "hybrid" | "onsite" | "unknown"
  status: LeadStatus
  priority?: LeadPriority
  fitScore?: number
  description?: string
  notes?: string
  sourceText?: string
  rejectionReason?: string
  createdAt: string
  updatedAt: string
}

export type Document = {
  id: string
  leadId: string
  kind: DocumentKind
  title: string
  format: DocumentFormat
  content?: string
  localPath?: string
  createdAt: string
  updatedAt: string
}

export type Template = {
  id: string
  name: string
  markdown: string
  createdAt: string
  updatedAt: string
}

export type Artifact = {
  id: string
  leadId: string
  kind: ArtifactKind
  title: string
  pdfPath: string
  templateId: string
  sourceMarkdownPath?: string
  createdAt: string
  updatedAt: string
}

export type Workspace = {
  leads: Lead[]
  documents: Document[]
  templates: Template[]
  artifacts: Artifact[]
}

export type LeadInput = Omit<Lead, "id" | "createdAt" | "updatedAt">
export type DocumentInput = Omit<Document, "id" | "createdAt" | "updatedAt">
export type TemplateInput = Omit<Template, "id" | "createdAt" | "updatedAt">
export type ArtifactInput = Omit<Artifact, "id" | "createdAt" | "updatedAt">

export const statusLabels: Record<LeadStatus, string> = {
  lead: "Lead",
  applied: "Applied",
  interview: "Interview",
  rejected: "Rejected",
  offer: "Offer",
  archived: "Archive",
}

export const statusOrder: LeadStatus[] = ["lead", "applied", "interview", "rejected", "offer", "archived"]

export const priorityLabels: Record<LeadPriority, string> = {
  p0: "P0 · now",
  p1: "P1 · strong",
  p2: "P2 · later",
  p3: "P3 · weak",
}

export const documentKindLabels: Record<DocumentKind, string> = {
  cv: "CV",
  cover_letter: "Cover letter",
  note: "Note",
  attachment: "Attachment",
}

export const artifactKindLabels: Record<ArtifactKind, string> = {
  cv: "CV PDF",
  cover_letter: "Cover letter PDF",
}

export function normalizeWorkspace(workspace: Partial<Workspace>): Workspace {
  return {
    leads: (workspace.leads ?? []).map((lead) => {
      const raw = lead as unknown as { status?: string }
      const status = raw.status
      return {
        ...lead,
        status: status === "bin" ? "archived" : (status as LeadStatus),
      }
    }),
    documents: workspace.documents ?? [],
    templates: workspace.templates ?? [],
    artifacts: workspace.artifacts ?? [],
  }
}
