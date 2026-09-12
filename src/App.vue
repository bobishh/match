<!-- Workspace role gates are enforced again at command and sync boundaries. -->
<script setup lang="ts">
import { workspaceRole, effectiveWorkspaceOwner, exportAuthorizations } from "./sync/changeAuthorization"
import type { WorkspaceRole } from "./domain/permissions"
import { bootstrapIdentity } from "./domain/identity"
import ModalLayer from "./components/ModalLayer.vue"
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
import WorkspaceChat from "./components/WorkspaceChat.vue"
import WorkspaceNameSettings from "./components/WorkspaceNameSettings.vue"
import { configureChat, exportChat, receiveChat, subscribeChat } from "./chat/service"
import { useWorkspaceChat } from "./chat/useWorkspaceChat"
import type { BoardSchemaDraft } from "./domain/schema"
import { isArchiveColumn } from "./domain/archive"
import type { WorkspaceSettingsDraft } from "./domain/workspaceSettings"
import TaskFormDialog from "./components/TaskFormDialog.vue"
import TaskDetailDialog from "./components/TaskDetailDialog.vue"
import MoveTaskDialog from "./components/MoveTaskDialog.vue"
import MobileDrawer from "./components/MobileDrawer.vue"
import SaveState from "./components/SaveState.vue"
import { activeFilterCount, defaultBoardFilters, matchesTaskFilters, type BoardFilters } from "./filters"
import { useDeviceSync } from "./sync/useDeviceSync"
import { projectEntityHistory } from "./domain/history"
import { useDelayedFlag } from "./ui/useDelayedFlag"
import { hideLeavingElement, showEnteringElement } from "./ui/modal"
import { describeUserAgent } from "./ui/deviceInfo"
import { orderTasksByPriority } from "./domain/priority"

const {
  workspace,
  ready,
  saveState,
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
  renameWorkspaceAsync,
  deleteWorkspaceAsync,
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
  readWorkspaceBytes,
  mergeAuthorizedWorkspace,
  refreshIdentity,
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
type ArchiveUndo = { workspaceId: string; taskId: string; title: string; action: "restore" } | { workspaceId: string; taskId: string; title: string; action: "move"; parentId: string; beforeId: string | null }
const archiveUndo = ref<ArchiveUndo | null>(null)
const undoSaving = ref(false)
const archiveError = ref("")
const historyRestoreSaving = ref(false)
const historyRestoreError = ref("")
const historyRestoreNotice = ref("")
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
const movedTaskId = ref<string | null>(null)
const movedColumnId = ref<string | null>(null)
let movedHighlightTimer: ReturnType<typeof setTimeout> | undefined
const activeMobileColumnIndex = ref(0)
const showTaskForm = ref(false)
const taskFormParentId = ref("")
const taskFormError = ref("")
const leadFormError = ref("")
const savingItem = ref(false)
const showItemSaving = useDelayedFlag(() => savingItem.value)
const editingColumn = ref<Column | null>(null)
const selectedTaskId = ref<string | null>(null)
const taskToMove = ref<Task | null>(null)
const showMoveDialog = ref(false)
const storageError = ref("")
const hasExperimentalMcp = ref(false)
const showMobileMenu = ref(false)
const menuButtonRef = ref<HTMLButtonElement | null>(null)
const workspaceLabel = computed(() => activeWorkspace.title.toLowerCase() === "job search" ? "jobs" : activeWorkspace.title)
const entityName = computed(() => activeBoard.value?.entityName || (activeBoard.value?.preset?.key === "job-search" ? "lead" : "item"))
const addItemLabel = computed(() => `+ Add ${entityName.value}`)
const automaticPriorityEnabled = computed(() => Boolean(activeBoard.value?.priorityPolicy))

function toggleMobileMenu() {
  showMobileMenu.value = !showMobileMenu.value
}

function closeMobileMenu() {
  showMobileMenu.value = false
}

const showLoading = ref(false)
const startupError = ref("")
let loadingTimer: ReturnType<typeof setTimeout> | undefined
configureChat(async id => {
  const doc = Automerge.load<import("./domain/model").WorkspaceDocumentV2>(await readWorkspaceBytes(id))
  return doc.ownerPersonId
}, async id => {
  const doc = Automerge.load<import("./domain/model").WorkspaceDocumentV2>(await readWorkspaceBytes(id))
  const board = Object.values(doc.entities).find(e => e.kind === "board")
  if (!board) throw new Error("Workspace has no board")
  // Local legacy IDs may collide or be rekeyed on import. Board genesis remains stable.
  return `${doc.ownerPersonId}:${board.id}`
})
const chatWorkspaceId = computed(() => ready.value ? activeWorkspace.id : "")
const chatOwnerId = computed(() => { void docVersion.value; return getActiveDoc()?.ownerPersonId ?? "" })
const chat = useWorkspaceChat(chatWorkspaceId, chatOwnerId)
const currentRole = ref<WorkspaceRole>("visitor")
const roleWorkspaceId = ref("")
const currentWorkspaceOwnerId = ref("")
const sync = useDeviceSync({
  displayName: () => chat.displayName.value,
  identityChanged: refreshIdentity,
  workspace: { getBytes: getAutomergeBytes, mergeBytes: mergeRemoteBytes, subscribe: listener => {
    const stopWorkspace = subscribeLocalChanges(listener)
    const stopChat = subscribeChat(() => listener())
    return () => { stopWorkspace(); stopChat() }
  } },
  workspaceStore: { read: readWorkspaceBytes, merge: mergeAuthorizedWorkspace, readAuthorization: exportAuthorizations, activate: switchWorkspace, readChat: exportChat, mergeChat: receiveChat },
  origin: () => window.location.origin,
  availableWorkspaces,
  activeWorkspaceId: () => activeWorkspace?.id || "default",
  workspaceOwner: async id => {
    const doc = Automerge.load<import("./domain/model").WorkspaceDocumentV2>(await readWorkspaceBytes(id))
    return effectiveWorkspaceOwner(id, doc.ownerPersonId)
  },
})
watch([() => activeWorkspace.id, docVersion, ready, sync.ownershipRevision], async (_, __, onCleanup) => {
  let cancelled = false
  onCleanup(() => { cancelled = true })
  const doc = getActiveDoc()
  if (!doc) return
  const id = doc.id
  const profile = await bootstrapIdentity("My Device")
  const [role, ownerId] = await Promise.all([workspaceRole(doc, profile), effectiveWorkspaceOwner(id, doc.ownerPersonId)])
  if (!cancelled && activeWorkspace.id === id) {
    currentRole.value = role
    currentWorkspaceOwnerId.value = ownerId
    roleWorkspaceId.value = id
  }
}, { immediate: true })
const canEditItems = computed(() => roleWorkspaceId.value === activeWorkspace.id && currentRole.value !== "visitor" &&
  !sync.isWorkspaceAccessRevoked(activeWorkspace.id) && !sync.meshSuccession.value.find(item => item.workspaceId === activeWorkspace.id)?.conflicted)
const activeMeshPeers = computed(() => sync.meshPeers.value.filter(peer =>
  peer.workspaceId === activeWorkspace.id && peer.deviceId !== sync.localDeviceId.value && !peer.revokedAt,
))
const meshPresence = computed<"connected" | "offline" | "empty">(() => {
  if (sync.isWorkspaceAccessRevoked(activeWorkspace.id)) return "offline"
  if (sync.isWorkspaceLive(activeWorkspace.id) || activeMeshPeers.value.some(peer => peer.online)) return "connected"
  return activeMeshPeers.value.length ? "offline" : "empty"
})
const meshPresenceLabel = computed(() => ({
  connected: "Mesh connected",
  offline: "Mesh offline",
  empty: "Mesh empty",
}[meshPresence.value]))
const onlineWorkspaceDevices = computed(() => {
  const ids = new Set(sync.meshPeers.value.filter(peer => peer.workspaceId === activeWorkspace.id && !peer.revokedAt && peer.online)
    .map(peer => peer.deviceId))
  if (sync.localDeviceId.value) ids.add(sync.localDeviceId.value)
  return Math.max(1, ids.size)
})
const onlineWorkspaceEditors = computed(() => {
  const ids = new Set(sync.meshPeers.value.filter(peer => peer.workspaceId === activeWorkspace.id && !peer.revokedAt && peer.online &&
    peer.role === "editor" && peer.personId !== currentWorkspaceOwnerId.value).map(peer => peer.personId))
  if (currentRole.value === "editor" && chat.personId.value) ids.add(chat.personId.value)
  return ids.size
})
const workspacePresenceSummary = computed(() => {
  const editors = onlineWorkspaceEditors.value
  const devices = onlineWorkspaceDevices.value
  return `${editors} ${editors === 1 ? "editor" : "editors"} · ${devices} ${devices === 1 ? "device" : "devices"} online`
})
const revokingPeer = ref("")
const peerAccessError = ref("")
const isWorkspaceOwner = computed(() => currentRole.value === "owner")
const meshParticipantDevices = computed(() => sync.meshPeers.value
  .filter(peer => peer.workspaceId === activeWorkspace.id && peer.personId !== chat.personId.value)
  .map(peer => ({ ...peer, name: chat.members.value.find(member => member.personId === peer.personId)?.name ?? `Participant · ${peer.personId.slice(0, 6)}` })))
const meshMembers = computed(() => {
  const peers = sync.meshPeers.value.filter(peer => peer.workspaceId === activeWorkspace.id && !peer.revokedAt)
  if (!peers.length) return []
  const selfId = chat.personId.value
  const personIds = new Set(peers.map(peer => peer.personId))
  if (selfId) personIds.add(selfId)
  return [...personIds].map(personId => {
    const devices = peers.filter(peer => peer.personId === personId)
    const self = personId === selfId
    const localUserAgent = typeof navigator !== "undefined" ? navigator.userAgent : undefined
    const deviceList = devices.map(peer => {
      const userAgent = peer.userAgent || (self && peer.deviceId === sync.localDeviceId.value ? localUserAgent : undefined)
      return {
        deviceId: peer.deviceId,
        name: peer.deviceName || `Device ${peer.deviceId.slice(0, 6)}`,
        online: peer.online || (self && peer.deviceId === sync.localDeviceId.value),
        lastSeen: peer.lastSeen,
        userAgent,
        description: describeUserAgent(userAgent),
      }
    })
    if (self && sync.localDeviceId.value && !deviceList.some(device => device.deviceId === sync.localDeviceId.value)) {
      deviceList.push({
        deviceId: sync.localDeviceId.value,
        name: "This device",
        online: true,
        lastSeen: new Date().toISOString(),
        userAgent: localUserAgent,
        description: describeUserAgent(localUserAgent),
      })
    }
    const peerRole = devices[0]?.role ?? "visitor"
    return {
      personId,
      name: self ? chat.displayName.value || "You" : chat.members.value.find(member => member.personId === personId)?.name ?? `Participant · ${personId.slice(0, 6)}`,
      role: personId === currentWorkspaceOwnerId.value ? "owner" as const : peerRole === "owner" ? "editor" as const : peerRole,
      online: devices.some(peer => peer.deviceId !== sync.localDeviceId.value && peer.online),
      devices: deviceList.length,
      deviceList,
      self,
    }
  }).sort((a, b) => Number(b.self) - Number(a.self) || Number(b.role === "owner") - Number(a.role === "owner") || a.name.localeCompare(b.name))
})
const activeSuccession = computed(() => sync.meshSuccession.value.find(item => item.workspaceId === activeWorkspace.id))
const successionVotesForSelf = computed(() => activeSuccession.value?.votes.filter(vote => vote.candidatePersonId === chat.personId.value).length ?? 0)
const canClaimSuccession = computed(() => currentRole.value === "editor" && Boolean(activeSuccession.value) &&
  !activeSuccession.value!.conflicted &&
  (activeSuccession.value!.successorPersonId === chat.personId.value ||
    (!activeSuccession.value!.successorPersonId && successionVotesForSelf.value >= activeSuccession.value!.quorum)))
const transferringOwnership = ref("")

async function transferWorkspaceOwnership(personId: string) {
  if (transferringOwnership.value) return
  transferringOwnership.value = personId
  peerAccessError.value = ""
  try { await sync.transferOwnership(personId) }
  catch (error) { peerAccessError.value = error instanceof Error ? error.message : "Could not transfer ownership" }
  finally { transferringOwnership.value = "" }
}

async function leaveWorkspaceMesh() {
  peerAccessError.value = ""
  try { await sync.leaveMesh() }
  catch (error) { peerAccessError.value = error instanceof Error ? error.message : "Could not leave mesh" }
}

async function setWorkspaceSuccessor(personId: string | null) {
  peerAccessError.value = ""
  try { await sync.setSuccessor(personId) }
  catch (error) { peerAccessError.value = error instanceof Error ? error.message : "Could not set successor" }
}

async function voteForWorkspaceSuccessor(personId: string) {
  peerAccessError.value = ""
  try { await sync.voteForSuccessor(personId) }
  catch (error) { peerAccessError.value = error instanceof Error ? error.message : "Could not record vote" }
}

async function claimWorkspaceSuccession() {
  peerAccessError.value = ""
  try { await sync.claimSuccession() }
  catch (error) { peerAccessError.value = error instanceof Error ? error.message : "Could not claim ownership" }
}

async function revokeWorkspacePeer(personId: string) {
  if (revokingPeer.value) return
  revokingPeer.value = personId
  peerAccessError.value = ""
  try { await sync.revokePeer(personId) }
  catch (error) { peerAccessError.value = error instanceof Error ? error.message : "Could not revoke access" }
  finally { revokingPeer.value = "" }
}

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
const visibleTasks = computed(() => genericColumns.value.reduce((total, column) => total + tasksForColumn(column).length, 0))
const hasFilters = computed(() => Boolean(search.value.trim()) || activeFilterCount(filters.value) > 0)
const visibleColumns = computed(() => {
  if (!hasFilters.value || isEditingBoard.value) return genericColumns.value
  // An explicitly selected empty state remains a useful destination for new cards.
  if (filters.value.columnId) return genericColumns.value.filter((column) => column.id === filters.value.columnId)
  return genericColumns.value.filter((column) => tasksForColumn(column).length > 0)
})
function clearFilters() {
  search.value = ""
  filters.value = defaultBoardFilters()
}
function reloadPage() { window.location.reload() }

function leadForTask(task: Task) {
  if (isBlankBoard.value) return undefined
  return workspace.leads.find((lead) => lead.id === task.id)
}

function cardNotes(task: Task) {
  return leadForTask(task)?.notes || task.body
}

function cardFields(task: Task) {
  const bindings = activeBoard.value?.preset?.bindings ?? {}
  const summaryFields = leadForTask(task)
    ? ["company", "role", "priority", "location", "fitScore"].map((name) => bindings[`field.${name}`])
    : []
  return boardFields.value.flatMap((field) => {
    const value = task.values[field.id]
    if (field.deleted || summaryFields.includes(field.id) || value === null || value === undefined || value === "") return []
    const label = field.valueType === "select"
      ? field.options[String(value)]?.title
      : typeof value === "boolean" ? (value ? "Yes" : "No") : String(value)
    return label ? [{ id: field.id, title: field.title, value: label }] : []
  })
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
  return orderTasksByPriority(activeBoard.value, column.tasks.filter((task) => taskIsVisible(task, column.id)))
}

function highlightMoved(entityId: string, kind: "task" | "column") {
  if (movedHighlightTimer) clearTimeout(movedHighlightTimer)
  if (kind === "task") movedTaskId.value = entityId
  else movedColumnId.value = entityId
  movedHighlightTimer = setTimeout(() => {
    movedTaskId.value = null
    movedColumnId.value = null
  }, 700)
}

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

function updateMobileColumnIndex() {
  const board = boardRef.value
  if (!board || window.matchMedia("(min-width: 769px)").matches) return
  const columns = [...board.querySelectorAll<HTMLElement>(":scope > .column")]
  if (!columns.length) return
  const index = columns.reduce((closest, column, current) =>
    Math.abs(column.offsetLeft - board.scrollLeft) < Math.abs(columns[closest].offsetLeft - board.scrollLeft) ? current : closest,
  0)
  activeMobileColumnIndex.value = index
}

function moveMobileColumn(direction: -1 | 1) {
  const board = boardRef.value
  const columns = visibleColumns.value
  if (!board || !columns.length) return
  const target = Math.min(columns.length - 1, Math.max(0, activeMobileColumnIndex.value + direction))
  board.querySelectorAll<HTMLElement>(":scope > .column")[target]?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "nearest", inline: "start" })
  activeMobileColumnIndex.value = target
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
  if (!board || !activeBoard.value || !canEditItems.value) return

  if (isEditingBoard.value) {
    columnSortable = Sortable.create(board, {
      animation: reducedMotion() ? 0 : 180,
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
          .then(() => { highlightMoved(entityId, "column"); notice.value = "Column moved" })
          .catch((error) => { notice.value = `Move failed: ${error.message}`; boardRenderKey.value += 1 })
      },
    })
    return
  }

  for (const stack of board.querySelectorAll<HTMLElement>(".card-stack[data-column-id]")) {
    cardSortables.push(Sortable.create(stack, {
      group: "board-cards",
      animation: reducedMotion() ? 0 : 180,
      draggable: ".lead-card[data-task-id]",
      ghostClass: "card-sortable-ghost",
      chosenClass: "card-sortable-chosen",
      dragClass: "card-sortable-drag",
      emptyInsertThreshold: 48,
      forceFallback: true,
      fallbackTolerance: 4,
      fallbackOnBody: true,
      scroll: true,
      bubbleScroll: true,
      scrollSensitivity: 96,
      scrollSpeed: 16,
      onEnd(event) {
        const item = event.item as HTMLElement
        const taskId = item.dataset.taskId
        const target = event.to as HTMLElement
        const parentId = target.dataset.columnId
        if (!taskId || !parentId) return
        const cards = [...target.querySelectorAll<HTMLElement>(":scope > .lead-card[data-task-id]")]
        const index = cards.findIndex((card) => card.dataset.taskId === taskId)
        const beforeId = cards[index + 1]?.dataset.taskId ?? null
        const sourceColumn = genericColumns.value.find((column) => column.id === event.from.dataset.columnId)
        const sourceIndex = sourceColumn?.tasks.findIndex((task) => task.id === taskId) ?? -1
        const sourceBeforeId = sourceIndex >= 0 ? sourceColumn?.tasks[sourceIndex + 1]?.id ?? null : null
        const targetColumn = genericColumns.value.find((column) => column.id === parentId)
        const isArchiveTarget = targetColumn ? isArchiveColumn(targetColumn) : false
        void executeCommandAsync({ kind: "moveEntity", entityId: taskId, parentId, beforeId })
          .then(() => {
            highlightMoved(taskId, "task")
            if (isArchiveTarget && sourceColumn) {
              archiveUndo.value = { workspaceId: activeWorkspace.id, taskId, title: item.getAttribute("aria-label")?.replace(/^Open /, "") || "item", action: "move", parentId: sourceColumn.id, beforeId: sourceBeforeId }
              notice.value = "Item archived"
            } else notice.value = "Item moved"
          })
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

async function restoreSelectedTaskVersion(changeHash: string) {
  if (!selectedTaskId.value || historyRestoreSaving.value) return
  historyRestoreSaving.value = true
  historyRestoreError.value = ""
  historyRestoreNotice.value = ""
  try {
    await executeCommandAsync({ kind: "restoreTaskVersion", entityId: selectedTaskId.value, changeHash })
    historyRestoreNotice.value = "Version restored"
  } catch (error) {
    historyRestoreError.value = `Restore failed: ${error instanceof Error ? error.message : "try again"}`
  } finally {
    historyRestoreSaving.value = false
  }
}

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
  loadingTimer = setTimeout(() => { showLoading.value = true }, 200)
  try {
    await hydrate()
  } catch {
    startupError.value = "Could not open your local data. Reload to try again."
    return
  } finally {
    clearTimeout(loadingTimer)
    showLoading.value = false
  }
  if (!sync.joinFromLocation(window.location.href)) await sync.startDurableMesh()
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
    canEditItems.value,
    isArchiveOpen.value,
    boardRenderKey.value,
    hasFilters.value,
    visibleColumns.value.map((column) => `${column.id}:${tasksForColumn(column).map((task) => task.id).join(",")}`).join("|"),
  ],
  () => { void setupBoardSortables() },
  { flush: "post" },
)

watch(notice, (message) => {
  if (noticeTimer) clearTimeout(noticeTimer)
  const hasUndo = archiveUndo.value && (message === "Item archived" || message.startsWith("Restore failed"))
  if (message && !hasUndo) noticeTimer = setTimeout(() => { notice.value = "" }, 4_000)
})

watch(() => activeWorkspace.id, () => {
  isEditingBoard.value = false
  editingColumn.value = null
  showEntitySettings.value = false
  showTaskForm.value = false
  showLeadForm.value = false
  filters.value = defaultBoardFilters()
  search.value = ""
  activeMobileColumnIndex.value = 0
  archiveUndo.value = null
  archiveError.value = ""
  historyRestoreError.value = ""
  historyRestoreNotice.value = ""
})

watch(() => visibleColumns.value.map((column) => column.id).join("|"), () => {
  activeMobileColumnIndex.value = 0
  boardRef.value?.scrollTo({ left: 0, behavior: "instant" })
}, { flush: "post" })

onBeforeUnmount(() => {
  void sync.shutdown()
  destroyBoardSortables()
  if (noticeTimer) clearTimeout(noticeTimer)
  clearTimeout(loadingTimer)
  if (movedHighlightTimer) clearTimeout(movedHighlightTimer)
})

async function submitLead() {
  if (savingItem.value) return
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

  savingItem.value = true
  leadFormError.value = ""
  try {
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
  } catch (error) {
    leadFormError.value = error instanceof Error ? error.message : "Save failed. Try again."
  } finally {
    savingItem.value = false
  }
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
  leadFormError.value = ""
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

async function setStatus(status: LeadStatus) {
  if (!selectedLead.value) return
  const task = selectedTask.value ?? getActiveDoc()?.entities[selectedLead.value.id]
  if (!task || task.kind !== "task") return
  const targetColumn = genericColumns.value.find((column) => columnStatus(column.id) === status)
  if (!targetColumn) return
  const priorColumn = genericColumns.value.find((column) => column.id === task.placement.parentId)
  const priorParentId = task.placement.parentId
  if (!priorParentId) return
  const priorIndex = priorColumn?.tasks.findIndex((item) => item.id === task.id) ?? -1
  const beforeId = priorIndex >= 0 ? priorColumn?.tasks[priorIndex + 1]?.id ?? null : null
  try {
    archiveError.value = ""
    await executeCommandAsync({ kind: "moveEntity", entityId: task.id, parentId: targetColumn.id, beforeId: null })
    if (isArchiveColumn(targetColumn)) {
      archiveUndo.value = { workspaceId: activeWorkspace.id, taskId: task.id, title: task.title, action: "move", parentId: priorParentId, beforeId }
      notice.value = "Item archived"
    }
  } catch (error) {
    archiveError.value = `Archive failed: ${error instanceof Error ? error.message : "try again"}`
    notice.value = archiveError.value
  }
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
  if (!isWorkspaceOwner.value) { notice.value = "Only the owner can import into this workspace"; return }
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

async function handleRenameWorkspace(payload: { id: string; title: string }) {
  await renameWorkspaceAsync(payload.id, payload.title)
  notice.value = `Workspace renamed to "${payload.title}"`
}

async function handleDeleteWorkspace(id: string) {
  await sync.close()
  await deleteWorkspaceAsync(id)
  notice.value = "Workspace deleted"
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
  if (savingItem.value) return
  savingItem.value = true
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
    showTaskForm.value = false
    notice.value = "Item saved"
  } catch (error: any) {
    storageError.value = "Storage failure: Save failed"
    taskFormError.value = error.message || "Storage failure: Save failed"
  } finally {
    savingItem.value = false
  }
}

const currentDocHeads = computed(() => {
  void docVersion.value
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
  const task = selectedTask.value
  try {
    archiveError.value = ""
    await executeCommandAsync({
      kind: "setEntityDeleted",
      entityId: taskId,
      deleted: true,
    })
    archiveUndo.value = task ? { workspaceId: activeWorkspace.id, taskId, title: task.title, action: "restore" } : null
    selectedTaskId.value = null
    notice.value = "Item archived"
  } catch (error) {
    archiveError.value = `Archive failed: ${error instanceof Error ? error.message : "try again"}`
    notice.value = archiveError.value
  }
}

async function undoArchive() {
  const archived = archiveUndo.value
  if (!archived || archived.workspaceId !== activeWorkspace.id || undoSaving.value) return
  undoSaving.value = true
  try {
    if (archived.action === "restore") {
      await executeCommandAsync({ kind: "setEntityDeleted", entityId: archived.taskId, deleted: false })
    } else {
      await executeCommandAsync({ kind: "moveEntity", entityId: archived.taskId, parentId: archived.parentId, beforeId: archived.beforeId })
    }
    archiveUndo.value = null
    archiveError.value = ""
    notice.value = `Restored ${archived.title}`
    highlightMoved(archived.taskId, "task")
  } catch (error) {
    archiveError.value = `Restore failed: ${error instanceof Error ? error.message : "try again"}`
    notice.value = archiveError.value
  } finally {
    undoSaving.value = false
  }
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
  <main class="shell" :aria-busy="!ready.value && !startupError">
    <header class="topbar">
      <button class="brand brand-button" type="button" aria-label="Open workspaces" :disabled="!ready.value" @click="showWorkspaces = true">
        <span class="brand-presence">
          <span v-if="ready.value && currentRole === 'owner'" class="owner-crown" role="img" aria-label="Workspace role: owner">♛</span>
          <span v-else-if="ready.value" class="workspace-role-icon" role="img" :aria-label="`Workspace role: ${currentRole}`">
            <svg v-if="currentRole === 'editor'" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 11.5 2.5 14l2.5-.5L13 5.5 10.5 3zM9.5 4l2.5 2.5" />
            </svg>
            <svg v-else viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="6.5" cy="6.5" r="4" />
              <path d="m9.5 9.5 4 4" />
            </svg>
          </span>
          <span class="brand-mark" :class="`is-${meshPresence}`" role="img" :aria-label="meshPresenceLabel">M</span>
        </span>
        <div>
          <h1>MATCH <span class="brand-separator">//</span> <span class="workspace-heading">{{ ready.value ? workspaceLabel : '…' }}</span></h1>
          <span v-if="ready.value" class="workspace-presence-summary" aria-label="Workspace presence">{{ workspacePresenceSummary }}</span>
        </div>
      </button>
      <div class="topbar-mobile-controls">
        <button class="button button-quiet button-small" type="button" aria-label="Workspace chat" :disabled="!ready.value" @click="chat.open.value = true">Chat<span v-if="chat.unread.value"> · {{ chat.unread.value }}</span></button>
        <button
          ref="menuButtonRef"
          class="button button-quiet mobile-menu-button"
          type="button"
          aria-label="Menu"
          :disabled="!ready.value"
          :aria-expanded="showMobileMenu ? 'true' : 'false'"
          aria-controls="mobile-drawer"
          @click="toggleMobileMenu"
        >
          <span class="hamburger-icon" aria-hidden="true">☰</span>
        </button>
      </div>
      <div class="top-actions top-actions-desktop" :inert="!ready.value || undefined">
        <button class="button button-quiet" type="button" aria-label="Workspace chat" @click="chat.open.value = true">Chat<span v-if="chat.unread.value"> · {{ chat.unread.value }}</span></button>
        <button class="button button-quiet" type="button" @click="sync.open">Sync</button>
        <button class="button button-quiet" type="button" aria-label="Workspace settings" @click="showBoardSettings = true">Settings</button>
        <button v-if="isWorkspaceOwner" class="button button-quiet" type="button" @click="isEditingBoard = !isEditingBoard">{{ isEditingBoard ? "Done" : "Edit board" }}</button>
        <button v-if="isEditingBoard" class="button button-primary" type="button" @click="showEntitySettings = true">Edit {{ entityName }}</button>
        <a v-if="hasExperimentalMcp" class="button button-quiet agent-guide-desktop" href="/agent">Agent guide</a>
        <input ref="importInput" class="sr-only" type="file" accept=".match,application/vnd.match+zip" @change="importWorkspace" />
      </div>
    </header>

    <section v-if="!ready.value" class="boot-placeholder" aria-label="Opening workspace">
      <div class="boot-toolbar">
        <div class="boot-search" aria-hidden="true"></div>
        <div class="boot-progress" aria-live="polite">
          <Transition name="notice">
            <div v-if="showLoading" class="loading-indicator" role="status">
              <div class="loading-track" aria-hidden="true"><span></span></div>
              <span>Loading your cards</span>
            </div>
          </Transition>
          <div v-if="startupError" class="startup-error" role="alert">
            <p>{{ startupError }}</p><button class="button" type="button" @click="reloadPage">Reload</button>
          </div>
        </div>
      </div>
      <div class="board boot-board" aria-hidden="true">
        <div v-for="index in 5" :key="index" class="column boot-column"><div class="column-header"></div><div class="boot-card"></div></div>
      </div>
    </section>

    <template v-else>
    <MobileDrawer
      :is-open="showMobileMenu"
      :active-workspace-title="workspaceLabel"
      :is-editing-board="isEditingBoard"
      :can-edit-board="isWorkspaceOwner"
      :entity-name="entityName"
      @close="closeMobileMenu"
      @open-workspaces="showWorkspaces = true"
      @open-board-settings="showBoardSettings = true"
      @toggle-board-edit="isEditingBoard = !isEditingBoard"
      @open-entity-settings="showEntitySettings = true"
      @open-sync="sync.open"
    />

    <TransitionGroup name="notice" tag="aside" class="notice-overlay" aria-live="polite" aria-atomic="true" @before-enter="showEnteringElement" @before-leave="hideLeavingElement">
      <div v-if="storageError && !showTaskForm" key="storage-error" role="alert" class="notice notice-error">
        <span>{{ storageError }}</span>
        <button type="button" class="notice-dismiss" aria-label="Dismiss storage notice" @click="storageError = ''">×</button>
      </div>
      <div v-if="notice" :key="notice" class="notice" role="status">
        <span>{{ notice }}</span>
        <button v-if="archiveUndo && (notice === 'Item archived' || notice.startsWith('Restore failed'))" type="button" class="notice-undo" :disabled="undoSaving" @click="undoArchive">{{ undoSaving ? 'Restoring…' : 'Undo' }}</button>
        <button type="button" class="notice-dismiss" aria-label="Dismiss notice" @click="notice = ''">×</button>
      </div>
    </TransitionGroup>

    <section class="toolbar" aria-label="Match controls">
      <label class="search-field">
        <span aria-hidden="true">⌕</span>
        <input v-model="search" type="search" aria-label="Search cards" :placeholder="isBlankBoard ? 'Search cards' : 'Search company, role, notes'" />
      </label>
      <div class="toolbar-spacer"></div>
      <LeadFilters v-model="filters" :columns="genericColumns" :fields="boardFields" />
      <div class="toolbar-meta">
        <SaveState :state="saveState" />
        <span class="stats">{{ hasFilters ? `${visibleTasks} of ${totalTasks} cards` : `${totalTasks} ${totalTasks === 1 ? 'card' : 'cards'}` }} · {{ totalDocuments }} {{ totalDocuments === 1 ? 'doc' : 'docs' }}</span>
      </div>
    </section>

    <div v-if="hasFilters" class="filter-summary" aria-live="polite">
      <span>{{ visibleTasks ? 'Showing matching cards' : 'No matching cards' }}</span>
      <button class="button button-small button-quiet" type="button" @click="clearFilters">Clear search and filters</button>
    </div>

    <nav v-if="visibleColumns.length > 1" class="mobile-column-switcher" aria-label="Board columns">
      <button class="button button-small button-quiet" type="button" aria-label="Previous column" :disabled="activeMobileColumnIndex === 0" @click="moveMobileColumn(-1)">←</button>
      <span aria-live="polite">{{ visibleColumns[activeMobileColumnIndex]?.title }}</span>
      <button class="button button-small button-quiet" type="button" aria-label="Next column" :disabled="activeMobileColumnIndex === visibleColumns.length - 1" @click="moveMobileColumn(1)">→</button>
    </nav>

    <section :key="boardRenderKey" ref="boardRef" class="board" :class="{ 'board-editing': isEditingBoard, 'board-bin-open': isArchiveOpen || hasFilters, 'board-filtered': hasFilters, 'board-single-column': visibleColumns.length === 1 }" role="region" :aria-label="activeWorkspace.title" @scroll.passive="updateMobileColumnIndex">
      <article
        v-for="column in visibleColumns"
        :key="column.id"
        class="column"
        :data-column-id="column.id"
        role="region"
        :aria-label="column.title"
        :class="[columnStatus(column.id) ? `column-${columnStatus(column.id)}` : '', { 'bin-column': isArchiveColumn(column), 'bin-column-open': isArchiveColumn(column) && (isArchiveOpen || hasFilters), 'column-moved': movedColumnId === column.id }]"
      >
        <button v-if="isArchiveColumn(column) && !isArchiveOpen && !hasFilters" class="bin-closed" type="button" :aria-label="`Open ${column.title} with ${tasksForColumn(column).length} cards`" @click="isArchiveOpen = true"><span class="bin-icon" aria-hidden="true"></span><strong>{{ column.title }}</strong><small>{{ tasksForColumn(column).length }}</small></button>
        <template v-else>
          <header class="column-header" :class="{ 'column-drag-handle': isEditingBoard }">
            <div class="column-title"><span class="column-dot"></span><h2 :title="isEditingBoard ? 'Double-click to edit column' : undefined" @dblclick="isEditingBoard && (editingColumn = column)">{{ column.title }}</h2></div>
            <div class="column-actions"><span class="count">{{ tasksForColumn(column).length }}</span><button v-if="isArchiveColumn(column) && !hasFilters" class="bin-close" type="button" :aria-label="`Collapse ${column.title}`" @click="isArchiveOpen = false">×</button><button v-if="isEditingBoard" class="button button-small button-quiet" type="button" aria-label="Edit column" @click="editingColumn = column">Edit</button></div>
          </header>
          <div class="card-stack" :data-column-id="column.id">
            <button v-for="task in tasksForColumn(column)" :key="task.id" class="lead-card task-card" :class="{ 'card-moved': movedTaskId === task.id }" :data-task-id="task.id" type="button" :aria-label="`Open ${task.title}`" @click="openBoardTask(task)">
              <div class="card-main">
              <template v-if="leadForTask(task)">
                <div class="card-head"><span class="company">{{ leadForTask(task)?.company }}</span><span v-if="leadForTask(task)?.priority" class="priority" :class="leadForTask(task)?.priority">{{ leadForTask(task)?.priority?.toUpperCase() }}</span></div>
                <strong>{{ leadForTask(task)?.role }}</strong>
                <div class="card-meta"><span v-if="leadForTask(task)?.location">{{ leadForTask(task)?.location }}</span><span v-if="leadForTask(task)?.fitScore !== undefined" class="fit">{{ leadForTask(task)?.fitScore }}/10 fit</span></div>
              </template>
              <template v-else><strong>{{ task.title }}</strong><p v-if="task.body && !hasFilters" class="task-card-body">{{ task.body }}</p></template>
              </div>
              <div v-if="hasFilters && (cardNotes(task) || cardFields(task).length)" class="card-context">
                <p v-if="cardNotes(task)" class="card-notes">{{ cardNotes(task) }}</p>
                <dl v-if="cardFields(task).length" class="card-fields">
                  <div v-for="field in cardFields(task)" :key="field.id"><dt>{{ field.title }}</dt><dd>{{ field.value }}</dd></div>
                </dl>
              </div>
            </button>
            <div v-if="!tasksForColumn(column).length" class="empty-column">{{ hasFilters ? 'No matches in this column' : `No ${entityName}s` }}</div>
          </div>
          <button v-if="!isEditingBoard && canEditItems" class="column-add-button" type="button" :aria-label="`Add ${entityName} to ${column.title}`" @click="openAddItem(column.id)">{{ addItemLabel }}</button>
        </template>
      </article>
      <div v-if="hasFilters && !visibleColumns.length" class="board-empty">Try another search or clear filters to see all cards.</div>
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
      @rename="handleRenameWorkspace"
      @delete="handleDeleteWorkspace"
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
      :read-only="!isWorkspaceOwner"
      :board="activeBoard"
      :columns="genericColumns"
      :fields="boardFields"
      :templates="workspace.templates"
      :heads="currentDocHeads"
      mode="templates"
      @close="showBoardSettings = false"
      @save-template="handleSaveTemplate"
      @apply-workspace-settings="handleApplyWorkspaceSettings"
    >
      <template #profile>
        <WorkspaceNameSettings :name="chat.ownName.value" :display-name="chat.displayName.value" :saving="chat.savingName.value" :error="chat.nameError.value"
          @save="chat.rename" @randomize="chat.randomize" />
        <section class="chat-members" aria-label="Known workspace participants">
          <h3>Participants</h3>
          <p>{{ isWorkspaceOwner ? 'Trusted devices and current connection state.' : 'Participants known to this device.' }}</p>
          <ul><li v-for="member in chat.members.value" :key="member.personId"><strong>{{ member.name }}</strong><span>{{ member.personId === currentWorkspaceOwnerId ? "Owner" : member.personId === chat.personId.value ? currentRole : meshParticipantDevices.find(peer => peer.personId === member.personId)?.role ?? "Member" }}{{ member.personId === chat.personId.value ? ' · You' : '' }}</span></li></ul>
          <template v-if="isWorkspaceOwner && meshParticipantDevices.length">
            <h4>Trusted peer devices</h4>
            <ul>
              <li v-for="peer in meshParticipantDevices" :key="peer.deviceId" class="peer-device-row">
                <span><strong>{{ peer.name }}</strong><small>{{ peer.online ? 'Online' : 'Offline' }} · {{ peer.role }}</small></span>
                <button v-if="!peer.revokedAt" class="button button-danger" type="button" :disabled="Boolean(revokingPeer)"
                  @click="revokeWorkspacePeer(peer.personId)">Remove access</button>
                <span v-else>Revoked</span>
              </li>
            </ul>
          </template>
          <p v-if="peerAccessError" class="form-error" role="alert">{{ peerAccessError }}</p>
        </section>
      </template>
    </SchemaEditorDialog>

    <WorkspaceChat v-if="chat.open.value" :key="activeWorkspace.id" :workspace-title="activeWorkspace.title"
      :read-only="!canEditItems"
      :messages="chat.messages.value" :current-person-id="chat.personId.value" :sending="chat.sending.value"
      :error="chat.error.value" :loading="chat.loading.value" :connected="sync.isWorkspaceLive(activeWorkspace.id)"
      :typing-people="chat.typingPeople.value"
      @close="chat.open.value = false" @send="chat.send" @typing="chat.setTyping" />
    <aside v-if="chat.toast.value" class="chat-toast" role="status">
      <button class="button button-quiet" type="button" @click="chat.open.value = true">{{ chat.toast.value.text }}</button>
      <button class="icon-button" type="button" aria-label="Dismiss chat notification" @click="chat.toast.value = null">×</button>
    </aside>

    <SchemaEditorDialog
      v-if="showEntitySettings && activeBoard && getActiveDoc()"
      :doc="getActiveDoc()!"
      :read-only="!isWorkspaceOwner"
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
      :read-only="!canEditItems"
      :subtasks="subtasksForSelectedTask"
      :fields="boardFields"
      :history="selectedTaskHistory"
      :archive-error="archiveError"
      :restore-saving="historyRestoreSaving"
      :restore-error="historyRestoreError"
      :restore-notice="historyRestoreNotice"
      @close="selectedTaskId = null; historyRestoreError = ''; historyRestoreNotice = ''"
      @add-subtask="handleAddSubtask"
      @start-move="handleStartMove"
      @delete-task="handleDeleteTask"
      @restore-version="restoreSelectedTaskVersion"
    />

    <TaskFormDialog
      v-if="showTaskForm"
      :parent-id="taskFormParentId"
      :fields="boardFields"
      :columns="genericColumns"
      :error-message="taskFormError"
      :saving="savingItem"
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
      :pending-joins="sync.pendingJoins.value"
      @decide-join="sync.decideJoin"
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
      :mesh-members="meshMembers"
      :has-mesh="meshMembers.length > 0"
      :current-person-id="chat.personId.value"
      :current-role="currentRole"
      :succession="activeSuccession"
      :can-claim-succession="canClaimSuccession"
      :can-manage-mesh="isWorkspaceOwner"
      :transferring-ownership="transferringOwnership"
      :mesh-action-error="peerAccessError"
      :workspace-connected="meshPresence === 'connected'"
      :mesh-diagnostic="sync.meshDiagnostic.value"
      :live="sync.isLive.value"
      @update:selected-workspace-ids="sync.selectedWorkspaceIds.value = $event"
      @update:selected-workspace-id="sync.selectedWorkspaceId.value = $event"
      @select-sync-all="sync.selectSyncAll"
      @select-sync-workspace="sync.selectSyncWorkspace"
      @generate-workspace-invite="sync.generateWorkspaceInvite"
      @transfer-ownership="transferWorkspaceOwnership"
      @leave-mesh="leaveWorkspaceMesh"
      @set-successor="setWorkspaceSuccessor"
      @vote-successor="voteForWorkspaceSuccessor"
      @claim-succession="claimWorkspaceSuccession"
      @request-enrollment="sync.requestEnrollment"
      :enrollment-device-name="sync.enrollmentDeviceName.value"
      @approve-device="sync.approveEnrollment"
      @decline-device="sync.declineEnrollment"
      @accept-and-join="sync.acceptWorkspaceJoin"
      @copy="sync.copyInvite"
      @export="exportWorkspace"
      @import="openImport"
      @dismiss="sync.dismiss"
      @stop="sync.close"
    />

    <ModalLayer protect-draft :busy="savingItem" v-if="showLeadForm" class="overlay" @close="showLeadForm = false">
      <form class="dialog" role="dialog" aria-modal="true" aria-label="Add item" :aria-busy="savingItem" @submit.prevent="submitLead">
        <div class="dialog-head"><div><span class="eyebrow">New item</span><h2>Add item</h2></div><button class="icon-button" type="button" aria-label="Close" :disabled="savingItem" @click="showLeadForm = false">×</button></div>
        <fieldset class="form-grid" :disabled="savingItem">
          <label><span>Company *</span><input v-model="newLead.company" autofocus required /></label>
          <label><span>Role *</span><input v-model="newLead.role" required /></label>
          <label class="wide"><span>Job URL</span><input v-model="newLead.url" type="url" placeholder="https://" /></label>
          <label><span>Location</span><input v-model="newLead.location" /></label>
          <label><span>Work mode</span><select v-model="newLead.workMode"><option value="remote">Remote</option><option value="hybrid">Hybrid</option><option value="onsite">On-site</option><option value="unknown">Unknown</option></select></label>
          <label><span>Status</span><select v-model="newLead.status"><option v-for="(label, status) in statusLabels" :key="status" :value="status">{{ label }}</option></select></label>
          <p v-if="automaticPriorityEnabled" class="wide computed-priority-note">Priority and fit are calculated from workspace preferences.</p>
          <template v-else>
            <label><span>Priority</span><select v-model="newLead.priority"><option v-for="(label, priority) in priorityLabels" :key="priority" :value="priority">{{ label }}</option></select></label>
            <label><span>Fit score</span><input v-model.number="newLead.fitScore" type="number" min="0" max="10" placeholder="0–10" /></label>
          </template>
          <label class="wide"><span>Notes</span><textarea v-model="newLead.notes" rows="3" placeholder="Why this matters, gaps, next move…"></textarea></label>
          <label class="wide"><span>Source snapshot</span><textarea v-model="newLead.sourceText" rows="4" placeholder="Paste description if useful for later tailoring…"></textarea></label>
          <label v-if="newLead.status === 'rejected'" class="wide"><span>Rejection notes / retrospective</span><textarea v-model="newLead.rejectionReason" rows="3" placeholder="Optional retrospective note on what went wrong…"></textarea></label>
        </fieldset>
        <p v-if="leadFormError" class="form-error form-error-spaced" role="alert">{{ leadFormError }}</p>
        <div class="dialog-actions"><button class="button button-quiet" type="button" :disabled="savingItem" @click="showLeadForm = false">Cancel</button><button class="button button-primary" type="submit" :disabled="savingItem">{{ showItemSaving ? 'Saving…' : leadFormError ? 'Retry save' : 'Create item' }}</button></div>
      </form>
    </ModalLayer>

    <ModalLayer v-if="selectedLead" class="overlay detail-overlay" @close="closeDetail">
      <section ref="detailDialog" class="dialog detail-dialog" role="dialog" aria-modal="true" aria-label="Lead details" tabindex="-1" @keydown.esc="closeDetail">
        <div class="detail-head"><div><span class="eyebrow">Lead card</span><h2>{{ selectedLead.company }}</h2><p>{{ selectedLead.role }}</p></div><button class="icon-button" type="button" aria-label="Close detail" @click="closeDetail">×</button></div>
      <div class="status-strip"><button v-for="(label, status) in statusLabels" :key="status" :disabled="!canEditItems" type="button" :class="{ active: selectedLead.status === status }" @click="setStatus(status)">{{ label }}</button></div>
      <p v-if="archiveError" class="form-error" role="alert">{{ archiveError }}</p>
      <button v-if="archiveUndo && archiveUndo.workspaceId === activeWorkspace.id" class="button button-small" type="button" :disabled="undoSaving" @click="undoArchive">{{ undoSaving ? 'Restoring…' : 'Undo archive' }}</button>
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
            class="rejection-note-textarea" :readonly="!canEditItems"
            :value="selectedLead.rejectionReason ?? ''"
            placeholder="Optional rejection reason or retrospective note (what went wrong)…"
            rows="3"
            aria-label="Rejection notes"
            @input="handleUpdateRejectionReason(($event.target as HTMLTextAreaElement).value)"
          ></textarea>
        </section>
        <section class="detail-section artifacts-section"><div class="section-heading"><div><span class="detail-label">PDF artifacts</span><h3>{{ selectedArtifacts.length ? `${selectedArtifacts.length} attached` : "No generated PDFs" }}</h3></div><button class="button button-small" type="button" :disabled="!canEditItems" @click="showArtifactForm ? showArtifactForm = false : openArtifactForm()">+ PDF</button></div>
          <form v-if="showArtifactForm" class="document-form" novalidate @submit.prevent="submitArtifact"><label><span>Kind</span><select v-model="artifactDraft.kind" @change="artifactDraft.templateId = ''"><option v-for="(label, kind) in artifactKindLabels" :key="kind" :value="kind">{{ label }}</option></select></label><label><span>Title</span><input v-model="artifactDraft.title" placeholder="Cleo CV" /></label><label><span>Base template</span><select v-model="artifactDraft.templateId"><option value="">Select template</option><option v-for="template in availableArtifactTemplates" :key="template.id" :value="template.id">{{ template.name }}</option></select></label><label><span>PDF path</span><input v-model="artifactDraft.pdfPath" placeholder="/Users/…/cleo-cv.pdf" /></label><label><span>Generated Markdown path</span><input v-model="artifactDraft.sourceMarkdownPath" placeholder="/Users/…/cleo-cv.md" /></label><p v-if="artifactError" class="form-error" role="alert">{{ artifactError }}</p><button class="button button-primary" type="submit">Attach PDF</button></form>
          <div v-for="artifact in selectedArtifacts" :key="artifact.id" class="document-row"><span class="document-icon">{{ artifact.kind === "cv" ? "CV" : "CL" }}</span><div><strong>{{ artifact.title }}</strong><span>{{ artifactKindLabels[artifact.kind] }} · from template</span></div><a :href="`file://${artifact.pdfPath}`" class="open-path" title="Open PDF">Open PDF</a></div>
        </section>

        <section class="detail-section documents-section"><div class="section-heading"><div><span class="detail-label">Notes & files</span><h3>{{ selectedDocuments.length ? `${selectedDocuments.length} attached` : "Nothing attached" }}</h3></div><button class="button button-small" type="button" :disabled="!canEditItems" @click="showDocumentForm = !showDocumentForm">+ Document</button></div>
          <form v-if="showDocumentForm" class="document-form" @submit.prevent="submitDocument"><label><span>Kind</span><select v-model="newDocument.kind"><option value="note">Note</option><option value="attachment">Attachment</option></select></label><label><span>Title</span><input v-model="newDocument.title" required /></label><label><span>Format</span><select v-model="newDocument.format"><option value="markdown">Markdown</option><option value="html">HTML</option><option value="path">Local path</option></select></label><label v-if="newDocument.format === 'path'"><span>Path</span><input v-model="newDocument.localPath" placeholder="/Users/…" /></label><label v-else><span>Content</span><textarea v-model="newDocument.content" rows="5" placeholder="Paste note…"></textarea></label><button class="button button-primary" type="submit">Attach</button></form>
          <div v-for="document in selectedDocuments" :key="document.id" class="document-row"><span class="document-icon">{{ document.kind === "cv" ? "CV" : document.kind === "cover_letter" ? "CL" : "↗" }}</span><div><strong>{{ document.title }}</strong><span>{{ documentKindLabels[document.kind] }} · {{ document.format }}</span></div><a v-if="document.localPath" :href="`file://${document.localPath}`" class="open-path" title="Open local file">Open</a></div>
        </section>
      </div>
      </section>
    </ModalLayer>
    </template>
  </main>
</template>
