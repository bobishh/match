export type LeadStatus = "lead" | "applied" | "interview" | "rejected" | "offer"
export type LeadPriority = "p0" | "p1" | "p2" | "p3"
export type DocumentKind = "cv" | "cover_letter" | "note" | "attachment"
export type DocumentFormat = "markdown" | "html" | "pdf" | "path"

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

export type Workspace = {
  leads: Lead[]
  documents: Document[]
}

export type LeadInput = Omit<Lead, "id" | "createdAt" | "updatedAt">
export type DocumentInput = Omit<Document, "id" | "createdAt" | "updatedAt">

export const statusLabels: Record<LeadStatus, string> = {
  lead: "Lead",
  applied: "Applied",
  interview: "Interview",
  rejected: "Rejected",
  offer: "Offer",
}

export const statusOrder: LeadStatus[] = ["lead", "applied", "interview", "rejected", "offer"]

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
