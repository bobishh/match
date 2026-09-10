<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import Sortable from "sortablejs"
import * as Automerge from "@automerge/automerge/slim"
import { downloadWorkspaceBundle, readWorkspaceBundle, defaultStorage } from "./storage"
import { exportWorkspaceBundleV2, readWorkspaceBundleV2 } from "./domain/migration"
import { defaultProofStore } from "./domain/proofs"
import { hydrate, useMatch } from "./state"
import type { ArtifactKind, DocumentKind, Lead, LeadInput, LeadPriority, LeadStatus } from "./types"
import { artifactKindLabels, documentKindLabels, priorityLabels, statusLabels } from "./types"
import type { Task, Column, FieldValue } from "./domain/model"
import { registerWebMcp } from "./webmcp"
import SyncDialog from "./components/SyncDialog.vue"
import LeadFilters from "./components/LeadFilters.vue"
import WorkspacesDialog from "./components/WorkspacesDialog.vue"
import ColumnDialog from "./components/ColumnDialog.vue"
import SchemaEditorDialog from "./components/SchemaEditorDialog.vue"
import type { BoardSchemaDraft } from "./domain/schema"
import type { WorkspaceSettingsDraft } from "./domain/workspaceSettings"
import TaskFormDialog from "./components/TaskFormDialog.vue"
import TaskDetailDialog from "./components/TaskDetailDialog.vue"
import MoveTaskDialog from "./components/MoveTaskDialog.vue"
import MobileDrawer from "./components/MobileDrawer.vue"
import { defaultBoardFilters, matchesTaskFilters, type BoardFilters } from "./filters"
import { useDeviceSync } from "./sync/useDeviceSync"
import { projectEntityHistory } from "./domain/history"

const {
  workspace,
  ready,
  availableWorkspaces,
  activeWorkspace,
  docVersion,
  activeBoard,
  isBlankBoard,
  genericColumns,
  boardFields,
  trashItems,
  placementIssues,
  createWorkspaceAsync,
  switchWorkspace,
  executeCommandAsync,
  getActiveDoc,
  createLead,
  createLeadAsync,
  updateLead,
  moveLead,
  createDocument,
  createDocumentAsync,
  createArtifact,
  createArtifactAsync,
  createTemplate,
  createTemplateAsync,
  updateTemplate,
  updateTemplateAsync,
  documentsFor,
  artifactsFor,
  persist,
  getAutomergeBytes,
  mergeRemoteBytes,
  mergeWorkspaceRecord,
  subscribeLocalChanges
} = useMatch()

const selectedLeadId = ref<string | null>(null)
const detailDialog = ref<HTMLElement | null>(null)
const importInput = ref<HTMLInputElement | null>(null)
const showLeadForm = ref(false)
const showDocumentForm = ref(false)
const showArtifactForm = ref(false)
const search = ref("")
const filters = ref<BoardFilters>(defaultBoardFilters())
const notice = ref("")
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let storageNoticeTimer: ReturnType<typeof setTimeout> | undefined
const isArchiveOpen = ref(false)
const artifactError = ref("")

// Generic board dialog states
const showWorkspaces = ref(false)
const showBoardSettings = ref(false)
const showEntitySettings = ref(false)
const isEditingBoard = ref(false)
const newBoardColumnTitle = ref("")
const boardRef = ref<HTMLElement | null>(null)
const boardRenderKey = ref(0)
let columnSortable: Sortable | null = null
let cardSortables: Sortable[] = []
const showTaskForm = ref(false)
const taskFormParentId = ref("")
const taskFormError = ref("")
const editingColumn = ref<Column | null>(null)
const selectedTaskId = ref<string | null>(null)
const taskToMove = ref<Task | null>(null)
const showMoveDialog = ref(false)
const storageError = ref("")
const hasPendingSave = ref(false)
const hasExperimentalMcp = ref(false)
const showMobileMenu = ref(false)
const menuButtonRef = ref<HTMLButtonElement | null>(null)
const workspaceLabel = computed(() => activeWorkspace.title.toLowerCase() === "job search" ? "jobs" : activeWorkspace.title)
const entityName = computed(() => activeBoard.value?.entityName || (activeBoard.value?.preset?.key === "job-search" ? "lead" : "item"))
const addItemLabel = computed(() => `+ Add ${entityName.value}`)

function toggleMobileMenu() {
  showMobileMenu.value = !showMobileMenu.value
}

function closeMobileMenu() {
  showMobileMenu.value = false
  nextTick(() => {
    menuButtonRef.value?.focus()
  })
}

const loadingMessages = [
  "One good application can change your week.",
  "Your next role is looking for you too.",
  "Small steps count. Keep going.",
  "You have done hard things before.",
  "The right team will see what you bring.",
]
const loadingMessage = loadingMessages[Math.floor(Math.random() * loadingMessages.length)]
const sync = useDeviceSync({
  workspace: { getBytes: getAutomergeBytes, mergeBytes: mergeRemoteBytes, subscribe: subscribeLocalChanges },
  origin: () => window.location.origin,
  availableWorkspaces,
  activeWorkspaceId: () => activeWorkspace?.id || "default",
})

const newLead = ref<LeadInput>({
  company: "",
  role: "",
  url: "",
  location: "Berlin / remote",
  workMode: "remote",
  status: "lead",
  priority: "p2",
  rejectionReason: "",
  fitScore: undefined,
  description: "",
  notes: "",
  sourceText: "",
})

const newDocument = ref({
  kind: "note" as DocumentKind,
  title: "",
  format: "markdown" as "markdown" | "html" | "pdf" | "path",
  content: "",
  localPath: "",
})


const artifactDraft = ref({
  kind: "cv" as ArtifactKind,
  title: "",
  templateId: "",
  pdfPath: "",
  sourceMarkdownPath: "",
})

const selectedLead = computed(() => workspace.leads.find((lead) => lead.id === selectedLeadId.value) ?? null)
const selectedDocuments = computed(() => selectedLead.value ? documentsFor(selectedLead.value.id) : [])
const selectedArtifacts = computed(() => selectedLead.value ? artifactsFor(selectedLead.value.id) : [])
const availableArtifactTemplates = computed(() => workspace.templates)
const totalDocuments = computed(() => workspace.documents.length + workspace.artifacts.length)
const totalTasks = computed(() => genericColumns.value.reduce((total, column) => total + column.tasks.length, 0))

function leadForTask(task: Task) {
  return workspace.leads.find((lead) => lead.id === task.id)
}

function columnStatus(columnId: string): LeadStatus | null {
  const bindings = activeBoard.value?.preset?.bindings
  if (!bindings) return null
  return (Object.entries(bindings).find(([, id]) => id === columnId)?.[0].replace("status.", "") as LeadStatus | undefined) ?? null
}

function taskIsVisible(task: Task, columnId: string) {
  const lead = leadForTask(task)
  const query = search.value.trim().toLowerCase()
  const fieldText = Object.values(task.values).filter((value) => value !== null).join(" ")
  const searchable = lead
    ? `${lead.company} ${lead.role} ${lead.notes ?? ""} ${fieldText}`
    : `${task.title} ${task.body} ${fieldText}`
  return (!query || searchable.toLowerCase().includes(query)) && matchesTaskFilters(task, columnId, filters.value)
}

function tasksForColumn(column: { id: string; tasks: Task[] }) {
  return column.tasks.filter((task) => taskIsVisible(task, column.id))
}

function openBoardTask(task: Task) {
  if (!isBlankBoard.value && leadForTask(task)) selectedLeadId.value = task.id
  else handleOpenTask(task)
}

function destroyBoardSortables() {
  columnSortable?.destroy()
  columnSortable = null
  for (const sortable of cardSortables) sortable.destroy()
  cardSortables = []
}

async function setupBoardSortables() {
  await nextTick()
  destroyBoardSortables()
  const board = boardRef.value
  if (!board || !activeBoard.value) return

  if (isEditingBoard.value) {
    columnSortable = Sortable.create(board, {
      animation: 0,
      direction: "horizontal",
      draggable: ".column",
      handle: ".column-drag-handle",
      filter: "button, input, select, textarea",
      ghostClass: "column-sortable-ghost",
      chosenClass: "column-sortable-chosen",
      dragClass: "column-sortable-drag",
      forceFallback: true,
      fallbackTolerance: 4,
      onEnd(event) {
        if (event.oldIndex === event.newIndex) return
        const entityId = (event.item as HTMLElement).dataset.columnId
        const columns = [...board.querySelectorAll<HTMLElement>(":scope > .column")]
        const index = columns.findIndex((column) => column.dataset.columnId === entityId)
        const beforeId = columns[index + 1]?.dataset.columnId ?? null
        if (!entityId) return
        void executeCommandAsync({ kind: "moveEntity", entityId, parentId: activeBoard.value!.id, beforeId })
          .then(() => { notice.value = "Column moved" })
          .catch((error) => { notice.value = `Move failed: ${error.message}`; boardRenderKey.value += 1 })
      },
    })
    return
  }

  for (const stack of board.querySelectorAll<HTMLElement>(".card-stack[data-column-id]")) {
    cardSortables.push(Sortable.create(stack, {
      group: "board-cards",
      animation: 0,
      draggable: ".lead-card[data-task-id]",
      ghostClass: "card-sortable-ghost",
      chosenClass: "card-sortable-chosen",
      dragClass: "card-sortable-drag",
      emptyInsertThreshold: 48,
      forceFallback: true,
      fallbackTolerance: 4,
      onEnd(event) {
        const item = event.item as HTMLElement
        const taskId = item.dataset.taskId
        const target = event.to as HTMLElement
        const parentId = target.dataset.columnId
        const cards = [...target.querySelectorAll<HTMLElement>(":scope > .lead-card[data-task-id]")]
        const index = cards.findIndex((card) => card.dataset.taskId === taskId)
        const beforeId = cards[index + 1]?.dataset.taskId ?? null
        if (!taskId || !parentId) return
        void executeCommandAsync({ kind: "moveEntity", entityId: taskId, parentId, beforeId })
          .then(() => { notice.value = "Item moved" })
          .catch((error) => { notice.value = `Move failed: ${error.message}`; boardRenderKey.value += 1 })
      },
    }))
  }
}

const selectedTask = computed(() => {
  if (!selectedTaskId.value || !getActiveDoc()) return null
  const doc = getActiveDoc()!
  const entity = doc.entities[selectedTaskId.value]
  return entity && entity.kind === "task" ? entity : null
})

const subtasksForSelectedTask = computed(() => {
  if (!selectedTaskId.value || !getActiveDoc()) return []
  const doc = getActiveDoc()!
  return Object.values(doc.entities).filter(
    (e): e is Task => e.kind === "task" && e.placement.parentId === selectedTaskId.value && !e.deleted
  )
})

const selectedTaskHistory = computed(() => {
  void docVersion.value
  const doc = getActiveDoc()
  if (!doc || !selectedTaskId.value) return []
  return projectEntityHistory(doc, selectedTaskId.value)
})

const candidateParentsForMove = computed(() => {
  if (!taskToMove.value || !getActiveDoc()) return []
  const doc = getActiveDoc()!
  return Object.values(doc.entities)
    .filter((e): e is Task => e.kind === "task" && e.id !== taskToMove.value!.id && !e.deleted)
    .map((t) => ({ id: t.id, title: t.title }))
})

const availableRecoveryColumns = computed(() => {
  void docVersion.value
  if (!getActiveDoc()) return []
  const doc = getActiveDoc()!
  return Object.values(doc.entities).filter((e): e is Column => e.kind === "column" && !e.deleted)
})

const allEntities = computed(() => {
  void docVersion.value
  return getActiveDoc()?.entities ?? {}
})

watch(selectedLeadId, async (leadId) => {
  if (!leadId) return
  await nextTick()
  detailDialog.value?.focus()
})

onMounted(async () => {
  await hydrate()
  sync.joinFromLocation(window.location.href)
  const unregisterWebMcp = await registerWebMcp({
    workspace,
    createLead,
    createLeadAsync,
    updateLead,
    moveLead,
    createDocument,
    createArtifact,
    persist,
    getActiveDoc,
    executeCommandAsync,
    createWorkspaceAsync,
    availableWorkspaces,
    activeWorkspace,
    trashItems,
    placementIssues,
  })
  hasExperimentalMcp.value = Boolean(unregisterWebMcp)
  await setupBoardSortables()
})

watch(
  () => [
    ready.value,
    docVersion.value,
    isEditingBoard.value,
    isArchiveOpen.value,
    boardRenderKey.value,
    genericColumns.value.map((column) => `${column.id}:${column.tasks.map((task) => task.id).join(",")}`).join("|"),
  ],
  () => { void setupBoardSortables() },
  { flush: "post" },
)

watch(notice, (message) => {
  if (noticeTimer) clearTimeout(noticeTimer)
  if (message) noticeTimer = setTimeout(() => { notice.value = "" }, 4_000)
})

watch(storageError, (message) => {
  if (storageNoticeTimer) clearTimeout(storageNoticeTimer)
  if (message) storageNoticeTimer = setTimeout(() => { storageError.value = "" }, 8_000)
})

watch(() => activeWorkspace.id, () => {
  filters.value = defaultBoardFilters()
  search.value = ""
})

onBeforeUnmount(() => {
  destroyBoardSortables()
  if (noticeTimer) clearTimeout(noticeTimer)
  if (storageNoticeTimer) clearTimeout(storageNoticeTimer)
})

async function submitLead() {
  if (!newLead.value.company.trim() || !newLead.value.role.trim()) {
    notice.value = "Company and role required"
    return
  }

  const duplicate = workspace.leads.find((lead) =>
    (newLead.value.url && lead.url === newLead.value.url) ||
    (lead.company.toLowerCase() === newLead.value.company.trim().toLowerCase() &&
      lead.role.toLowerCase() === newLead.value.role.trim().toLowerCase()),
  )

  if (duplicate) {
    notice.value = `Possible duplicate: ${duplicate.company} — ${duplicate.role}`
    selectedLeadId.value = duplicate.id
    showLeadForm.value = false
    return
  }

  const lead = await createLeadAsync({
    ...newLead.value,
    company: newLead.value.company.trim(),
    role: newLead.value.role.trim(),
    url: newLead.value.url?.trim() || undefined,
    fitScore: newLead.value.fitScore || undefined,
  })
  selectedLeadId.value = lead.id
  showLeadForm.value = false
  notice.value = "Lead added"
  resetLeadForm()
}

function resetLeadForm() {
  newLead.value = {
    company: "",
    role: "",
    url: "",
    location: "Berlin / remote",
    workMode: "remote",
    status: "lead",
    priority: "p2",
    rejectionReason: "",
    fitScore: undefined,
    description: "",
    notes: "",
    sourceText: "",
  }
}

async function submitDocument() {
  if (!selectedLead.value || !newDocument.value.title.trim()) return
  await createDocumentAsync({
    leadId: selectedLead.value.id,
    kind: newDocument.value.kind,
    title: newDocument.value.title.trim(),
    format: newDocument.value.format,
    content: newDocument.value.content || undefined,
    localPath: newDocument.value.localPath || undefined,
  })
  showDocumentForm.value = false
  newDocument.value = { kind: "note", title: "", format: "markdown", content: "", localPath: "" }
  notice.value = "Document attached"
}

function openAddItem(columnId: string) {
  if (isBlankBoard.value) {
    openAddTask(columnId)
    return
  }
  resetLeadForm()
  newLead.value.status = columnStatus(columnId) ?? "lead"
  showLeadForm.value = true
}

async function handleSaveTemplate(payload: { id?: string; name: string; markdown: string }) {
  if (payload.id) {
    await updateTemplateAsync(payload.id, { name: payload.name, markdown: payload.markdown })
  } else {
    await createTemplateAsync({ name: payload.name, markdown: payload.markdown })
  }
  notice.value = "Template saved"
}

function openArtifactForm() {
  artifactError.value = ""
  artifactDraft.value = { kind: "cv", title: "", templateId: "", pdfPath: "", sourceMarkdownPath: "" }
  showArtifactForm.value = true
}

async function submitArtifact() {
  if (!selectedLead.value) return
  const artifact = artifactDraft.value
  if (!artifact.title.trim() || !artifact.templateId || !artifact.pdfPath.trim()) {
    artifactError.value = "Title, base template, and PDF path required"
    return
  }
  const template = workspace.templates.find((item) => item.id === artifact.templateId)
  if (!template) {
    artifactError.value = "Choose a base template"
    return
  }
  await createArtifactAsync({
    leadId: selectedLead.value.id,
    kind: artifact.kind,
    title: artifact.title.trim(),
    templateId: artifact.templateId,
    pdfPath: artifact.pdfPath.trim(),
    sourceMarkdownPath: artifact.sourceMarkdownPath.trim() || undefined,
  })
  showArtifactForm.value = false
  artifactError.value = ""
  notice.value = "PDF artifact attached"
}

function setStatus(status: LeadStatus) {
  if (selectedLead.value) moveLead(selectedLead.value.id, status)
}

function handleUpdateRejectionReason(reason: string) {
  if (selectedLead.value) {
    updateLead(selectedLead.value.id, { rejectionReason: reason })
  }
}

function cardDocuments(lead: Lead) {
  return documentsFor(lead.id)
}

function cardArtifacts(lead: Lead) {
  return artifactsFor(lead.id)
}

async function exportWorkspace() {
  const doc = getActiveDoc()
  if (doc) {
    const proofs = await defaultProofStore.listChangeProofs()
    const bundleBytes = await exportWorkspaceBundleV2(doc, proofs)
    const blob = new Blob([bundleBytes], { type: "application/vnd.match+zip" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${doc.title.toLowerCase().replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.match`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    notice.value = "Match bundle exported"
    return
  }
  downloadWorkspaceBundle(workspace, getAutomergeBytes())
  notice.value = "Match bundle exported"
}

function openImport() {
  importInput.value?.click()
}

async function importWorkspace(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ""
  if (!file) return
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const v2Result = await readWorkspaceBundleV2(bytes)
    if (v2Result.ok) {
      for (const proof of v2Result.value.proofs) {
        if (proof?.payload?.changeHash) {
          await defaultProofStore.putChangeProof(proof.payload.changeHash, proof)
        }
      }
      await defaultStorage.saveSnapshot(v2Result.value.doc.id, v2Result.value.doc as any, Automerge.save(v2Result.value.doc as any))
      await defaultStorage.registerWorkspace(v2Result.value.doc.id, v2Result.value.doc.title)
      await switchWorkspace(v2Result.value.doc.id)
      notice.value = "Match bundle imported"
    } else {
      await mergeWorkspaceRecord(await readWorkspaceBundle(file))
      notice.value = "Match bundle merged"
    }
  } catch (error) {
    notice.value = error instanceof Error ? error.message : "Match bundle import failed"
  }
}

function closeDetail() {
  selectedLeadId.value = null
  selectedTaskId.value = null
  showDocumentForm.value = false
  showArtifactForm.value = false
}

// Workspace, board, and task operations
async function handleCreateWorkspace(payload: { title: string; preset: "blank" | "job-search" }) {
  await createWorkspaceAsync(payload.title, payload.preset)
  notice.value = `Workspace "${payload.title}" created`
  showWorkspaces.value = false
}

async function handleSwitchWorkspace(id: string) {
  await switchWorkspace(id)
  notice.value = "Switched workspace"
}

function openAddTask(columnId?: string) {
  storageError.value = ""
  taskFormError.value = ""
  if (columnId) {
    taskFormParentId.value = columnId
  } else {
    const firstGeneric = genericColumns.value[0]?.id
    const boardCols = activeDocColIds()
    taskFormParentId.value = firstGeneric || boardCols[0] || activeBoard.value?.id || ""
  }
  showTaskForm.value = true
}

function activeDocColIds(): string[] {
  if (!getActiveDoc()) return []
  const doc = getActiveDoc()!
  return Object.values(doc.entities)
    .filter((e): e is Column => e.kind === "column" && !e.deleted)
    .map((c) => c.id)
}

async function handleSaveTask(payload: { title: string; body: string; parentId?: string; values: Record<string, FieldValue> }) {
  try {
    storageError.value = ""
    taskFormError.value = ""
    const values = { ...payload.values }
    if (!isBlankBoard.value) {
      for (const field of boardFields.value) {
        if (field.required && !field.deleted && (values[field.id] === undefined || values[field.id] === "")) {
          if (field.title === "Company") values[field.id] = payload.title
          else if (field.title === "Role") values[field.id] = "Task"
        }
      }
    }
    const parentId = payload.parentId || taskFormParentId.value
    await executeCommandAsync({
      kind: "createTask",
      parentId,
      title: payload.title,
      body: payload.body,
      values,
    })
    hasPendingSave.value = false
    showTaskForm.value = false
    notice.value = "Item saved"
  } catch (error: any) {
    storageError.value = "Storage failure: Save failed"
    taskFormError.value = error.message || "Storage failure: Save failed"
    hasPendingSave.value = true
  }
}

const currentDocHeads = computed(() => {
  const doc = getActiveDoc()
  return doc ? Automerge.getHeads(doc) : []
})

async function handleApplySchema(payload: { schema: BoardSchemaDraft; expectedHeads?: any }) {
  if (!activeBoard.value) return
  try {
    await executeCommandAsync({
      kind: "updateBoardSchema",
      boardId: activeBoard.value.id,
      schema: payload.schema,
      expectedHeads: payload.expectedHeads,
    })
    showEntitySettings.value = false
    notice.value = "Schema updated"
  } catch (err: any) {
    notice.value = `Schema update failed: ${err.message}`
  }
}

async function handleApplyWorkspaceSettings(payload: { settings: WorkspaceSettingsDraft; expectedHeads?: any }) {
  try {
    await executeCommandAsync({
      kind: "updateWorkspaceSettings",
      settings: payload.settings,
      expectedHeads: payload.expectedHeads,
    })
    showBoardSettings.value = false
    notice.value = "Workspace settings updated"
  } catch (error: any) {
    notice.value = `Workspace settings failed: ${error.message}`
  }
}

async function handleDeleteTask(taskId: string) {
  await executeCommandAsync({
    kind: "setEntityDeleted",
    entityId: taskId,
    deleted: true,
  })
  selectedTaskId.value = null
    notice.value = "Item archived"
}

function handleOpenTask(task: Task) {
  selectedTaskId.value = task.id
}

function handleAddSubtask(parentTaskId: string) {
  taskFormParentId.value = parentTaskId
  taskFormError.value = ""
  showTaskForm.value = true
}

function handleStartMove(task: Task) {
  taskToMove.value = task
  showMoveDialog.value = true
}

async function handleConfirmMove(newParentId: string) {
  if (!taskToMove.value) return
  await executeCommandAsync({
    kind: "moveEntity",
    entityId: taskToMove.value.id,
    parentId: newParentId,
    beforeId: null,
  })
  showMoveDialog.value = false
  taskToMove.value = null
  notice.value = "Task moved"
}

async function handleRenameColumn(newTitle: string) {
  if (!editingColumn.value) return
  await executeCommandAsync({
    kind: "renameEntity",
    entityId: editingColumn.value.id,
    title: newTitle,
  })
  editingColumn.value = null
  notice.value = "Column renamed"
}

async function handleDeleteColumn() {
  if (!editingColumn.value) return
  await executeCommandAsync({
    kind: "setEntityDeleted",
    entityId: editingColumn.value.id,
    deleted: true,
  })
  editingColumn.value = null
  notice.value = "Column moved to trash"
}

async function handleRestoreItem(entityId: string) {
  await executeCommandAsync({
    kind: "setEntityDeleted",
    entityId,
    deleted: false,
  })
  notice.value = "Item restored"
}

async function handlePlaceEntity(payload: { entityId: string; columnId: string }) {
  await executeCommandAsync({
    kind: "moveEntity",
    entityId: payload.entityId,
    parentId: payload.columnId,
    beforeId: null,
  })
  notice.value = "Item placed"
}

async function handleAddColumn(title: string) {
  if (!title.trim() || !activeBoard.value) return
  await executeCommandAsync({
    kind: "createColumn",
    boardId: activeBoard.value.id,
    title: title.trim(),
  })
  notice.value = `Column "${title.trim()}" created`
}

async function addBoardColumn() {
  await handleAddColumn(newBoardColumnTitle.value)
  newBoardColumnTitle.value = ""
}

async function handleCreateFieldOption(payload: { fieldId: string; title: string }) {
  await executeCommandAsync({
    kind: "createFieldOption",
    fieldId: payload.fieldId,
    title: payload.title,
  })
  notice.value = "Option added"
}
</script>

<template>
  <main v-if="!ready.value" class="loading-screen" aria-busy="true" aria-live="polite">
    <div class="loading-screen-content" role="status">
      <div class="loading-logo" aria-hidden="true">M</div>
      <p class="loading-kicker">MATCH / GETTING READY</p>
      <div class="loading-track" aria-hidden="true"><span></span></div>
      <p class="loading-title">Loading your cards</p>
      <p class="loading-message">{{ loadingMessage }}</p>
    </div>
  </main>

  <main v-else class="shell">
    <header class="topbar">
      <button class="brand brand-button" type="button" aria-label="Open workspaces" @click="showWorkspaces = true">
        <span class="brand-mark">M</span>
        <div>
          <h1>MATCH <span class="brand-separator">//</span> <span class="workspace-heading">{{ workspaceLabel }}</span></h1>
        </div>
      </button>
      <div class="topbar-mobile-controls">
        <span class="local-state"><span class="pulse"></span> {{ sync.isLive.value ? "Live" : "Local" }}</span>
        <button
          ref="menuButtonRef"
          class="button button-quiet mobile-menu-button"
          type="button"
          aria-label="Menu"
          :aria-expanded="showMobileMenu ? 'true' : 'false'"
          aria-controls="mobile-drawer"
          @click="toggleMobileMenu"
        >
          <span class="hamburger-icon" aria-hidden="true">☰</span>
        </button>
      </div>
      <div class="top-actions top-actions-desktop">
        <span class="local-state"><span class="pulse"></span> {{ sync.isLive.value ? "Live" : "Local" }}</span>
        <span v-if="hasPendingSave" class="pending-notice">Pending save</span>
        <button class="button button-quiet" type="button" @click="sync.open">Sync</button>
        <button class="button button-quiet" type="button" aria-label="Workspace settings" @click="showBoardSettings = true">Settings</button>
        <button class="button button-quiet" type="button" @click="isEditingBoard = !isEditingBoard">{{ isEditingBoard ? "Done" : "Edit board" }}</button>
        <button v-if="isEditingBoard" class="button button-primary" type="button" @click="showEntitySettings = true">Edit {{ entityName }}</button>
        <a v-if="hasExperimentalMcp" class="button button-quiet agent-guide-desktop" href="/agent">Agent guide</a>
        <input ref="importInput" class="sr-only" type="file" accept=".match,application/vnd.match+zip" @change="importWorkspace" />
      </div>
    </header>

    <MobileDrawer
      :is-open="showMobileMenu"
      :active-workspace-title="workspaceLabel"
      :is-editing-board="isEditingBoard"
      :entity-name="entityName"
      @close="closeMobileMenu"
      @open-workspaces="showWorkspaces = true"
      @open-board-settings="showBoardSettings = true"
      @toggle-board-edit="isEditingBoard = !isEditingBoard"
      @open-entity-settings="showEntitySettings = true"
      @open-sync="sync.open"
    />

    <aside v-if="notice || (storageError && !showTaskForm)" class="notice-overlay" aria-live="polite" aria-atomic="true">
      <div v-if="storageError && !showTaskForm" role="alert" class="notice notice-error">
        <span>{{ storageError }}</span>
        <button type="button" class="notice-dismiss" aria-label="Dismiss storage notice" @click="storageError = ''">×</button>
      </div>
      <div v-if="notice" class="notice" role="status">
        <span>{{ notice }}</span>
        <button type="button" class="notice-dismiss" aria-label="Dismiss notice" @click="notice = ''">×</button>
      </div>
    </aside>

    <section class="toolbar" aria-label="Match controls">
      <label class="search-field">
        <span>⌕</span>
        <input v-model="search" type="search" :placeholder="isBlankBoard ? 'Search cards' : 'Search company, role, notes'" />
      </label>
      <div class="toolbar-spacer"></div>
      <LeadFilters v-model="filters" :columns="genericColumns" :fields="boardFields" />
      <span class="stats">{{ totalTasks }} cards · {{ totalDocuments }} docs</span>
    </section>

    <section :key="boardRenderKey" ref="boardRef" class="board" :class="{ 'board-editing': isEditingBoard, 'board-bin-open': isArchiveOpen }" role="region" :aria-label="activeWorkspace.title">
      <article
        v-for="column in genericColumns"
        :key="column.id"
        class="column"
        :data-column-id="column.id"
        role="region"
        :aria-label="column.title"
        :class="[columnStatus(column.id) ? `column-${columnStatus(column.id)}` : '', { 'bin-column': column.displayHint === 'collapsed', 'bin-column-open': column.displayHint === 'collapsed' && isArchiveOpen }]"
      >
        <button v-if="column.displayHint === 'collapsed' && !isArchiveOpen" class="bin-closed" type="button" :aria-label="`Open ${column.title} with ${tasksForColumn(column).length} cards`" @click="isArchiveOpen = true"><span class="bin-icon" aria-hidden="true"></span><strong>{{ column.title }}</strong><small>{{ tasksForColumn(column).length }}</small></button>
        <template v-else>
          <header class="column-header" :class="{ 'column-drag-handle': isEditingBoard }">
            <div class="column-title"><span class="column-dot"></span><h2 :title="isEditingBoard ? 'Double-click to edit column' : undefined" @dblclick="isEditingBoard && (editingColumn = column)">{{ column.title }}</h2></div>
            <div class="column-actions"><span class="count">{{ tasksForColumn(column).length }}</span><button v-if="column.displayHint === 'collapsed'" class="bin-close" type="button" :aria-label="`Collapse ${column.title}`" @click="isArchiveOpen = false">×</button><button v-if="isEditingBoard" class="button button-small button-quiet" type="button" aria-label="Edit column" @click="editingColumn = column">Edit</button></div>
          </header>
          <div class="card-stack" :data-column-id="column.id">
            <button v-for="task in tasksForColumn(column)" :key="task.id" class="lead-card task-card" :data-task-id="task.id" type="button" :aria-label="`Open ${task.title}`" @click="openBoardTask(task)">
              <template v-if="leadForTask(task)">
                <div class="card-head"><span class="company">{{ leadForTask(task)?.company }}</span><span v-if="leadForTask(task)?.priority" class="priority" :class="leadForTask(task)?.priority">{{ leadForTask(task)?.priority?.toUpperCase() }}</span></div>
                <strong>{{ leadForTask(task)?.role }}</strong>
                <div class="card-meta"><span v-if="leadForTask(task)?.location">{{ leadForTask(task)?.location }}</span><span v-if="leadForTask(task)?.fitScore !== undefined" class="fit">{{ leadForTask(task)?.fitScore }}/10 fit</span></div>
              </template>
              <template v-else><strong>{{ task.title }}</strong><p v-if="task.body" class="task-card-body">{{ task.body }}</p></template>
            </button>
            <div v-if="!tasksForColumn(column).length" class="empty-column">No cards</div>
          </div>
          <button v-if="!isEditingBoard" class="column-add-button" type="button" :aria-label="`Add ${entityName} to ${column.title}`" @click="openAddItem(column.id)">{{ addItemLabel }}</button>
        </template>
      </article>
      <form v-if="isEditingBoard" class="add-column-card" @submit.prevent="addBoardColumn"><label class="sr-only" for="new-board-column">New column</label><input id="new-board-column" v-model="newBoardColumnTitle" placeholder="New column" /><button class="button button-primary" type="submit">+ Add column</button></form>
    </section>

    <!-- Dialogs -->
    <WorkspacesDialog
      v-if="showWorkspaces"
      :workspaces="availableWorkspaces"
      :active-workspace-id="activeWorkspace.id"
      @close="showWorkspaces = false"
      @switch="handleSwitchWorkspace"
      @create="handleCreateWorkspace"
    />

    <ColumnDialog
      v-if="editingColumn"
      :column-id="editingColumn.id"
      :initial-title="editingColumn.title"
      @close="editingColumn = null"
      @save="handleRenameColumn"
      @delete="handleDeleteColumn"
    />

    <SchemaEditorDialog
      v-if="showBoardSettings && activeBoard && getActiveDoc()"
      :doc="getActiveDoc()!"
      :board="activeBoard"
      :columns="genericColumns"
      :fields="boardFields"
      :templates="workspace.templates"
      :heads="currentDocHeads"
      mode="templates"
      @close="showBoardSettings = false"
      @save-template="handleSaveTemplate"
      @apply-workspace-settings="handleApplyWorkspaceSettings"
    />

    <SchemaEditorDialog
      v-if="showEntitySettings && activeBoard && getActiveDoc()"
      :doc="getActiveDoc()!"
      :board="activeBoard"
      :columns="genericColumns"
      :fields="boardFields"
      :templates="workspace.templates"
      :heads="currentDocHeads"
      mode="entity"
      @close="showEntitySettings = false"
      @apply="handleApplySchema"
      @save-template="handleSaveTemplate"
    />

    <TaskDetailDialog
      v-if="selectedTask"
      :task="selectedTask"
      :subtasks="subtasksForSelectedTask"
      :fields="boardFields"
      :history="selectedTaskHistory"
      @close="selectedTaskId = null"
      @add-subtask="handleAddSubtask"
      @start-move="handleStartMove"
      @delete-task="handleDeleteTask"
    />

    <TaskFormDialog
      v-if="showTaskForm"
      :parent-id="taskFormParentId"
      :fields="boardFields"
      :columns="genericColumns"
      :error-message="taskFormError"
      @cancel="showTaskForm = false; taskFormError = ''"
      @save="handleSaveTask"
    />

    <MoveTaskDialog
      v-if="showMoveDialog && taskToMove"
      :task="taskToMove"
      :candidate-parents="candidateParentsForMove"
      @close="showMoveDialog = false; taskToMove = null"
      @confirm="handleConfirmMove"
    />

    <SyncDialog
      v-if="sync.isOpen.value"
      :step="sync.step.value"
      :title="sync.title.value"
      :qr-code="sync.qrCode.value"
      :invite-url="sync.inviteUrl.value"
      :copy-notice="sync.copyNotice.value"
      :error="sync.error.value"
      :auth-code="sync.authCode.value"
      :invitation-workspace-title="sync.invitationWorkspaceTitle.value"
      :invitation-workspaces="sync.invitationWorkspaces.value"
      :available-workspaces="sync.availableWorkspaces.value"
      :selected-workspace-ids="sync.selectedWorkspaceIds.value"
      :selected-workspace-id="sync.selectedWorkspaceId.value"
      @update:selected-workspace-ids="sync.selectedWorkspaceIds.value = $event"
      @update:selected-workspace-id="sync.selectedWorkspaceId.value = $event"
      @select-sync-all="sync.selectSyncAll"
      @select-sync-workspace="sync.selectSyncWorkspace"
      @generate-workspace-invite="sync.generateWorkspaceInvite"
      @request-enrollment="sync.requestEnrollment"
      @approve-device="sync.approveEnrollment"
      @accept-and-join="sync.acceptWorkspaceJoin"
      @connect="sync.connectToMesh"
      @copy="sync.copyInvite"
      @export="exportWorkspace"
      @import="openImport"
      @dismiss="sync.dismiss"
      @stop="sync.close"
    />

    <div v-if="showLeadForm" class="overlay" @click.self="showLeadForm = false">
      <form class="dialog" role="dialog" aria-modal="true" aria-label="Add item" @submit.prevent="submitLead">
        <div class="dialog-head"><div><span class="eyebrow">New item</span><h2>Add item</h2></div><button class="icon-button" type="button" aria-label="Close" @click="showLeadForm = false">×</button></div>
        <div class="form-grid">
          <label><span>Company *</span><input v-model="newLead.company" autofocus required /></label>
          <label><span>Role *</span><input v-model="newLead.role" required /></label>
          <label class="wide"><span>Job URL</span><input v-model="newLead.url" type="url" placeholder="https://" /></label>
          <label><span>Location</span><input v-model="newLead.location" /></label>
          <label><span>Work mode</span><select v-model="newLead.workMode"><option value="remote">Remote</option><option value="hybrid">Hybrid</option><option value="onsite">On-site</option><option value="unknown">Unknown</option></select></label>
          <label><span>Status</span><select v-model="newLead.status"><option v-for="(label, status) in statusLabels" :key="status" :value="status">{{ label }}</option></select></label>
          <label><span>Priority</span><select v-model="newLead.priority"><option v-for="(label, priority) in priorityLabels" :key="priority" :value="priority">{{ label }}</option></select></label>
          <label><span>Fit score</span><input v-model.number="newLead.fitScore" type="number" min="0" max="10" placeholder="0–10" /></label>
          <label class="wide"><span>Notes</span><textarea v-model="newLead.notes" rows="3" placeholder="Why this matters, gaps, next move…"></textarea></label>
          <label class="wide"><span>Source snapshot</span><textarea v-model="newLead.sourceText" rows="4" placeholder="Paste description if useful for later tailoring…"></textarea></label>
          <label v-if="newLead.status === 'rejected'" class="wide"><span>Rejection notes / retrospective</span><textarea v-model="newLead.rejectionReason" rows="3" placeholder="Optional retrospective note on what went wrong…"></textarea></label>
        </div>
        <div class="dialog-actions"><button class="button button-quiet" type="button" @click="showLeadForm = false">Cancel</button><button class="button button-primary" type="submit">Create item</button></div>
      </form>
    </div>

    <div v-if="selectedLead" class="overlay detail-overlay" role="presentation" @click.self="closeDetail">
      <section ref="detailDialog" class="dialog detail-dialog" role="dialog" aria-modal="true" aria-label="Lead details" tabindex="-1" @keydown.esc="closeDetail">
        <div class="detail-head"><div><span class="eyebrow">Lead card</span><h2>{{ selectedLead.company }}</h2><p>{{ selectedLead.role }}</p></div><button class="icon-button" type="button" aria-label="Close detail" @click="closeDetail">×</button></div>
      <div class="status-strip"><button v-for="(label, status) in statusLabels" :key="status" type="button" :class="{ active: selectedLead.status === status }" @click="setStatus(status)">{{ label }}</button></div>
      <div class="detail-scroll">
        <div class="detail-grid">
          <div><span class="detail-label">Priority</span><strong>{{ selectedLead.priority ? priorityLabels[selectedLead.priority] : "—" }}</strong></div>
          <div><span class="detail-label">Fit</span><strong>{{ selectedLead.fitScore ?? "—" }}<small v-if="selectedLead.fitScore !== undefined">/10</small></strong></div>
          <div><span class="detail-label">Location</span><strong>{{ selectedLead.location || "—" }}</strong></div>
          <div><span class="detail-label">Work mode</span><strong>{{ selectedLead.workMode || "—" }}</strong></div>
        </div>
        <a v-if="selectedLead.url" class="source-link" :href="selectedLead.url" target="_blank" rel="noreferrer">Open job source ↗</a>
        <section v-if="selectedLead.notes" class="detail-section"><span class="detail-label">Notes</span><p class="detail-copy">{{ selectedLead.notes }}</p></section>
        <section v-if="selectedLead.sourceText" class="detail-section"><span class="detail-label">Source snapshot</span><p class="source-snapshot">{{ selectedLead.sourceText }}</p></section>
        <section v-if="selectedLead.status === 'rejected' || selectedLead.rejectionReason" class="detail-section">
          <span class="detail-label">Rejection notes / retrospective</span>
          <textarea
            class="rejection-note-textarea"
            :value="selectedLead.rejectionReason ?? ''"
            placeholder="Optional rejection reason or retrospective note (what went wrong)…"
            rows="3"
            aria-label="Rejection notes"
            @input="handleUpdateRejectionReason(($event.target as HTMLTextAreaElement).value)"
          ></textarea>
        </section>
        <section class="detail-section artifacts-section"><div class="section-heading"><div><span class="detail-label">PDF artifacts</span><h3>{{ selectedArtifacts.length ? `${selectedArtifacts.length} attached` : "No generated PDFs" }}</h3></div><button class="button button-small" type="button" @click="showArtifactForm ? showArtifactForm = false : openArtifactForm()">+ PDF</button></div>
          <form v-if="showArtifactForm" class="document-form" novalidate @submit.prevent="submitArtifact"><label><span>Kind</span><select v-model="artifactDraft.kind" @change="artifactDraft.templateId = ''"><option v-for="(label, kind) in artifactKindLabels" :key="kind" :value="kind">{{ label }}</option></select></label><label><span>Title</span><input v-model="artifactDraft.title" placeholder="Cleo CV" /></label><label><span>Base template</span><select v-model="artifactDraft.templateId"><option value="">Select template</option><option v-for="template in availableArtifactTemplates" :key="template.id" :value="template.id">{{ template.name }}</option></select></label><label><span>PDF path</span><input v-model="artifactDraft.pdfPath" placeholder="/Users/…/cleo-cv.pdf" /></label><label><span>Generated Markdown path</span><input v-model="artifactDraft.sourceMarkdownPath" placeholder="/Users/…/cleo-cv.md" /></label><p v-if="artifactError" class="form-error" role="alert">{{ artifactError }}</p><button class="button button-primary" type="submit">Attach PDF</button></form>
          <div v-for="artifact in selectedArtifacts" :key="artifact.id" class="document-row"><span class="document-icon">{{ artifact.kind === "cv" ? "CV" : "CL" }}</span><div><strong>{{ artifact.title }}</strong><span>{{ artifactKindLabels[artifact.kind] }} · from template</span></div><a :href="`file://${artifact.pdfPath}`" class="open-path" title="Open PDF">Open PDF</a></div>
        </section>

        <section class="detail-section documents-section"><div class="section-heading"><div><span class="detail-label">Notes & files</span><h3>{{ selectedDocuments.length ? `${selectedDocuments.length} attached` : "Nothing attached" }}</h3></div><button class="button button-small" type="button" @click="showDocumentForm = !showDocumentForm">+ Document</button></div>
          <form v-if="showDocumentForm" class="document-form" @submit.prevent="submitDocument"><label><span>Kind</span><select v-model="newDocument.kind"><option value="note">Note</option><option value="attachment">Attachment</option></select></label><label><span>Title</span><input v-model="newDocument.title" required /></label><label><span>Format</span><select v-model="newDocument.format"><option value="markdown">Markdown</option><option value="html">HTML</option><option value="path">Local path</option></select></label><label v-if="newDocument.format === 'path'"><span>Path</span><input v-model="newDocument.localPath" placeholder="/Users/…" /></label><label v-else><span>Content</span><textarea v-model="newDocument.content" rows="5" placeholder="Paste note…"></textarea></label><button class="button button-primary" type="submit">Attach</button></form>
          <div v-for="document in selectedDocuments" :key="document.id" class="document-row"><span class="document-icon">{{ document.kind === "cv" ? "CV" : document.kind === "cover_letter" ? "CL" : "↗" }}</span><div><strong>{{ document.title }}</strong><span>{{ documentKindLabels[document.kind] }} · {{ document.format }}</span></div><a v-if="document.localPath" :href="`file://${document.localPath}`" class="open-path" title="Open local file">Open</a></div>
        </section>
      </div>
      </section>
    </div>
  </main>
</template>
