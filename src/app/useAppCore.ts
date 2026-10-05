import { computed, ref, watch } from "vue"
import { workspaceRole, effectiveWorkspaceOwner, exportAuthorizationBundle, exportDocumentAuthorizationBundle, workspaceWritesBlocked } from "../sync/changeAuthorization"
import { canWorkspace, type WorkspaceRole } from "../domain/permissions"
import { bootstrapIdentity } from "../domain/identity"
import { useMatch } from "../state"
import type { ArtifactKind } from "../types"
import { type Column, type Item, type WorkspaceDocumentV2 } from "../domain/model"
import { configureChat, exportChat, receiveChat, subscribeChat } from "../chat/service"
import type { WorkspaceAccessResult } from "./workspaceAccessState"
import { refreshWorkspaceAccess } from "./workspaceAccessRefresh"
import type { AppStartupStage } from "./startup"
import { useWorkspaceChat } from "../chat/useWorkspaceChat"
import { defaultBoardFilters, type BoardFilters } from "../filters"
import { useDeviceSync } from "../sync/useDeviceSync"
import { meshTrace } from "../sync/meshTrace"
import { useAppMesh } from "./useAppMesh"
import { configureAttachmentFetcher, readStoredAttachment, writeStoredAttachment } from "../attachments"
import { workspaceBlobDescriptor, workspaceChatRoomId } from "./workspaceMetadata"

type ArchiveUndo = { workspaceId: string; itemId: string; title: string }

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
  const startupError = ref<{ stage: AppStartupStage; message: string; detail: string } | null>(null)
  const toggleMobileMenu = () => { showMobileMenu.value = !showMobileMenu.value }
  const closeMobileMenu = () => { showMobileMenu.value = false }
  return {
    selectedLeadId, detailDialog, importInput, showArtifactForm, search, filters, notice,
    archiveUndo, undoSaving, archiveError, historyRestoreSaving, historyRestoreError, historyRestoreNotice,
    isArchiveOpen, artifactError, showWorkspaces, showEntitySettings, isEditingBoard,
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
    async id => (await match.readWorkspaceDoc(id)).ownerPersonId,
    async id => workspaceChatRoomId(await match.readWorkspaceDoc(id)),
  )
  const chatWorkspaceId = computed(() => match.ready.value ? match.activeWorkspace.id : "")
  const chatOwnerId = computed(() => { void match.docVersion.value; return match.getActiveDoc()?.ownerPersonId ?? "" })
  const identityName = computed(() => { void match.docVersion.value; return match.getCurrentProfile()?.identity.displayName ?? "" })
  const chat = useWorkspaceChat(chatWorkspaceId, chatOwnerId, identityName)
  const sync = useDeviceSync({
    displayName: () => identityName.value,
    identityChanged: match.refreshIdentity,
    workspace: {
      subscribe: listener => subscribeWorkspaceAndChat(match.subscribeLocalChanges, listener),
      subscribeWorkspace: listener => subscribeWorkspaceAndChatScoped(match.subscribeLocalChanges, listener),
    },
    workspaceStore: {
      read: id => timedWorkspaceStoreStage("read", id, () => match.readWorkspaceBytes(id)),
      validate: (id, bytes, authorization) => timedWorkspaceStoreStage("validate", id, async () => {
        await match.validateAuthorizedWorkspace(id, bytes, authorization)
      }),
      merge: (id, bytes, authorization) => timedWorkspaceStoreStage("merge", id, () =>
        match.mergeAuthorizedWorkspace(id, bytes, authorization)),
      readAuthorization: (bytes, id) => timedWorkspaceStoreStage("read-authorization", id ?? "unknown", () =>
        // Proofs and authority are read fresh; genesis ownership is already in the local document.
        id ? match.readWorkspaceDoc(id).then(doc => exportDocumentAuthorizationBundle(doc)) : exportAuthorizationBundle(bytes)),
      activate: match.switchWorkspace,
      readChat: exportChat,
      mergeChat: receiveChat,
      blob: {
        resolve: async (workspaceId, blobId) => workspaceBlobDescriptor(await match.readWorkspaceDoc(workspaceId), blobId),
        read: readStoredAttachment,
        write: writeStoredAttachment,
      },
    },
    origin: () => window.location.origin,
    availableWorkspaces: match.availableWorkspaces,
    activeWorkspaceId: () => match.activeWorkspace.id || "default",
    workspaceOwner: id => timedWorkspaceStoreStage("owner-check", id, () =>
      resolveWorkspaceOwner(match.readWorkspaceDoc, id)),
  })
  configureAttachmentFetcher(descriptor => sync.fetchBlob(match.activeWorkspace.id, descriptor))
  const policy = useWorkspacePolicy(match, ui, sync)
  const mesh = useAppMesh({ activeWorkspace: match.activeWorkspace, chat, sync, ...policy })
  return { chat, sync, ...policy, ...mesh }
}

function subscribeWorkspaceAndChat(subscribeLocalChanges: ReturnType<typeof useMatch>["subscribeLocalChanges"], listener: () => void) {
  const stopWorkspace = subscribeLocalChanges(listener)
  const stopChat = subscribeChat(listener)
  return () => { stopWorkspace(); stopChat() }
}

function subscribeWorkspaceAndChatScoped(
  subscribeLocalChanges: ReturnType<typeof useMatch>["subscribeLocalChanges"],
  listener: (workspaceId?: string) => void,
) {
  const stopWorkspace = subscribeLocalChanges(listener)
  const stopChat = subscribeChat(event => listener(event.workspaceId))
  return () => { stopWorkspace(); stopChat() }
}

async function timedWorkspaceStoreStage<T>(stage: string, workspaceId: string, operation: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try { return await operation() }
  finally {
    const elapsedMs = Math.round(performance.now() - started)
    if (elapsedMs >= 1_000) meshTrace("workspace.store.slow", {
      stage, workspaceId: workspaceId.slice(0, 8), elapsedMs,
    }, "warn")
  }
}

async function resolveWorkspaceOwner(readWorkspaceDoc: ReturnType<typeof useMatch>["readWorkspaceDoc"], id: string) {
  const doc = await readWorkspaceDoc(id)
  await workspaceRole(doc, await bootstrapIdentity("My Device"))
  return effectiveWorkspaceOwner(id, doc.ownerPersonId)
}

function useWorkspacePolicy(match: ReturnType<typeof useMatch>, ui: ReturnType<typeof useAppUiState>, sync: ReturnType<typeof useDeviceSync>) {
  const currentRole = ref<WorkspaceRole>("visitor")
  const roleWorkspaceId = ref("")
  const currentWorkspaceOwnerId = ref("")
  const workspaceAccess = ref<Record<string, WorkspaceAccessResult>>({})
  const workspaceAccessErrors = ref<string[]>([])
  const workspaceRoleStatus = computed(() => roleWorkspaceId.value !== match.activeWorkspace.id ? "loading" : workspaceAccess.value[match.activeWorkspace.id]?.error ? "unavailable" : "verified")
  const refreshAccess = async (includeOthers: boolean, onCleanup: (cleanup: () => void) => void) => {
    let cancelled = false
    onCleanup(() => { cancelled = true })
    const doc = match.getActiveDoc()
    if (!doc) return
    await refreshWorkspaceAccess({ workspaceId: doc.id, includeOthers, cancelled: () => cancelled,
      getActiveWorkspaceId: () => match.activeWorkspace.id, getDocVersion: () => match.docVersion.value,
      getWorkspaceIds: () => match.availableWorkspaces.value.map(item => item.id),
      load: (all, onActive) => loadWorkspaceAccess(match, doc, all, onActive),
      state: { currentRole, currentWorkspaceOwnerId, roleWorkspaceId, workspaceAccess, workspaceAccessErrors } })
  }
  const identityFingerprint = () => {
    void match.docVersion.value
    const profile = match.getCurrentProfile()
    return profile ? `${profile.identity.personId}|${profile.identity.publicKey}|${profile.device.deviceId}|${profile.certificate.signature}` : ""
  }
  watch([() => match.activeWorkspace.id, () => match.availableWorkspaces.value.map(item => item.id).join("|"), () => match.ready.value, sync.ownershipRevision, identityFingerprint],
    (_, __, onCleanup) => refreshAccess(true, onCleanup), { immediate: true })
  watch(match.docVersion, (_, __, onCleanup) => refreshAccess(false, onCleanup))
  const activePolicyAvailable = computed(() => roleWorkspaceId.value === match.activeWorkspace.id && workspaceAccess.value[match.activeWorkspace.id]?.blocked !== true && !sync.isWorkspaceAccessRevoked(match.activeWorkspace.id) && !sync.meshSuccession.value.find(item => item.workspaceId === match.activeWorkspace.id)?.conflicted)
  const allowed = (permission: Parameters<typeof canWorkspace>[1]) => computed(() => activePolicyAvailable.value && canWorkspace(currentRole.value, permission))
  const canEditItems = allowed("content.write")
  const canEditBoard = allowed("board.configure")
  const canManageAccess = allowed("access.manage")
  const canImportWorkspace = allowed("workspace.import")
  const keeperOwnedWorkspaces = computed(() => match.availableWorkspaces.value.filter(item => {
    const access = workspaceAccess.value[item.id]
    return access?.role === "owner" && !access.blocked && !access.error
  }))
  const canRenameWorkspace = (id: string) => {
    const access = workspaceAccess.value[id]
    return Boolean(access && !access.blocked && canWorkspace(access.role, "workspace.rename"))
  }
  watch(canEditBoard, allowed => { if (!allowed) { ui.isEditingBoard.value = false; ui.editingColumn.value = null; ui.showEntitySettings.value = false } })
  watch(canEditItems, allowed => { if (!allowed) closeRestrictedEditors(ui) })
  return { currentRole, currentWorkspaceOwnerId, workspaceAccess, workspaceAccessErrors, workspaceRoleStatus, keeperOwnedWorkspaces, canEditItems, canEditBoard, canManageAccess, canImportWorkspace, canRenameWorkspace }
}

async function loadWorkspaceAccess(match: ReturnType<typeof useMatch>, doc: WorkspaceDocumentV2, includeOthers = true,
  onActive?: (result: { role: WorkspaceRole; ownerId: string; access: Record<string, WorkspaceAccessResult> }) => void) {
  const profile = await bootstrapIdentity("My Device")
  const resolve = async (item: { id: string; title: string }) => {
    try {
      const role = item.id === doc.id ? await workspaceRole(doc, profile) : await match.getWorkspaceRole(item.id)
      return [item.id, { role, blocked: await workspaceWritesBlocked(item.id) }] as const
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      const error = `“${item.title}” (${item.id}): permissions could not be verified. ${detail}`
      return [item.id, { role: "visitor" as const, blocked: true, error }] as const
    }
  }
  const items = match.availableWorkspaces.value
  const activeItem = items.find(item => item.id === doc.id) ?? { id: doc.id, title: doc.title }
  const [activeId, activeRaw] = await resolve(activeItem)
  const active: WorkspaceAccessResult = activeRaw
  const ownerId = active?.error ? "" : await effectiveWorkspaceOwner(doc.id, doc.ownerPersonId)
  const initial = { role: active.role, ownerId, access: { [activeId]: active } }
  onActive?.(initial)
  const others = includeOthers ? await Promise.all(items.filter(item => item.id !== doc.id).map(resolve)) : []
  const access: Record<string, WorkspaceAccessResult> = Object.fromEntries([[activeId, active], ...others])
  return { ...initial, access }
}

function closeRestrictedEditors(ui: ReturnType<typeof useAppUiState>) {
  ui.showItemForm.value = false
  ui.editingItemId.value = null
  ui.showArtifactForm.value = false
  ui.showMoveDialog.value = false
  ui.itemToMove.value = null
}
