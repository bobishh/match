import * as Automerge from "@automerge/automerge/slim"
import type { Command } from "./domain/commands"
import { entityKind, isItem, type WorkspaceDocumentV2, type WorkspaceEntity, type Item, type Column, type Board } from "./domain/model"
import { isEntityVisible } from "./domain/ancestry"
import { projectWorkspaceSettings, type WorkspaceSettingsDraft } from "./domain/workspaceSettings"
import { projectItemPriority } from "./domain/priority"

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
  getActiveDoc?: () => WorkspaceDocumentV2 | null
  executeCommandAsync?: (command: Command) => Promise<any>
  createWorkspaceAsync?: (title: string, presetKey: "job-search" | "blank") => Promise<WorkspaceDocumentV2>
  switchWorkspaceAsync?: (workspaceId: string) => Promise<void>
  availableWorkspaces?: any
  activeWorkspace?: any
  trashItems?: any
  placementIssues?: any
  sendChatMessage?: (body: string) => Promise<void>
}

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
              archive: { type: "boolean", enum: [true], description: "Optional. Marks the board's sole Archive column; its collapsed presentation is derived." },
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
        priorityPolicy: {
          type: ["object", "null"],
          description: "Declarative automatic priority policy. Rules are data evaluated by weighted-rules-v1; executable code is never stored.",
          properties: {
            version: { type: "number", const: 1 },
            evaluator: { type: "string", const: "weighted-rules-v1" },
            sort: { type: "string", enum: ["fit_desc", "fit_asc", "manual"] },
            priorityFieldId: { type: "string" },
            fitFieldId: { type: ["string", "null"] },
            rules: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  fieldId: { type: "string" },
                  operator: { type: "string", enum: ["equals", "contains", "at_least", "at_most", "is_set"] },
                  value: { type: ["string", "number", "boolean", "null"] },
                  weight: { type: "number", minimum: -10, maximum: 10 },
                },
                required: ["id", "fieldId", "operator", "value", "weight"],
                additionalProperties: false,
              },
            },
            bands: {
              type: "array",
              items: {
                type: "object",
                properties: { optionId: { type: "string" }, minScore: { type: "number", minimum: 0, maximum: 10 } },
                required: ["optionId", "minScore"],
                additionalProperties: false,
              },
            },
          },
          required: ["version", "evaluator", "priorityFieldId", "fitFieldId", "rules", "bands"],
          additionalProperties: false,
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

function noUnknown(input: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`Unknown fields: ${unknown.join(", ")}`)
}

function workspaceRecords(store: ToolStore) {
  const source = store.availableWorkspaces
    ? Array.isArray(store.availableWorkspaces)
      ? store.availableWorkspaces
      : store.availableWorkspaces.value ?? []
    : []
  const activeId = store.activeWorkspace?.id
  return Array.from(source as ArrayLike<any>, (workspace) => ({
    id: String(workspace.id),
    title: String(workspace.title),
    updatedAt: typeof workspace.updatedAt === "string" ? workspace.updatedAt : undefined,
    active: workspace.id === activeId,
  }))
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
      if (store.availableWorkspaces) return workspaceRecords(store)
      const doc = store.getActiveDoc?.()
      return doc ? [{ id: doc.id, title: doc.title, active: true }] : []
    },
  })

  await register({
    name: "switch_workspace",
    title: "Switch workspace",
    description: "Open an available workspace by stable workspace ID so later commands target it.",
    inputSchema: {
      type: "object",
      properties: { workspaceId: { type: "string" } },
      required: ["workspaceId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["workspaceId"])
      const workspaceId = requiredString(value, "workspaceId")
      const target = workspaceRecords(store).find((workspace) => workspace.id === workspaceId)
      if (!target) throw new Error("Workspace not found")
      if (!store.switchWorkspaceAsync) throw new Error("Workspace switching not supported by store")
      await store.switchWorkspaceAsync(workspaceId)
      return { switched: true, id: target.id, title: target.title }
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
    name: "list_items",
    title: "List items",
    description: "List visible non-deleted items in the active workspace. Supports filtering by parent column or search text.",
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
      const board = Object.values(doc.entities).find((entity): entity is Board => entity.kind === "board" && !entity.deleted)

      return Object.values(doc.entities)
        .filter((e): e is Item => isItem(e) && isEntityVisible(doc.entities, e.id))
        .map(item => projectItemPriority(board, item))
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
    name: "create_item",
    title: "Create item",
    description: "Create a new item under a parent column or parent item.",
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
          kind: "createItem",
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
    name: "patch_item",
    title: "Patch item",
    description: "Update title, body, or custom field values of an existing item.",
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
          kind: "patchItem",
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
    description: "Reorder or move an entity to a new parent column or item.",
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
        return list.map((entry: any) => ({
          id: entry.entity?.id ?? entry.id,
          title: entry.entity?.title ?? entry.title,
          kind: entityKind(entry.entity ?? entry),
          parentTitle: entry.parentTitle,
        }))
      }
      const doc = store.getActiveDoc?.()
      if (!doc) return []
      return Object.values(doc.entities)
        .filter((e) => e.deleted)
        .map((e) => ({ id: e.id, title: e.title, kind: entityKind(e) }))
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

  await register({
    name: "send_chat_message",
    title: "Send workspace chat message",
    description: "Send one message to the active workspace chat.",
    inputSchema: {
      type: "object",
      properties: { body: { type: "string" } },
      required: ["body"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["body"])
      const body = requiredString(value, "body")
      if ([...body].length > 8000) throw new Error("Message must contain 1–8,000 characters")
      if (!store.sendChatMessage) throw new Error("Workspace chat is not available")
      await store.sendChatMessage(body)
      return { sent: true }
    },
  })

  return () => lifecycle.abort()
}
