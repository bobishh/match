import { downloadWorkspaceBundle } from "./storage"
import type { Document, DocumentFormat, DocumentInput, DocumentKind, Lead, LeadInput, LeadPriority, LeadStatus, Workspace } from "./types"
import { documentKindLabels, statusLabels } from "./types"

type ModelContext = {
  registerTool: (tool: {
    name: string
    title?: string
    description: string
    inputSchema: Record<string, unknown>
    annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean }
    execute: (input: unknown) => unknown | Promise<unknown>
  }, options?: { signal?: AbortSignal }) => void | Promise<void>
}

type ModelContextHost = {
  document?: globalThis.Document & { modelContext?: ModelContext }
  navigator?: Navigator & { modelContext?: ModelContext }
}

type ToolStore = {
  workspace: Workspace
  createLead: (input: LeadInput) => Lead
  updateLead: (leadId: string, patch: Partial<LeadInput>) => void
  moveLead: (leadId: string, status: LeadStatus) => void
  createDocument: (input: DocumentInput) => Document
  persist: () => Promise<void>
}

const statuses = Object.keys(statusLabels) as LeadStatus[]
const kinds = Object.keys(documentKindLabels) as DocumentKind[]
const formats: DocumentFormat[] = ["markdown", "html", "pdf", "path"]
const priorities: LeadPriority[] = ["p0", "p1", "p2", "p3"]

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object")
  return input as Record<string, unknown>
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`)
  return value.trim()
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value.trim()
}

function enumValue<T extends string>(input: Record<string, unknown>, key: string, values: T[], fallback?: T): T {
  const value = input[key] ?? fallback
  if (!values.includes(value as T)) throw new Error(`${key} must be one of: ${values.join(", ")}`)
  return value as T
}

function scoreValue(input: Record<string, unknown>): number | undefined {
  if (input.fitScore === undefined || input.fitScore === null || input.fitScore === "") return undefined
  if (typeof input.fitScore !== "number" || input.fitScore < 0 || input.fitScore > 10) throw new Error("fitScore must be a number from 0 to 10")
  return input.fitScore
}

function noUnknown(input: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`Unknown fields: ${unknown.join(", ")}`)
}

function modelContext(): ModelContext | undefined {
  const host = globalThis as typeof globalThis & ModelContextHost
  return host.document?.modelContext ?? host.navigator?.modelContext
}

async function waitForModelContext(timeoutMs = 3000): Promise<ModelContext | undefined> {
  const deadline = Date.now() + timeoutMs
  do {
    const context = modelContext()
    if (context?.registerTool) return context
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)

  return undefined
}

export async function registerWebMcp(store: ToolStore): Promise<(() => void) | undefined> {
  const context = await waitForModelContext()
  if (!context?.registerTool) return undefined
  const lifecycle = new AbortController()

  const register = (tool: Parameters<ModelContext["registerTool"]>[0]) => context.registerTool(tool, { signal: lifecycle.signal })

  await register({
    name: "list_leads",
    title: "List lead cards",
    description: "Read flat Match cards. Filter by status or search text.",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", enum: statuses }, search: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["status", "search"])
      const status = value.status === undefined ? undefined : enumValue(value, "status", statuses)
      const search = optionalString(value, "search")?.toLowerCase()
      return store.workspace.leads
        .filter((lead) => (!status || lead.status === status) && (!search || `${lead.company} ${lead.role} ${lead.notes ?? ""}`.toLowerCase().includes(search)))
        .map((lead) => ({ ...lead, documentCount: store.workspace.documents.filter((document) => document.leadId === lead.id).length }))
    },
  })

  await register({
    name: "create_lead",
    title: "Create lead card",
    description: "Create one flat Match card. Do not send organization records or nested CRDT payloads.",
    inputSchema: {
      type: "object",
      properties: {
        company: { type: "string" }, role: { type: "string" }, url: { type: "string" }, location: { type: "string" },
        workMode: { type: "string", enum: ["remote", "hybrid", "onsite", "unknown"] }, status: { type: "string", enum: statuses },
        priority: { type: "string", enum: priorities }, fitScore: { type: "number", minimum: 0, maximum: 10 }, notes: { type: "string" }, sourceText: { type: "string" }, description: { type: "string" },
      },
      required: ["company", "role", "status"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["company", "role", "url", "location", "workMode", "status", "priority", "fitScore", "notes", "sourceText", "description"])
      const company = requiredString(value, "company")
      const role = requiredString(value, "role")
      const url = optionalString(value, "url")
      const duplicate = store.workspace.leads.find((lead) => (url && lead.url === url) || (lead.company.toLowerCase() === company.toLowerCase() && lead.role.toLowerCase() === role.toLowerCase()))
      if (duplicate) return { duplicate: true, id: duplicate.id, company: duplicate.company, role: duplicate.role }
      const lead = store.createLead({
        company, role, url, location: optionalString(value, "location"), workMode: value.workMode as LeadInput["workMode"],
        status: enumValue(value, "status", statuses), priority: value.priority === undefined ? undefined : enumValue(value, "priority", priorities),
        fitScore: scoreValue(value), notes: optionalString(value, "notes"), sourceText: optionalString(value, "sourceText"), description: optionalString(value, "description"),
      })
      return { created: true, id: lead.id, status: lead.status, company: lead.company, role: lead.role }
    },
  })

  await register({
    name: "move_lead",
    title: "Move lead card",
    description: "Move one Match card to Lead, Applied, Interview, Rejected, or Offer.",
    inputSchema: { type: "object", properties: { leadId: { type: "string" }, status: { type: "string", enum: statuses } }, required: ["leadId", "status"], additionalProperties: false },
    annotations: { readOnlyHint: false },
    execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["leadId", "status"])
      const leadId = requiredString(value, "leadId")
      const status = enumValue(value, "status", statuses)
      if (!store.workspace.leads.some((lead) => lead.id === leadId)) throw new Error("leadId not found")
      store.moveLead(leadId, status)
      return { moved: true, id: leadId, status }
    },
  })

  await register({
    name: "add_document",
    title: "Attach document",
    description: "Attach one CV, cover letter, note, or file reference to an existing lead card.",
    inputSchema: {
      type: "object",
      properties: { leadId: { type: "string" }, kind: { type: "string", enum: kinds }, title: { type: "string" }, format: { type: "string", enum: formats }, content: { type: "string" }, localPath: { type: "string" } },
      required: ["leadId", "kind", "title", "format"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["leadId", "kind", "title", "format", "content", "localPath"])
      const leadId = requiredString(value, "leadId")
      if (!store.workspace.leads.some((lead) => lead.id === leadId)) throw new Error("leadId not found")
      const document = store.createDocument({ leadId, kind: enumValue(value, "kind", kinds), title: requiredString(value, "title"), format: enumValue(value, "format", formats), content: optionalString(value, "content"), localPath: optionalString(value, "localPath") })
      return { attached: true, id: document.id, leadId: document.leadId, title: document.title }
    },
  })

  await register({
    name: "export_workspace",
    title: "Export Match workspace",
    description: "Download all flat lead cards and attached documents as JSON.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false },
    execute() {
      downloadWorkspaceBundle({ leads: store.workspace.leads, documents: store.workspace.documents })
      return { exported: true, leads: store.workspace.leads.length, documents: store.workspace.documents.length }
    },
  })

  return () => lifecycle.abort()
}
