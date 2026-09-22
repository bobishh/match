import { computed, ref, watch } from "vue"
import * as Automerge from "@automerge/automerge/slim"
import { workspaceRole, effectiveWorkspaceOwner, exportAuthorizations, workspaceWritesBlocked } from "../sync/changeAuthorization"
import { canWorkspace, type WorkspaceRole } from "../domain/permissions"
import { bootstrapIdentity } from "../domain/identity"
import { useMatch } from "../state"
import type { ArtifactKind } from "../types"
import { type Column, type Item, type WorkspaceDocumentV2 } from "../domain/model"
import { configureChat, exportChat, receiveChat, subscribeChat } from "../chat/service"
import { useWorkspaceChat } from "../chat/useWorkspaceChat"
import { defaultBoardFilters, type BoardFilters } from "../filters"
import { useDeviceSync } from "../sync/useDeviceSync"
import { useAppMesh } from "./useAppMesh"
import { blobDescriptor, configureAttachmentFetcher, readStoredAttachment, writeStoredAttachment } from "../attachments"

type ArchiveUndo =
  | { workspaceId: string; itemId: string; title: string; action: "restore" }
  | { workspaceId: string; itemId: string; title: string; action: "move"; parentId: string; beforeId: string | null }

export function useAppCore() {
  const match = useMatch()
  const ui = useAppUiState()
  const collaboration = useAppCollaboration(match, ui)
  const drafts = useAppDrafts()
  return { match, ...ui, ...collaboration, ...drafts }
}

function useAppUiState() {
  const selectedLeadId = ref<string | null>(null)
  const detailDialog = ref<HTMLElement | null>(null)
  const importInput = ref<HTMLInputElement | null>(null)
  const showArtifactForm = ref(false)
  const search = ref("")
  const filters = ref<BoardFilters>(defaultBoardFilters())
  const notice = ref("")
  const archiveUndo = ref<ArchiveUndo | null>(null)
  const undoSaving = ref(false)
  const archiveError = ref("")
  const historyRestoreSaving = ref(false)
  const historyRestoreError = ref("")
  const historyRestoreNotice = ref("")
  const isArchiveOpen = ref(false)
  const artifactError = ref("")
  const showWorkspaces = ref(false)
  const showBoardSettings = ref(false)
  const showEntitySettings = ref(false)
  const isEditingBoard = ref(false)
  const newBoardColumnTitle = ref("")
  const boardRef = ref<HTMLElement | null>(null)
  const boardRenderKey = ref(0)
  const movedItemId = ref<string | null>(null)
  const movedColumnId = ref<string | null>(null)
  const activeMobileColumnIndex = ref(0)
  const showItemForm = ref(false)
  const itemFormParentId = ref("")
  const itemFormError = ref("")
  const savingItem = ref(false)
  const editingColumn = ref<Column | null>(null)
  const selectedItemId = ref<string | null>(null)
  const editingItemId = ref<string | null>(null)
  const itemToMove = ref<Item | null>(null)
  const showMoveDialog = ref(false)
  const storageError = ref("")
  const quickNoteDraft = ref("")
  const quickNoteSaving = ref(false)
  const quickNoteError = ref("")
  const hasExperimentalMcp = ref(false)
  const showMobileMenu = ref(false)
  const menuButtonRef = ref<HTMLButtonElement | null>(null)
  const showLoading = ref(false)
  const startupError = ref("")
  const toggleMobileMenu = () => { showMobileMenu.value = !showMobileMenu.value }
  const closeMobileMenu = () => { showMobileMenu.value = false }
  return {
    selectedLeadId, detailDialog, importInput, showArtifactForm, search, filters, notice,
    archiveUndo, undoSaving, archiveError, historyRestoreSaving, historyRestoreError, historyRestoreNotice,
    isArchiveOpen, artifactError, showWorkspaces, showBoardSettings, showEntitySettings, isEditingBoard,
    newBoardColumnTitle, boardRef, boardRenderKey, movedItemId, movedColumnId, activeMobileColumnIndex,
    showItemForm, itemFormParentId, itemFormError, savingItem, editingColumn, selectedItemId, editingItemId,
    itemToMove, showMoveDialog, storageError, quickNoteDraft, quickNoteSaving, quickNoteError,
    hasExperimentalMcp, showMobileMenu, menuButtonRef, showLoading, startupError, toggleMobileMenu, closeMobileMenu,
  }
}

function useAppDrafts() {
  const artifactDraft = ref({ kind: "cv" as ArtifactKind, title: "", templateId: "", pdfPath: "", sourceMarkdownPath: "" })
  return { artifactDraft }
}

function useAppCollaboration(match: ReturnType<typeof useMatch>, ui: ReturnType<typeof useAppUiState>) {
  configureChat(
    async id => Automerge.load<WorkspaceDocumentV2>(await match.readWorkspaceBytes(id)).ownerPersonId,
    async id => chatRoomId(match.readWorkspaceBytes, id),
  )
  const chatWorkspaceId = computed(() => match.ready.value ? match.activeWorkspace.id : "")
  const chatOwnerId = computed(() => { void match.docVersion.value; return match.getActiveDoc()?.ownerPersonId ?? "" })
  const chat = useWorkspaceChat(chatWorkspaceId, chatOwnerId)
  const sync = useDeviceSync({
    displayName: () => chat.displayName.value,
    identityChanged: match.refreshIdentity,
    workspace: { subscribe: listener => subscribeWorkspaceAndChat(match.subscribeLocalChanges, listener) },
    workspaceStore: {
      read: match.readWorkspaceBytes,
      merge: match.mergeAuthorizedWorkspace,
      readAuthorization: exportAuthorizations,
      activate: match.switchWorkspace,
      readChat: exportChat,
      mergeChat: receiveChat,
      blob: {
        resolve: (workspaceId, blobId) => resolveWorkspaceBlob(match.readWorkspaceBytes, workspaceId, blobId),
        read: readStoredAttachment,
        write: writeStoredAttachment,
      },
    },
    origin: () => window.location.origin,
    availableWorkspaces: match.availableWorkspaces,
    activeWorkspaceId: () => match.activeWorkspace.id || "default",
    workspaceOwner: id => resolveWorkspaceOwner(match.readWorkspaceBytes, id),
  })
  configureAttachmentFetcher(descriptor => sync.fetchBlob(match.activeWorkspace.id, descriptor))
  const policy = useWorkspacePolicy(match, ui, sync)
  const mesh = useAppMesh({ activeWorkspace: match.activeWorkspace, chat, sync, mergeAuthorizedWorkspace: match.mergeAuthorizedWorkspace, ...policy })
  return { chat, sync, ...policy, ...mesh }
}

async function resolveWorkspaceBlob(
  readWorkspaceBytes: ReturnType<typeof useMatch>["readWorkspaceBytes"],
  workspaceId: string,
  blobId: string,
) {
  const doc = Automerge.load<WorkspaceDocumentV2>(await readWorkspaceBytes(workspaceId))
  for (const entity of Object.values(doc.entities)) {
    const references = entity.kind === "document"
      ? [entity.file]
      : entity.kind === "artifact"
        ? [entity.pdf, entity.sourceMarkdown]
        : []
    for (const reference of references) {
      if (!reference) continue
      const descriptor = blobDescriptor(reference)
      if (descriptor?.blobId === blobId) return descriptor
    }
  }
  return undefined
}

async function chatRoomId(readWorkspaceBytes: ReturnType<typeof useMatch>["readWorkspaceBytes"], id: string) {
  const doc = Automerge.load<WorkspaceDocumentV2>(await readWorkspaceBytes(id))
  const board = Object.values(doc.entities).find(entity => entity.kind === "board")
  if (!board) throw new Error("Workspace has no board")
  return `${doc.ownerPersonId}:${board.id}`
}

function subscribeWorkspaceAndChat(subscribeLocalChanges: ReturnType<typeof useMatch>["subscribeLocalChanges"], listener: () => void) {
  const stopWorkspace = subscribeLocalChanges(listener)
  const stopChat = subscribeChat(listener)
  return () => { stopWorkspace(); stopChat() }
}

async function resolveWorkspaceOwner(readWorkspaceBytes: ReturnType<typeof useMatch>["readWorkspaceBytes"], id: string) {
  const doc = Automerge.load<WorkspaceDocumentV2>(await readWorkspaceBytes(id))
  await workspaceRole(doc, await bootstrapIdentity("My Device"))
  return effectiveWorkspaceOwner(id, doc.ownerPersonId)
}

function useWorkspacePolicy(match: ReturnType<typeof useMatch>, ui: ReturnType<typeof useAppUiState>, sync: ReturnType<typeof useDeviceSync>) {
  const currentRole = ref<WorkspaceRole>("visitor")
  const roleWorkspaceId = ref("")
  const currentWorkspaceOwnerId = ref("")
  const workspaceAccess = ref<Record<string, { role: WorkspaceRole; blocked: boolean }>>({})
  watch([() => match.activeWorkspace.id, () => match.availableWorkspaces.value.map(item => item.id).join("|"), match.docVersion, match.ready, sync.ownershipRevision], async (_, __, onCleanup) => {
    let cancelled = false
    onCleanup(() => { cancelled = true })
    const doc = match.getActiveDoc()
    if (!doc) return
    const result = await loadWorkspaceAccess(match, doc)
    if (!cancelled && match.activeWorkspace.id === doc.id) {
      currentRole.value = result.role
      currentWorkspaceOwnerId.value = result.ownerId
      roleWorkspaceId.value = doc.id
      workspaceAccess.value = result.access
    }
  }, { immediate: true })
  const activePolicyAvailable = computed(() => roleWorkspaceId.value === match.activeWorkspace.id && workspaceAccess.value[match.activeWorkspace.id]?.blocked !== true && !sync.isWorkspaceAccessRevoked(match.activeWorkspace.id) && !sync.meshSuccession.value.find(item => item.workspaceId === match.activeWorkspace.id)?.conflicted)
  const allowed = (permission: Parameters<typeof canWorkspace>[1]) => computed(() => activePolicyAvailable.value && canWorkspace(currentRole.value, permission))
  const canEditItems = allowed("content.write")
  const canEditBoard = allowed("board.configure")
  const canManageAccess = allowed("access.manage")
  const canImportWorkspace = allowed("workspace.import")
  const canRepairHistory = allowed("history.repair")
  const canRenameWorkspace = (id: string) => {
    const access = workspaceAccess.value[id]
    return Boolean(access && !access.blocked && canWorkspace(access.role, "workspace.rename"))
  }
  watch(canEditBoard, allowed => { if (!allowed) { ui.isEditingBoard.value = false; ui.editingColumn.value = null; ui.showEntitySettings.value = false } })
  watch(canEditItems, allowed => { if (!allowed) closeRestrictedEditors(ui) })
  return { currentRole, currentWorkspaceOwnerId, workspaceAccess, canEditItems, canEditBoard, canManageAccess, canImportWorkspace, canRepairHistory, canRenameWorkspace }
}

async function loadWorkspaceAccess(match: ReturnType<typeof useMatch>, doc: WorkspaceDocumentV2) {
  const profile = await bootstrapIdentity("My Device")
  const [role, ownerId, entries] = await Promise.all([
    workspaceRole(doc, profile), effectiveWorkspaceOwner(doc.id, doc.ownerPersonId),
    Promise.all(match.availableWorkspaces.value.map(async item => [item.id, { role: await match.getWorkspaceRole(item.id), blocked: await workspaceWritesBlocked(item.id) }] as const)),
  ])
  return { role, ownerId, access: Object.fromEntries(entries) }
}

function closeRestrictedEditors(ui: ReturnType<typeof useAppUiState>) {
  ui.showItemForm.value = false
  ui.editingItemId.value = null
  ui.showArtifactForm.value = false
  ui.showMoveDialog.value = false
  ui.itemToMove.value = null
}
