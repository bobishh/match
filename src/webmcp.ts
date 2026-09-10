import { downloadWorkspaceBundle } from "./storage"
import * as Automerge from "@automerge/automerge/slim"
import type { Artifact, ArtifactInput, ArtifactKind, Document, DocumentInput, Lead, LeadInput, LeadPriority, LeadStatus, Workspace } from "./types"
import { artifactKindLabels, statusLabels } from "./types"
import type { Command } from "./domain/commands"
import type { WorkspaceDocumentV2, WorkspaceEntity, Task, Column, Board } from "./domain/model"
import { isEntityVisible } from "./domain/ancestry"
import { projectWorkspaceSettings, type WorkspaceSettingsDraft } from "./domain/workspaceSettings"

export type ModelContext = {
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

export type ToolStore = {
  workspace: Workspace
  createLead: (input: LeadInput) => Lead | Promise<Lead>
  createLeadAsync?: (input: LeadInput) => Promise<Lead>
  updateLead: (leadId: string, patch: Partial<LeadInput>) => void | Promise<void>
  moveLead: (leadId: string, status: LeadStatus) => void | Promise<void>
  createDocument: (input: DocumentInput) => Document | Promise<Document>
  createArtifact: (input: ArtifactInput) => Artifact | Promise<Artifact>
  persist: () => Promise<void>
  getActiveDoc?: () => WorkspaceDocumentV2 | null
  executeCommandAsync?: (command: Command) => Promise<any>
  createWorkspaceAsync?: (title: string, presetKey: "job-search" | "blank") => Promise<WorkspaceDocumentV2>
  availableWorkspaces?: any
  activeWorkspace?: any
  switchWorkspace?: (id: string) => Promise<void>
  trashItems?: any
  placementIssues?: any
}

const statuses = Object.keys(statusLabels) as LeadStatus[]
const manualDocumentKinds = ["note", "attachment"] as const
const manualFormats = ["markdown", "html", "path"] as const
const priorities: LeadPriority[] = ["p0", "p1", "p2", "p3"]
const artifactKinds = Object.keys(artifactKindLabels) as ArtifactKind[]
const workspaceSettingsSchema = {
  type: "object",
  properties: {
    formatVersion: { type: "number", const: 1 },
    workspace: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
    board: {
      type: "object",
      properties: {
        boardId: { type: "string", description: "Stable board ID returned by get_workspace_settings." },
        boardTitle: { type: "string" },
        entityName: { type: "string", description: "Singular noun used by Add and Edit actions." },
        columns: {
          type: "array",
          description: "Ordered board columns. Omission soft-deletes an existing column and hides its children.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Keep returned IDs when editing. Omit only for new columns." },
              title: { type: "string" },
              displayHint: { type: "string", enum: ["normal", "collapsed"] },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
        fields: {
          type: "array",
          description: "Ordered typed item fields. Omission soft-deletes a field while retaining stored values.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Keep returned IDs when editing. Omit only for new fields." },
              title: { type: "string" },
              valueType: { type: "string", enum: ["text", "number", "boolean", "select", "url", "date", "datetime"] },
              required: { type: "boolean" },
              min: { type: ["number", "null"] },
              max: { type: ["number", "null"] },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: { id: { type: "string" }, title: { type: "string" } },
                  required: ["title"],
                  additionalProperties: false,
                },
              },
            },
            required: ["title", "valueType", "required"],
            additionalProperties: false,
          },
        },
      },
      required: ["boardId", "boardTitle", "entityName", "columns", "fields"],
      additionalProperties: false,
    },
    documentTemplates: {
      type: "array",
      description: "Ordered entity document templates. Keep IDs when editing; omit ID for new templates.",
      items: {
        type: "object",
        properties: { id: { type: "string" }, title: { type: "string" }, markdown: { type: "string" } },
        required: ["title", "markdown"],
        additionalProperties: false,
      },
    },
  },
  required: ["formatVersion", "workspace", "board", "documentTemplates"],
  additionalProperties: false,
} as const

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

export async function registerWebMcp(store: ToolStore, explicitContext?: ModelContext): Promise<(() => void) | undefined> {
  const context = explicitContext ?? (await waitForModelContext())
  if (!context?.registerTool) return undefined
  const lifecycle = new AbortController()

  const register = (tool: Parameters<ModelContext["registerTool"]>[0]) =>
    context.registerTool(tool, { signal: lifecycle.signal })

  // --- GENERIC WEBMCP COMMANDS ---

  await register({
    name: "list_workspaces",
    title: "List workspaces",
    description: "List available workspaces in the local repository.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute() {
      if (store.availableWorkspaces) {
        const list = Array.isArray(store.availableWorkspaces)
          ? store.availableWorkspaces
          : store.availableWorkspaces.value ?? []
        return list
      }
      const doc = store.getActiveDoc?.()
      return doc ? [{ id: doc.id, title: doc.title }] : []
    },
  })

  await register({
    name: "create_workspace",
    title: "Create workspace",
    description: "Create a new board workspace with either job-search or blank preset.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        preset: { type: "string", enum: ["job-search", "blank"] },
      },
      required: ["title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["title", "preset"])
      const title = requiredString(value, "title")
      const preset = (value.preset as "job-search" | "blank") ?? "job-search"
      if (store.createWorkspaceAsync) {
        const ws = await store.createWorkspaceAsync(title, preset)
        return { created: true, id: ws.id, title: ws.title }
      }
      throw new Error("Workspace creation not supported by store")
    },
  })

  await register({
    name: "rename_workspace",
    title: "Rename workspace",
    description: "Update the title of the active workspace.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["title"])
      const title = requiredString(value, "title")
      if (store.executeCommandAsync) {
        await store.executeCommandAsync({ kind: "renameWorkspace", title })
        return { renamed: true, title }
      }
      throw new Error("Command execution not supported by store")
    },
  })

  await register({
    name: "get_workspace",
    title: "Get active workspace",
    description: "Read the active workspace details, entities summary, and active board.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute() {
      const doc = store.getActiveDoc?.()
      if (!doc) throw new Error("No active workspace document")
      const board = Object.values(doc.entities).find((e): e is Board => e.kind === "board")
      return {
        id: doc.id,
        title: doc.title,
        boardId: board?.id,
        entityCount: Object.keys(doc.entities).length,
      }
    },
  })

  await register({
    name: "get_workspace_settings",
    title: "Get workspace settings",
    description: "Read the complete editable workspace configuration: title, board, columns, fields, and document templates. Returns CRDT heads for conflict-safe apply.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute(input) {
      const value = input ? objectInput(input) : {}
      noUnknown(value, [])
      const doc = store.getActiveDoc?.()
      if (!doc) throw new Error("No active workspace document")
      return { settings: projectWorkspaceSettings(doc), heads: Automerge.getHeads(doc) }
    },
  })

  await register({
    name: "apply_workspace_settings",
    title: "Apply workspace settings",
    description: "Validate and apply the complete workspace configuration in one conflict-safe CRDT transaction. Omitted columns, fields, and document templates are soft-deleted.",
    inputSchema: {
      type: "object",
      properties: {
        settings: workspaceSettingsSchema,
        expectedHeads: { type: "array", items: { type: "string" } },
      },
      required: ["settings"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["settings", "expectedHeads"])
      if (!value.settings || typeof value.settings !== "object" || Array.isArray(value.settings)) throw new Error("settings must be an object")
      if (value.expectedHeads !== undefined && (!Array.isArray(value.expectedHeads) || value.expectedHeads.some((head) => typeof head !== "string"))) {
        throw new Error("expectedHeads must be an array of strings")
      }
      if (!store.executeCommandAsync) throw new Error("Command execution not supported by store")
      await store.executeCommandAsync({
        kind: "updateWorkspaceSettings",
        settings: value.settings as WorkspaceSettingsDraft,
        expectedHeads: value.expectedHeads as string[] | undefined,
      })
      const doc = store.getActiveDoc?.()
      if (!doc) throw new Error("Workspace unavailable after apply")
      return { applied: true, settings: projectWorkspaceSettings(doc), heads: Automerge.getHeads(doc) }
    },
  })

  await register({
    name: "list_tasks",
    title: "List tasks",
    description: "List visible non-deleted tasks in the active workspace. Supports filtering by parent column or search text.",
    inputSchema: {
      type: "object",
      properties: {
        parentId: { type: "string" },
        search: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute(input) {
      const value = input ? objectInput(input) : {}
      noUnknown(value, ["parentId", "search"])
      const parentId = optionalString(value, "parentId")
      const search = optionalString(value, "search")?.toLowerCase()

      const doc = store.getActiveDoc?.()
      if (!doc) return []

      return Object.values(doc.entities)
        .filter((e): e is Task => e.kind === "task" && isEntityVisible(doc.entities, e.id))
        .filter((t) => (!parentId || t.placement.parentId === parentId))
        .filter((t) => (!search || `${t.title} ${t.body}`.toLowerCase().includes(search)))
        .map((t) => ({
          id: t.id,
          title: t.title,
          body: t.body,
          parentId: t.placement.parentId,
          rank: t.placement.rank,
          values: t.values,
        }))
    },
  })

  await register({
    name: "get_entity",
    title: "Get entity by ID",
    description: "Read a raw typed entity by its unique ID from the workspace.",
    inputSchema: {
      type: "object",
      properties: { entityId: { type: "string" } },
      required: ["entityId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["entityId"])
      const entityId = requiredString(value, "entityId")
      const doc = store.getActiveDoc?.()
      if (!doc) throw new Error("No active workspace document")
      const entity = doc.entities[entityId]
      if (!entity) throw new Error(`Entity ${entityId} not found`)
      return entity
    },
  })

  await register({
    name: "create_task",
    title: "Create task",
    description: "Create a new task under a parent column or parent task.",
    inputSchema: {
      type: "object",
      properties: {
        parentId: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        values: { type: "object" },
      },
      required: ["parentId", "title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["parentId", "title", "body", "values"])
      const parentId = requiredString(value, "parentId")
      const title = requiredString(value, "title")
      const body = optionalString(value, "body") ?? ""
      const values = (value.values as Record<string, any>) ?? {}

      if (store.executeCommandAsync) {
        const id = crypto.randomUUID()
        await store.executeCommandAsync({
          kind: "createTask",
          id,
          parentId,
          title,
          body,
          values,
        })
        return { created: true, id, parentId, title }
      }
      throw new Error("Command execution not supported by store")
    },
  })

  await register({
    name: "patch_task",
    title: "Patch task",
    description: "Update title, body, or custom field values of an existing task.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        values: { type: "object" },
      },
      required: ["entityId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["entityId", "title", "body", "values"])
      const entityId = requiredString(value, "entityId")
      const title = optionalString(value, "title")
      const body = optionalString(value, "body")
      const values = value.values as Record<string, any> | undefined

      if (store.executeCommandAsync) {
        await store.executeCommandAsync({
          kind: "patchTask",
          entityId,
          title,
          body,
          values,
        })
        return { patched: true, entityId }
      }
      throw new Error("Command execution not supported by store")
    },
  })

  await register({
    name: "move_entity",
    title: "Move entity",
    description: "Reorder or move an entity to a new parent column or task.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string" },
        parentId: { type: "string" },
        beforeId: { type: ["string", "null"] },
      },
      required: ["entityId", "parentId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["entityId", "parentId", "beforeId"])
      const entityId = requiredString(value, "entityId")
      const parentId = requiredString(value, "parentId")
      const beforeId = optionalString(value, "beforeId") ?? null

      if (store.executeCommandAsync) {
        await store.executeCommandAsync({
          kind: "moveEntity",
          entityId,
          parentId,
          beforeId,
        })
        return { moved: true, entityId, parentId }
      }
      throw new Error("Command execution not supported by store")
    },
  })

  await register({
    name: "rename_entity",
    title: "Rename entity",
    description: "Rename an existing entity without modifying its placement or kind.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string" },
        title: { type: "string" },
      },
      required: ["entityId", "title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["entityId", "title"])
      const entityId = requiredString(value, "entityId")
      const title = requiredString(value, "title")

      if (store.executeCommandAsync) {
        await store.executeCommandAsync({
          kind: "renameEntity",
          entityId,
          title,
        })
        return { renamed: true, entityId, title }
      }
      throw new Error("Command execution not supported by store")
    },
  })

  await register({
    name: "set_entity_deleted",
    title: "Delete or restore entity",
    description: "Soft-delete or restore an entity in the active workspace.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string" },
        deleted: { type: "boolean" },
      },
      required: ["entityId", "deleted"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["entityId", "deleted"])
      const entityId = requiredString(value, "entityId")
      if (typeof value.deleted !== "boolean") throw new Error("deleted must be a boolean")

      if (store.executeCommandAsync) {
        await store.executeCommandAsync({
          kind: "setEntityDeleted",
          entityId,
          deleted: value.deleted,
        })
        return { updated: true, entityId, deleted: value.deleted }
      }
      throw new Error("Command execution not supported by store")
    },
  })

  await register({
    name: "restore_and_move",
    title: "Restore and move entity",
    description: "Restore a deleted entity and reassign it to a valid live parent in one transaction.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string" },
        parentId: { type: "string" },
        beforeId: { type: ["string", "null"] },
      },
      required: ["entityId", "parentId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["entityId", "parentId", "beforeId"])
      const entityId = requiredString(value, "entityId")
      const parentId = requiredString(value, "parentId")
      const beforeId = optionalString(value, "beforeId") ?? null

      if (store.executeCommandAsync) {
        await store.executeCommandAsync({
          kind: "restoreAndMove",
          entityId,
          parentId,
          beforeId,
        })
        return { restored: true, entityId, parentId }
      }
      throw new Error("Command execution not supported by store")
    },
  })

  await register({
    name: "list_trash",
    title: "List trash",
    description: "List all soft-deleted entities in the active workspace.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute() {
      if (store.trashItems) {
        const list = Array.isArray(store.trashItems) ? store.trashItems : store.trashItems.value ?? []
        return list.map((item: any) => ({
          id: item.entity?.id ?? item.id,
          title: item.entity?.title ?? item.title,
          kind: item.entity?.kind ?? item.kind,
          parentTitle: item.parentTitle,
        }))
      }
      const doc = store.getActiveDoc?.()
      if (!doc) return []
      return Object.values(doc.entities)
        .filter((e) => e.deleted)
        .map((e) => ({ id: e.id, title: e.title, kind: e.kind }))
    },
  })

  await register({
    name: "list_placement_issues",
    title: "List placement issues",
    description: "List entities that have broken ancestry, cycles, or missing parents needing recovery.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute() {
      if (store.placementIssues) {
        const list = Array.isArray(store.placementIssues) ? store.placementIssues : store.placementIssues.value ?? []
        return list.map((item: any) => ({
          id: item.entity?.id ?? item.id,
          title: item.entity?.title ?? item.title,
          issue: item.issue,
        }))
      }
      return []
    },
  })

  await register({
    name: "create_column",
    title: "Create column",
    description: "Create a new column under the board.",
    inputSchema: {
      type: "object",
      properties: {
        boardId: { type: "string" },
        title: { type: "string" },
        beforeId: { type: ["string", "null"] },
      },
      required: ["boardId", "title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["boardId", "title", "beforeId"])
      const boardId = requiredString(value, "boardId")
      const title = requiredString(value, "title")
      const beforeId = optionalString(value, "beforeId") ?? null

      if (store.executeCommandAsync) {
        await store.executeCommandAsync({ kind: "createColumn", boardId, title, beforeId })
        return { created: true, boardId, title }
      }
      throw new Error("Command execution not supported by store")
    },
  })

  // --- LEGACY TOOLS / ALIASES ---

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
        .map((lead) => ({
          ...lead,
          documentCount: store.workspace.documents.filter((document) => document.leadId === lead.id).length,
          artifactCount: store.workspace.artifacts.filter((artifact) => artifact.leadId === lead.id).length,
        }))
    },
  })

  await register({
    name: "list_templates",
    title: "List writing templates",
    description: "Read workspace-level Markdown templates.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute(input) {
      const value = objectInput(input)
      noUnknown(value, [])
      return store.workspace.templates
    },
  })

  await register({
    name: "get_generation_context",
    title: "Get PDF generation context",
    description: "Read one lead and one matching Markdown template. Use this context to generate a local PDF artifact.",
    inputSchema: { type: "object", properties: { leadId: { type: "string" }, templateId: { type: "string" } }, required: ["leadId", "templateId"], additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["leadId", "templateId"])
      const lead = store.workspace.leads.find((item) => item.id === requiredString(value, "leadId"))
      const template = store.workspace.templates.find((item) => item.id === requiredString(value, "templateId"))
      if (!lead) throw new Error("leadId not found")
      if (!template) throw new Error("templateId not found")
      return { lead, template }
    },
  })

  await register({
    name: "record_pdf_artifact",
    title: "Record generated PDF",
    description: "Attach a locally generated CV or cover-letter PDF to a lead. PDF generation remains local to the agent.",
    inputSchema: {
      type: "object",
      properties: { leadId: { type: "string" }, templateId: { type: "string" }, kind: { type: "string", enum: artifactKinds }, title: { type: "string" }, pdfPath: { type: "string" }, sourceMarkdownPath: { type: "string" } },
      required: ["leadId", "templateId", "kind", "title", "pdfPath"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["leadId", "templateId", "kind", "title", "pdfPath", "sourceMarkdownPath"])
      const leadId = requiredString(value, "leadId")
      const templateId = requiredString(value, "templateId")
      const kind = enumValue(value, "kind", artifactKinds)
      if (!store.workspace.leads.some((lead) => lead.id === leadId)) throw new Error("leadId not found")
      const template = store.workspace.templates.find((item) => item.id === templateId)
      if (!template) throw new Error("templateId not found")
      const artifact = await store.createArtifact({ leadId, templateId, kind, title: requiredString(value, "title"), pdfPath: requiredString(value, "pdfPath"), sourceMarkdownPath: optionalString(value, "sourceMarkdownPath") })
      return { recorded: true, id: artifact.id, leadId: artifact.leadId, pdfPath: artifact.pdfPath }
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
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["company", "role", "url", "location", "workMode", "status", "priority", "fitScore", "notes", "sourceText", "description"])
      const company = requiredString(value, "company")
      const role = requiredString(value, "role")
      const url = optionalString(value, "url")
      const duplicate = store.workspace.leads.find((lead) => (url && lead.url === url) || (lead.company.toLowerCase() === company.toLowerCase() && lead.role.toLowerCase() === role.toLowerCase()))
      if (duplicate) return { duplicate: true, id: duplicate.id, company: duplicate.company, role: duplicate.role }
      const createFn = store.createLeadAsync ?? store.createLead
      const lead = await createFn({
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
    description: "Move one Match card to Lead, Applied, Interview, Offer, or Archive.",
    inputSchema: { type: "object", properties: { leadId: { type: "string" }, status: { type: "string", enum: statuses } }, required: ["leadId", "status"], additionalProperties: false },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["leadId", "status"])
      const leadId = requiredString(value, "leadId")
      const status = enumValue(value, "status", statuses)
      if (!store.workspace.leads.some((lead) => lead.id === leadId)) throw new Error("leadId not found")
      await store.moveLead(leadId, status)
      return { moved: true, id: leadId, status }
    },
  })

  await register({
    name: "add_document",
    title: "Attach document",
    description: "Attach one note or file reference to an existing lead card. CVs and cover letters are recorded as PDF artifacts.",
    inputSchema: {
      type: "object",
      properties: { leadId: { type: "string" }, kind: { type: "string", enum: manualDocumentKinds }, title: { type: "string" }, format: { type: "string", enum: manualFormats }, content: { type: "string" }, localPath: { type: "string" } },
      required: ["leadId", "kind", "title", "format"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["leadId", "kind", "title", "format", "content", "localPath"])
      const leadId = requiredString(value, "leadId")
      if (!store.workspace.leads.some((lead) => lead.id === leadId)) throw new Error("leadId not found")
      const document = await store.createDocument({ leadId, kind: enumValue(value, "kind", [...manualDocumentKinds]), title: requiredString(value, "title"), format: enumValue(value, "format", [...manualFormats]), content: optionalString(value, "content"), localPath: optionalString(value, "localPath") })
      return { attached: true, id: document.id, leadId: document.leadId, title: document.title }
    },
  })

  await register({
    name: "export_workspace",
    title: "Export Match workspace",
    description: "Download flat lead cards, Markdown templates, and local PDF artifact references as JSON.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false },
    execute() {
      downloadWorkspaceBundle(store.workspace)
      return { exported: true, leads: store.workspace.leads.length, documents: store.workspace.documents.length, templates: store.workspace.templates.length, artifacts: store.workspace.artifacts.length }
    },
  })

  return () => lifecycle.abort()
}
