import { workspaceRole, authorizeLocalChanges, validateIncomingChanges } from "./sync/changeAuthorization"
import { assertWorkspaceTransition } from "./domain/permissions"
import { computed, reactive, ref } from "vue"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "./crdt"
import { defaultStorage, WorkspaceStorage, loadWorkspaceRecord, saveWorkspace, saveWorkspaceRecord, type WorkspaceRecord } from "./storage"
import { bootstrapIdentity, sha256Base64Url, type LocalProfile } from "./domain/identity"
import { createPersonalRoot, registerWorkspaceInRoot, reconcilePersonalRootWorkspaces } from "./domain/personalRoot"
import { createWorkspaceDoc } from "./domain/seeds"
import { validateWorkspaceDoc } from "./domain/model"
import { applyMigrationPlan, createMigrationPlan } from "./domain/migration"
import { executeCommand, type Command } from "./domain/commands"
import type {
  WorkspaceDocumentV2,
  WorkspaceEntity,
  Board,
  Column,
  Task,
  FieldDefinition,
  AttachedDocument,
  DocumentTemplate,
  LegacyWritingTemplate,
  PdfArtifact,
  FieldValue,
  ProjectionIssue,
} from "./domain/model"
import type {
  Artifact,
  ArtifactInput,
  Document,
  DocumentInput,
  Lead,
  LeadInput,
  LeadStatus,
  Template,
  TemplateInput,
  Workspace,
} from "./types"
import { normalizeWorkspace, statusOrder } from "./types"
import { getVisibleChildren, derivePlacementIssues, getChildren, isEntityVisible } from "./domain/ancestry"

const workspace = reactive<Workspace>({ leads: [], documents: [], templates: [], artifacts: [] })
const ready = reactive({ value: false })
const saveState = ref<"idle" | "saving" | "saved" | "error">("idle")
let pendingWrites = 0
let batchSaveFailed = false

let activeDoc: Automerge.Doc<WorkspaceDocumentV2> | null = null
const docVersion = ref(0)
let currentProfile: LocalProfile | null = null
const localChangeListeners = new Set<() => void>()
const storageChannel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("match-workspace")
let reconcilePromise: Promise<void> | undefined

const availableWorkspaces = ref<{ id: string; title: string; updatedAt: string }[]>([])
const activeWorkspaceMeta = reactive<{ id: string; title: string; presetKey: "job-search" | "blank" }>({
  id: "default",
  title: "Job search",
  presetKey: "job-search",
})

export function resetStateForTest(): void {
  activeDoc = null
  currentProfile = null
  ready.value = false
  saveState.value = "idle"
  pendingWrites = 0
  batchSaveFailed = false
  workspace.leads.splice(0, workspace.leads.length)
  workspace.documents.splice(0, workspace.documents.length)
  workspace.templates.splice(0, workspace.templates.length)
  workspace.artifacts.splice(0, workspace.artifacts.length)
  availableWorkspaces.value = []
  activeWorkspaceMeta.id = "default"
  activeWorkspaceMeta.title = "Job search"
  activeWorkspaceMeta.presetKey = "job-search"
  docVersion.value++
  localChangeListeners.clear()
}

function projectWorkspace(doc: Automerge.Doc<WorkspaceDocumentV2>): Workspace {
  const board = Object.values(doc.entities).find((e): e is Board => e.kind === "board")
  const bindings = board?.preset?.bindings ?? {}

  // Invert column bindings: columnId -> status
  const colIdToStatus: Record<string, LeadStatus> = {}
  for (const [key, id] of Object.entries(bindings)) {
    if (key.startsWith("status.")) {
      const statusName = key.replace("status.", "") as LeadStatus
      colIdToStatus[id] = statusName
    }
  }

  // Invert field bindings: fieldId -> lead field name
  const fieldIdToName: Record<string, string> = {}
  for (const [key, id] of Object.entries(bindings)) {
    if (key.startsWith("field.")) {
      fieldIdToName[id] = key.replace("field.", "")
    }
  }

  // Invert option bindings: optionId -> option value
  const optionIdToValue: Record<string, string> = {}
  for (const [key, id] of Object.entries(bindings)) {
    if (key.startsWith("option.")) {
      const parts = key.split(".")
      const val = parts[parts.length - 1]
      optionIdToValue[id] = val
    }
  }

  const tasks = Object.values(doc.entities).filter(
    (e): e is Task => e.kind === "task" && isEntityVisible(doc.entities, e.id)
  )

  const leads: Lead[] = []
  for (const task of tasks) {
    let colId: string | null = task.placement.parentId
    let curr: WorkspaceEntity | undefined = colId ? doc.entities[colId] : undefined
    const visited = new Set<string>()
    while (curr && curr.kind !== "column") {
      if (visited.has(curr.id)) {
        curr = undefined
        break
      }
      visited.add(curr.id)
      curr = curr.placement.parentId ? doc.entities[curr.placement.parentId] : undefined
    }

    const col = curr as Column | undefined
    if (!col) continue
    const status: LeadStatus = (col && colIdToStatus[col.id]) || "lead"

    // Parse company & role from task title or values
    let company = task.title
    let role = ""
    if (task.title.includes(" — ")) {
      const parts = task.title.split(" — ")
      company = parts[0]
      role = parts.slice(1).join(" — ")
    }

    const lead: Lead = {
      id: task.id,
      company,
      role,
      status,
      description: task.body,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }

    // Map custom values to lead fields
    for (const [fieldId, val] of Object.entries(task.values)) {
      const fieldName = fieldIdToName[fieldId]
      if (!fieldName || val === null) continue
      if (fieldName === "company") lead.company = String(val)
      else if (fieldName === "role") lead.role = String(val)
      else if (fieldName === "url") lead.url = String(val)
      else if (fieldName === "location") lead.location = String(val)
      else if (fieldName === "notes") lead.notes = String(val)
      else if (fieldName === "sourceText") lead.sourceText = String(val)
      else if (fieldName === "rejectionReason") lead.rejectionReason = String(val)
      else if (fieldName === "fitScore") lead.fitScore = Number(val)
      else if (fieldName === "workMode") {
        lead.workMode = (optionIdToValue[String(val)] ?? val) as any
      } else if (fieldName === "priority") {
        lead.priority = (optionIdToValue[String(val)] ?? val) as any
      }
    }

    leads.push(lead)
  }

  const documents: Document[] = Object.values(doc.entities)
    .filter((e): e is AttachedDocument => e.kind === "document" && !e.deleted)
    .map((d) => ({
      id: d.id,
      leadId: d.placement.parentId || "",
      kind: d.documentKind,
      title: d.title,
      format: d.format,
      content: d.content || undefined,
      localPath: d.file?.type === "local-file" ? (d.file as any).path : undefined,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }))

  const templates: Template[] = Object.values(doc.entities)
    .filter((e): e is DocumentTemplate | LegacyWritingTemplate => (e.kind === "document_template" || e.kind === "template") && !e.deleted)
    .map((t) => ({
      id: t.id,
      name: t.title,
      markdown: t.markdown,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }))

  const artifacts: Artifact[] = Object.values(doc.entities)
    .filter((e): e is PdfArtifact => e.kind === "artifact" && !e.deleted)
    .map((a) => ({
      id: a.id,
      leadId: a.placement.parentId || "",
      kind: a.artifactKind,
      title: a.title,
      templateId: a.templateId,
      pdfPath: (a.pdf as any).path || (a.pdf as any).fileName || "",
      sourceMarkdownPath: a.sourceMarkdown ? (a.sourceMarkdown as any).path : undefined,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }))

  return { leads, documents, templates, artifacts }
}

function updateReactiveState(doc: Automerge.Doc<WorkspaceDocumentV2>) {
  activeDoc = doc
  const board = Object.values(doc.entities).find((e): e is Board => e.kind === "board")
  activeWorkspaceMeta.id = doc.id
  activeWorkspaceMeta.title = doc.title
  activeWorkspaceMeta.presetKey = board?.preset?.key ?? "blank"
  docVersion.value++

  const projected = projectWorkspace(doc)
  workspace.leads.splice(0, workspace.leads.length, ...projected.leads)
  workspace.documents.splice(0, workspace.documents.length, ...projected.documents)
  workspace.templates.splice(0, workspace.templates.length, ...projected.templates)
  workspace.artifacts.splice(0, workspace.artifacts.length, ...projected.artifacts)
}

async function upgradeJobSearchRejected(doc: Automerge.Doc<WorkspaceDocumentV2>, storage: WorkspaceStorage) {
  if (doc.ownerPersonId !== currentProfile?.identity.personId) return doc
  if (!currentProfile) throw new Error("Identity not initialized")
  for (const entity of Object.values(doc.entities)) {
    if (entity.kind !== "board" || entity.deleted || entity.preset?.key !== "job-search") continue
    if (entity.preset.bindings["status.rejected"] && entity.preset.bindings["field.rejectionReason"]) continue
    const result = await executeCommand(doc, { kind: "upgradeJobSearchRejected", boardId: entity.id }, currentProfile)
    if (!result.ok) throw new Error(result.error.message)
    const bytes = Automerge.getLastLocalChange(result.value.newDoc)!
    await storage.commitTransaction(doc.id, result.value.receipt, bytes, result.value.proof)
    await storage.saveSnapshot(doc.id, result.value.newDoc, Automerge.save(result.value.newDoc))
    doc = result.value.newDoc
  }
  return doc
}

export async function hydrate(storage = defaultStorage) {
  await initializeAutomerge()
  currentProfile = await bootstrapIdentity("Match User")

  // Check last active workspace from localStorage if in browser
  let initialId = "default"
  if (typeof localStorage !== "undefined") {
    const savedActive = localStorage.getItem("match.active_workspace_id")
    if (savedActive) initialId = savedActive
  }

  let loaded = await storage.loadWorkspaceDoc(initialId)
  if (!loaded && initialId !== "default") {
    loaded = await storage.loadWorkspaceDoc("default")
    initialId = "default"
  }

  if (initialId === "default" && currentProfile && storage === defaultStorage) {
    const legacyRecord = await loadWorkspaceRecord()
    const legacyWorkspace = normalizeWorkspace(legacyRecord.workspace)
    const legacyHasContent =
      legacyWorkspace.leads.length > 0 ||
      legacyWorkspace.documents.length > 0 ||
      legacyWorkspace.templates.length > 0 ||
      legacyWorkspace.artifacts.length > 0
    const loadedHasContent = loaded
      ? Object.values(loaded.doc.entities ?? {}).some((entity) =>
          entity.kind === "task" ||
          entity.kind === "document" ||
          entity.kind === "document_template" ||
          entity.kind === "template" ||
          entity.kind === "artifact"
        )
      : false

    if (legacyHasContent && !loadedHasContent) {
      let legacyDoc: Automerge.Doc<any>
      try {
        legacyDoc = legacyRecord.automergeBytes
          ? Automerge.load<any>(legacyRecord.automergeBytes)
          : Automerge.from<any>(legacyWorkspace)
      } catch {
        legacyDoc = Automerge.from<any>(legacyWorkspace)
      }

      const plan = createMigrationPlan(
        legacyWorkspace,
        currentProfile.identity.personId,
        Automerge.getHeads(legacyDoc).sort(),
      )
      if (!plan.ok) {
        throw new Error(`Legacy workspace migration failed: ${plan.error.message}`)
      }

      plan.value.workspaceId = "default"
      const migrated = applyMigrationPlan(plan.value, legacyDoc)
      await storage.saveSnapshot("default", migrated, Automerge.save(migrated))
      await storage.registerWorkspace("default", migrated.title)
      loaded = { doc: migrated, heads: Automerge.getHeads(migrated).sort() }
    }
  }

  if (loaded) {
    updateReactiveState(await upgradeJobSearchRejected(loaded.doc, storage))
  } else {
    const fresh = createWorkspaceDoc("default", "Job search", currentProfile.identity.personId, "job-search")
    const doc = Automerge.from<WorkspaceDocumentV2>(fresh)
    await storage.saveSnapshot("default", doc, Automerge.save(doc))
    await storage.registerWorkspace("default", "Job search")
    updateReactiveState(doc)
  }

  let root = await storage.loadPersonalRoot()
  if (!root && currentProfile) {
    const certBytes = new TextEncoder().encode(JSON.stringify(currentProfile.certificate))
    const certHash = await sha256Base64Url(certBytes)
    root = createPersonalRoot(currentProfile, certHash)
    await storage.savePersonalRoot(root)
  }
  if (root) {
    const list = await storage.listWorkspaces()
    const newlyAdded = reconcilePersonalRootWorkspaces(root, list)
    if (newlyAdded.length > 0) {
      await storage.savePersonalRoot(root)
    }
  }

  // Handle fixture injection if present (e.g. in e2e/recovery.spec.ts)
  if (typeof window !== "undefined" && (window as any).__MATCH_INJECT_FIXTURE__) {
    const fixture = (window as any).__MATCH_INJECT_FIXTURE__
    if (fixture.tasks && activeDoc) {
      activeDoc = Automerge.change(activeDoc, (draft) => {
        const board = Object.values(draft.entities).find((e): e is Board => e.kind === "board")
        if (board) {
          board.preset = { key: "blank", version: 1, bindings: {} }
          let todoCol = Object.values(draft.entities).find((e) => e.kind === "column" && e.title === "To do")
          if (!todoCol) {
            const colId = crypto.randomUUID()
            draft.entities[colId] = {
              id: colId,
              kind: "column",
              title: "To do",
              placement: { parentId: board.id, rank: "0/1" },
              displayHint: "normal",
              deleted: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }
          }
        }
        for (const t of fixture.tasks) {
          draft.entities[t.id] = {
            id: t.id,
            kind: "task",
            title: t.title,
            body: "",
            placement: { parentId: t.parentId, rank: "0/1" },
            deleted: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            values: {},
          }
        }
      })
      updateReactiveState(activeDoc)
    }
  }

  availableWorkspaces.value = await storage.listWorkspaces()
  if (!availableWorkspaces.value.some((w) => w.id === activeWorkspaceMeta.id)) {
    availableWorkspaces.value.unshift({
      id: activeWorkspaceMeta.id,
      title: activeWorkspaceMeta.title,
      updatedAt: new Date().toISOString(),
    })
  }

  ready.value = true
}

export async function commitAndPersist(
  command: Command,
  storage = defaultStorage
): Promise<void> {
  if (!pendingWrites) batchSaveFailed = false
  pendingWrites++
  saveState.value = "saving"
  try {
    await persistCommand(command, storage)
  } catch (error) {
    batchSaveFailed = true
    throw error
  } finally {
    pendingWrites--
    saveState.value = pendingWrites ? "saving" : batchSaveFailed ? "error" : "saved"
  }
}

async function persistCommand(command: Command, storage: WorkspaceStorage): Promise<void> {
  if (!activeDoc || !currentProfile) {
    throw new Error("Workspace not hydrated")
  }

  const role = await workspaceRole(activeDoc, currentProfile)
  if (role === "visitor") throw new Error("Visitors can only view this workspace")
  const result = await executeCommand(activeDoc, command, currentProfile)
  if (!result.ok) {
    throw new Error(`Command failed: [${result.error.code}] ${result.error.message}`)
  }

  const changeBytes = Automerge.getLastLocalChange(result.value.newDoc)
  if (!changeBytes) {
    throw new Error("No change produced")
  }

  assertWorkspaceTransition(role, activeDoc, result.value.newDoc)
  await authorizeLocalChanges(result.value.newDoc, currentProfile, [result.value.receipt.changeHash])

  // Atomic durable persistence
  await storage.commitTransaction(
    activeDoc.id,
    result.value.receipt,
    changeBytes,
    result.value.proof
  )

  // Also update snapshot in storage so browser reload gets latest state
  await storage.saveSnapshot(activeDoc.id, result.value.newDoc, Automerge.save(result.value.newDoc))

  // ONLY after durable commit: publish document & notify
  updateReactiveState(result.value.newDoc)
  await saveWorkspace(workspace).catch(() => {})
  storageChannel?.postMessage({ type: "workspace-persisted" })

  for (const listener of localChangeListeners) {
    listener()
  }
}

async function reconcile(storage = defaultStorage): Promise<void> {
  if (!ready.value || reconcilePromise || !activeDoc) return reconcilePromise

  reconcilePromise = (async () => {
    const loaded = await storage.loadWorkspaceDoc(activeDoc!.id)
    if (!loaded) return
    const beforeHeads = Automerge.getHeads(activeDoc!).sort().join(",")
    const afterHeads = loaded.heads.join(",")
    if (beforeHeads === afterHeads) return

    updateReactiveState(loaded.doc)
    for (const listener of localChangeListeners) listener()
  })().finally(() => {
    reconcilePromise = undefined
  })

  return reconcilePromise
}

storageChannel?.addEventListener("message", () => {
  void reconcile()
})

if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    void reconcile()
  })
  globalThis.document?.addEventListener("visibilitychange", () => {
    if (!globalThis.document.hidden) void reconcile()
  })
}

export function useMatch() {
  const columns = computed(() =>
    statusOrder.map((status) => ({
      status,
      leads: workspace.leads.filter((lead) => lead.status === status),
    }))
  )

  const activeBoard = computed(() => {
    void docVersion.value
    if (!activeDoc) return null
    return Object.values(activeDoc.entities).find((e): e is Board => e.kind === "board") ?? null
  })

  const isBlankBoard = computed(() => activeBoard.value?.preset?.key === "blank")

  const genericColumns = computed(() => {
    void docVersion.value
    if (!activeDoc || !activeBoard.value) return []
    const cols = getChildren(activeDoc.entities, activeBoard.value.id)
      .filter((e): e is Column => e.kind === "column" && !e.deleted)

    return cols.map((col) => {
      const tasks = getVisibleChildren(activeDoc!.entities, col.id)
        .filter((e): e is Task => e.kind === "task")

      return {
        ...col,
        tasks: tasks.map((task) => {
          const subtasks = getChildren(activeDoc!.entities, task.id)
            .filter((e): e is Task => e.kind === "task" && !e.deleted)
          return {
            ...task,
            subtasks,
          }
        }),
      }
    })
  })

  const boardFields = computed(() => {
    void docVersion.value
    if (!activeDoc || !activeBoard.value) return []
    return Object.values(activeDoc.entities).filter(
      (e): e is FieldDefinition => e.kind === "field" && e.placement.parentId === activeBoard.value!.id && !e.deleted
    )
  })

  const trashItems = computed(() => {
    void docVersion.value
    if (!activeDoc) return []
    return Object.values(activeDoc.entities).filter((e) => e.deleted)
  })

  const placementIssues = computed(() => {
    void docVersion.value
    if (!activeDoc) return []
    return derivePlacementIssues(activeDoc.entities)
  })

  async function createWorkspaceAsync(
    title: string,
    presetKey: "job-search" | "blank",
    storage = defaultStorage
  ) {
    if (!currentProfile) currentProfile = await bootstrapIdentity("Match User")
    const wsId = crypto.randomUUID()
    const fresh = createWorkspaceDoc(wsId, title.trim(), currentProfile.identity.personId, presetKey)
    const doc = Automerge.from<WorkspaceDocumentV2>(fresh)
    await storage.saveSnapshot(wsId, doc, Automerge.save(doc))
    await storage.registerWorkspace(wsId, title.trim())
    const root = await storage.loadPersonalRoot()
    if (root) {
      registerWorkspaceInRoot(root, wsId, wsId, "genesis")
      await storage.savePersonalRoot(root)
    }
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("match.active_workspace_id", wsId)
    }
    updateReactiveState(doc)
    availableWorkspaces.value = await storage.listWorkspaces()
    return doc
  }

  async function switchWorkspace(workspaceId: string, storage = defaultStorage) {
    const loaded = await storage.loadWorkspaceDoc(workspaceId)
    if (loaded) {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("match.active_workspace_id", workspaceId)
      }
      updateReactiveState(await upgradeJobSearchRejected(loaded.doc, storage))
    }
  }

  async function renameWorkspaceAsync(workspaceId: string, title: string, storage = defaultStorage) {
    const cleanTitle = title.trim()
    if (!cleanTitle) throw new Error("Workspace name is required")
    if (!currentProfile) currentProfile = await bootstrapIdentity("Match User")
    if (activeDoc?.id === workspaceId) {
      await commitAndPersist({ kind: "renameWorkspace", title: cleanTitle }, storage)
    } else {
      const loaded = await storage.loadWorkspaceDoc(workspaceId)
      if (!loaded) throw new Error("Workspace not found")
      if (loaded.doc.ownerPersonId !== currentProfile.identity.personId) throw new Error("Only the owner can rename this workspace")
      const result = await executeCommand(loaded.doc, { kind: "renameWorkspace", title: cleanTitle }, currentProfile)
      if (!result.ok) throw new Error(result.error.message)
      const change = Automerge.getLastLocalChange(result.value.newDoc)
      if (!change) throw new Error("Workspace rename produced no change")
      await storage.commitTransaction(workspaceId, result.value.receipt, change, result.value.proof)
      await storage.saveSnapshot(workspaceId, result.value.newDoc, Automerge.save(result.value.newDoc))
    }
    availableWorkspaces.value = await storage.listWorkspaces()
  }

  async function deleteWorkspaceAsync(workspaceId: string, storage = defaultStorage) {
    const wasActive = activeDoc?.id === workspaceId
    await storage.deleteWorkspace(workspaceId)
    const root = await storage.loadPersonalRoot()
    if (root?.workspaces[workspaceId]) {
      delete root.workspaces[workspaceId]
      await storage.savePersonalRoot(root)
    }
    availableWorkspaces.value = await storage.listWorkspaces()
    if (!wasActive) return
    const replacement = availableWorkspaces.value[0]
    if (replacement) {
      await switchWorkspace(replacement.id, storage)
    } else {
      await createWorkspaceAsync("Job search", "job-search", storage)
    }
  }

  function resolveColumnId(status: LeadStatus): string {
    if (!activeDoc) throw new Error("Not hydrated")
    const board = Object.values(activeDoc.entities).find((e): e is Board => e.kind === "board")
    const colId = board?.preset?.bindings[`status.${status}`]
    if (colId) return colId
    const col = Object.values(activeDoc.entities).find((e) => e.kind === "column" && e.title.toLowerCase() === status.toLowerCase())
    if (col) return col.id
    throw new Error(`Column for status ${status} not found`)
  }

  function resolveFieldId(name: string): string | undefined {
    if (!activeDoc) return undefined
    const board = Object.values(activeDoc.entities).find((e): e is Board => e.kind === "board")
    return board?.preset?.bindings[`field.${name}`]
  }

  function resolveOptionId(field: string, val: string): string | undefined {
    if (!activeDoc) return undefined
    const board = Object.values(activeDoc.entities).find((e): e is Board => e.kind === "board")
    return board?.preset?.bindings[`option.${field}.${val}`]
  }

  async function createLeadAsync(input: LeadInput): Promise<Lead> {
    const colId = resolveColumnId(input.status)
    const values: Record<string, FieldValue> = {}

    const companyFieldId = resolveFieldId("company")
    if (companyFieldId) values[companyFieldId] = input.company
    const roleFieldId = resolveFieldId("role")
    if (roleFieldId) values[roleFieldId] = input.role
    const urlFieldId = resolveFieldId("url")
    if (urlFieldId && input.url) values[urlFieldId] = input.url
    const locFieldId = resolveFieldId("location")
    if (locFieldId && input.location) values[locFieldId] = input.location
    const fitFieldId = resolveFieldId("fitScore")
    if (fitFieldId && input.fitScore !== undefined) values[fitFieldId] = input.fitScore
    const notesFieldId = resolveFieldId("notes")
    if (notesFieldId && input.notes) values[notesFieldId] = input.notes
    const rejFieldId = resolveFieldId("rejectionReason")
    if (rejFieldId && input.rejectionReason) values[rejFieldId] = input.rejectionReason
    const srcFieldId = resolveFieldId("sourceText")
    if (srcFieldId && input.sourceText) values[srcFieldId] = input.sourceText

    if (input.workMode) {
      const optId = resolveOptionId("workMode", input.workMode)
      const fieldId = resolveFieldId("workMode")
      if (fieldId && optId) values[fieldId] = optId
    }
    if (input.priority) {
      const optId = resolveOptionId("priority", input.priority)
      const fieldId = resolveFieldId("priority")
      if (fieldId && optId) values[fieldId] = optId
    }

    const title = `${input.company} — ${input.role}`
    const taskId = (input as any).id ?? crypto.randomUUID()
    await commitAndPersist({
      kind: "createTask",
      id: taskId,
      parentId: colId,
      title,
      body: input.description ?? "",
      values,
    })

    const created = workspace.leads.find((l) => l.id === taskId) ?? {
      id: taskId,
      company: input.company,
      role: input.role,
      status: input.status,
      description: input.description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    return created
  }

  function createLead(input: LeadInput) {
    const id = crypto.randomUUID()
    void createLeadAsync({ ...input, id } as any)
    return {
      id,
      ...input,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  function updateLead(leadId: string, patch: Partial<LeadInput>) {
    if (!activeDoc) return
    const values: Record<string, FieldValue> = {}
    if (patch.company) {
      const fid = resolveFieldId("company")
      if (fid) values[fid] = patch.company
    }
    if (patch.role) {
      const fid = resolveFieldId("role")
      if (fid) values[fid] = patch.role
    }
    if (patch.workMode) {
      const fid = resolveFieldId("workMode")
      const opt = resolveOptionId("workMode", patch.workMode)
      if (fid && opt) values[fid] = opt
    }
    if (patch.priority) {
      const fid = resolveFieldId("priority")
      const opt = resolveOptionId("priority", patch.priority)
      if (fid && opt) values[fid] = opt
    }
    if (patch.fitScore !== undefined) {
      const fid = resolveFieldId("fitScore")
      if (fid) values[fid] = patch.fitScore
    }
    if (patch.notes !== undefined) {
      const fid = resolveFieldId("notes")
      if (fid) values[fid] = patch.notes
    }
    if (patch.rejectionReason !== undefined) {
      const fid = resolveFieldId("rejectionReason")
      if (fid) values[fid] = patch.rejectionReason
    }

    const existingLead = workspace.leads.find((l) => l.id === leadId)
    const newCompany = patch.company ?? existingLead?.company ?? ""
    const newRole = patch.role ?? existingLead?.role ?? ""
    const newTitle = newCompany && newRole ? `${newCompany} — ${newRole}` : undefined

    void commitAndPersist({
      kind: "patchTask",
      entityId: leadId,
      title: newTitle,
      body: patch.description,
      values,
    })
  }

  function moveLead(leadId: string, status: LeadStatus) {
    const colId = resolveColumnId(status)
    void commitAndPersist({
      kind: "moveEntity",
      entityId: leadId,
      parentId: colId,
      beforeId: null,
    })
  }

  function deleteLead(leadId: string) {
    void commitAndPersist({
      kind: "setEntityDeleted",
      entityId: leadId,
      deleted: true,
    })
  }

  async function createDocumentAsync(input: DocumentInput & { id?: string }): Promise<Document> {
    const docId = input.id ?? crypto.randomUUID()
    await commitAndPersist({
      kind: "addDocument",
      id: docId,
      taskId: input.leadId,
      documentKind: input.kind,
      title: input.title,
      format: input.format,
      content: input.content,
      localPath: input.localPath,
    } as any)
    const created = workspace.documents.find((d) => d.id === docId) ?? {
      id: docId,
      ...input,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    return created
  }

  function createDocument(input: DocumentInput) {
    const id = crypto.randomUUID()
    void createDocumentAsync({ ...input, id })
    return {
      id,
      ...input,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  function updateDocument(documentId: string, patch: Partial<DocumentInput>) {
    void commitAndPersist({
      kind: "patchDocument",
      documentId,
      title: patch.title,
      content: patch.content,
    })
  }

  function deleteDocument(documentId: string) {
    void commitAndPersist({
      kind: "setEntityDeleted",
      entityId: documentId,
      deleted: true,
    })
  }

  async function createTemplateAsync(input: TemplateInput & { id?: string }): Promise<Template> {
    const tplId = input.id ?? crypto.randomUUID()
    await commitAndPersist({
      kind: "createTemplate",
      id: tplId,
      title: input.name,
      markdown: input.markdown,
    } as any)
    const created = workspace.templates.find((t) => t.id === tplId) ?? {
      id: tplId,
      name: input.name,
      markdown: input.markdown,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    return created
  }

  function createTemplate(input: TemplateInput) {
    const id = crypto.randomUUID()
    void createTemplateAsync({ ...input, id })
    return {
      id,
      ...input,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  async function updateTemplateAsync(templateId: string, patch: Partial<TemplateInput>): Promise<void> {
    await commitAndPersist({
      kind: "patchTemplate",
      templateId,
      title: patch.name,
      markdown: patch.markdown,
    })
  }

  function updateTemplate(templateId: string, patch: Partial<TemplateInput>) {
    void updateTemplateAsync(templateId, patch)
  }

  async function createArtifactAsync(input: ArtifactInput & { id?: string }): Promise<Artifact> {
    const artId = input.id ?? crypto.randomUUID()
    await commitAndPersist({
      kind: "recordArtifact",
      id: artId,
      taskId: input.leadId,
      templateId: input.templateId,
      title: input.title,
      artifactKind: input.kind,
      pdf: {
        type: "local-file",
        fileId: crypto.randomUUID(),
        fileName: input.pdfPath,
      },
      sourceMarkdown: input.sourceMarkdownPath
        ? { type: "local-file", fileId: crypto.randomUUID(), fileName: input.sourceMarkdownPath }
        : null,
    } as any)
    const created = workspace.artifacts.find((a) => a.id === artId) ?? {
      id: artId,
      ...input,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    return created
  }

  function createArtifact(input: ArtifactInput) {
    const id = crypto.randomUUID()
    void createArtifactAsync({ ...input, id })
    return {
      id,
      ...input,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  function documentsFor(leadId: string) {
    return workspace.documents.filter((d) => d.leadId === leadId)
  }

  function artifactsFor(leadId: string) {
    return workspace.artifacts.filter((a) => a.leadId === leadId)
  }

  return {
    workspace,
    ready,
    saveState,
    columns,
    availableWorkspaces,
    activeWorkspace: activeWorkspaceMeta,
    docVersion,
    activeBoard,
    isBlankBoard,
    genericColumns,
    boardFields,
    trashItems,
    placementIssues,
    createWorkspaceAsync,
    switchWorkspace,
    renameWorkspaceAsync,
    deleteWorkspaceAsync,
    executeCommandAsync: commitAndPersist,
    getActiveDoc: () => activeDoc,
    getCurrentProfile: () => currentProfile,
    createLead,
    createLeadAsync,
    updateLead,
    moveLead,
    deleteLead,
    createDocument,
    createDocumentAsync,
    updateDocument,
    deleteDocument,
    documentsFor,
    createTemplate,
    createTemplateAsync,
    updateTemplate,
    updateTemplateAsync,
    createArtifact,
    createArtifactAsync,
    artifactsFor,
    persist: async () => {},
    reconcile,
    getAutomergeBytes: () => (activeDoc ? Automerge.save(activeDoc) : new Uint8Array()),
    async readWorkspaceBytes(id: string, storage = defaultStorage): Promise<Uint8Array> {
      const doc = activeDoc?.id === id ? activeDoc : (await storage.loadWorkspaceDoc(id))?.doc
      if (!doc) throw new Error("The selected workspace is unavailable on this device.")
      return Automerge.save(doc)
    },
    async mergeAuthorizedWorkspace(id: string, bytes: Uint8Array, authorization: unknown) {
      const remote = Automerge.load<WorkspaceDocumentV2>(bytes)
      let local = (await defaultStorage.loadWorkspaceDoc(id))?.doc
      if (local && !Object.values(local.entities).some(e => e.kind === "board" && remote.entities[e.id]?.kind === "board")) local = undefined
      await validateIncomingChanges(local, remote, authorization)
      await useMatch().mergeScopedWorkspaceBytes(id, bytes)
    },
    async mergeScopedWorkspaceBytes(id: string, bytes: Uint8Array, storage = defaultStorage): Promise<void> {
      const remote = Automerge.load<WorkspaceDocumentV2>(bytes)
      if (remote.id !== id || !validateWorkspaceDoc(remote).ok) throw new Error("Invalid workspace received.")
      let local = activeDoc?.id === id ? activeDoc : (await storage.loadWorkspaceDoc(id))?.doc
      let merged = remote
      if (local) {
        const sharedBoard = Object.values(local.entities).some(e => e.kind === "board" && remote.entities[e.id]?.kind === "board")
        if (!sharedBoard) {
          const titles = new Set((await storage.listWorkspaces()).map(workspace => workspace.title))
          const baseTitle = `${local.title} (local)`
          let localTitle = baseTitle
          for (let suffix = 2; titles.has(localTitle); suffix += 1) localTitle = `${baseTitle} ${suffix}`
          const localId = crypto.randomUUID()
          const moved = await storage.rekeyWorkspace(id, localId, localTitle)
          if (activeDoc?.id === id) {
            if (typeof localStorage !== "undefined") localStorage.setItem("match.active_workspace_id", localId)
            updateReactiveState(moved)
          }
          const root = await storage.loadPersonalRoot()
          if (root) {
            const previous = root.workspaces[id]
            delete root.workspaces[id]
            root.workspaces[localId] = previous
              ? { ...previous, workspaceId: localId, documentId: localId }
              : { workspaceId: localId, documentId: localId, grantHash: "genesis", forgotten: false }
            registerWorkspaceInRoot(root, id, id, "shared")
            await storage.savePersonalRoot(root)
          }
          local = undefined
        } else {
          if (remote.ownerPersonId !== local.ownerPersonId) throw new Error("Workspace ownership cannot change through sync.")
          merged = Automerge.merge(Automerge.clone(local), remote)
          if (Automerge.getHeads(merged).sort().join() === Automerge.getHeads(local).sort().join()) return
        }
      }
      await storage.saveSnapshot(id, merged, Automerge.save(merged))
      if (activeDoc?.id === id) updateReactiveState(merged)
      availableWorkspaces.value = await storage.listWorkspaces()
      storageChannel?.postMessage({ type: "workspace-persisted" })
      for (const listener of localChangeListeners) listener()
    },
    async mergeRemoteBytes(bytes: Uint8Array, storage = defaultStorage): Promise<void> {
      if (!activeDoc) return
      const remoteDoc = Automerge.load<WorkspaceDocumentV2>(bytes)
      let merged: WorkspaceDocumentV2

      const localHasTasks = Object.values(activeDoc.entities ?? {}).some((e) => e.kind === "task" && !e.deleted)
      const remoteHasTasks = Object.values(remoteDoc.entities ?? {}).some((e) => e.kind === "task" && !e.deleted)

      if (localHasTasks && !remoteHasTasks) {
        merged = activeDoc
      } else if (!localHasTasks && remoteHasTasks) {
        merged = remoteDoc
      } else {
        try {
          merged = Automerge.merge(Automerge.clone(activeDoc), Automerge.clone(remoteDoc))
        } catch {
          merged = Automerge.clone(activeDoc)
        }
        merged = Automerge.clone(merged)
        merged = Automerge.change(merged, (draft) => {
          for (const [id, entity] of Object.entries(activeDoc!.entities ?? {})) {
            if (!draft.entities[id]) draft.entities[id] = entity
          }
          for (const [id, entity] of Object.entries(remoteDoc.entities ?? {})) {
            if (!draft.entities[id]) draft.entities[id] = entity
          }
        })
      }

      activeDoc = merged
      updateReactiveState(merged)
      await storage.saveSnapshot(activeDoc.id, merged, Automerge.save(merged))
      await saveWorkspace(workspace).catch(() => {})
      storageChannel?.postMessage({ type: "workspace-persisted" })
      for (const listener of localChangeListeners) {
        listener()
      }
    },
    async mergeWorkspaceRecord(record: WorkspaceRecord, storage = defaultStorage): Promise<void> {
      await saveWorkspaceRecord(record)
      await reconcile(storage)
    },
    subscribeLocalChanges(listener: () => void) {
      localChangeListeners.add(listener)
      return () => localChangeListeners.delete(listener)
    },
  }
}
