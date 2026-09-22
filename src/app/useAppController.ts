import { onBeforeUnmount, onMounted, watch } from "vue"
import { hydrate } from "../state"
import { registerWebMcp } from "../webmcp"
import { sendChatMessage } from "../chat/service"
import { runAppStartup, startupFailureMessage } from "./startup"
import { useAppActions } from "./useAppActions"
import { useAppBoard, type AppBoardContext } from "./useAppBoard"
import { useAppCore } from "./useAppCore"

export function useAppController() {
  const core = useAppCore()
  const board = useAppBoard(boardContext(core))
  const actions = useAppActions(core, board)
  useAppLifecycle(core, board, actions)
  return {
    workspace: core.match,
    ui: appUi(core),
    board,
    actions,
    collaboration: appCollaboration(core),
  }
}

function boardContext(core: ReturnType<typeof useAppCore>): AppBoardContext {
  const {
    match, search, filters, isEditingBoard, itemFormParentId, activeMobileColumnIndex,
    boardRef, movedItemId, movedColumnId, onlineWorkspaceDevices, canEditItems, canEditBoard,
    notice, archiveUndo, boardRenderKey, selectedItemId, editingItemId, itemToMove,
    selectedLeadId, detailDialog, quickNoteDraft, quickNoteError,
  } = core
  return {
    match, search, filters, isEditingBoard, itemFormParentId, activeMobileColumnIndex,
    boardRef, movedItemId, movedColumnId, onlineWorkspaceDevices, canEditItems, canEditBoard,
    notice, archiveUndo, boardRenderKey, selectedItemId, editingItemId, itemToMove,
    selectedLeadId, detailDialog, quickNoteDraft, quickNoteError,
  }
}

function appUi(core: ReturnType<typeof useAppCore>) {
  const {
    detailDialog, importInput, showArtifactForm, search, filters, notice, archiveUndo, undoSaving,
    archiveError, historyRestoreSaving, historyRestoreError, historyRestoreNotice, isArchiveOpen,
    artifactError, showWorkspaces, showBoardSettings, showEntitySettings, isEditingBoard,
    newBoardColumnTitle, boardRef, boardRenderKey, movedItemId, movedColumnId,
    activeMobileColumnIndex, showItemForm, itemFormError, savingItem, editingColumn,
    selectedItemId, editingItemId, itemToMove, showMoveDialog, storageError, quickNoteDraft,
    quickNoteSaving, quickNoteError, hasExperimentalMcp, showMobileMenu, menuButtonRef,
    showLoading, startupError, artifactDraft,
  } = core
  return { state: {
    detailDialog, importInput, showArtifactForm, search, filters, notice, archiveUndo, undoSaving,
    archiveError, historyRestoreSaving, historyRestoreError, historyRestoreNotice, isArchiveOpen,
    artifactError, showWorkspaces, showBoardSettings, showEntitySettings, isEditingBoard,
    newBoardColumnTitle, boardRef, boardRenderKey, movedItemId, movedColumnId,
    activeMobileColumnIndex, showItemForm, itemFormError, savingItem, editingColumn,
    selectedItemId, editingItemId, itemToMove, showMoveDialog, storageError, quickNoteDraft,
    quickNoteSaving, quickNoteError, hasExperimentalMcp, showMobileMenu, menuButtonRef,
    showLoading, startupError, artifactDraft,
  }, controls: { toggleMobileMenu: core.toggleMobileMenu, closeMobileMenu: core.closeMobileMenu } }
}

function appCollaboration(core: ReturnType<typeof useAppCore>) {
  const {
    sync, chat, currentRole, currentWorkspaceOwnerId, canEditItems, canEditBoard, canManageAccess,
    canImportWorkspace, canRenameWorkspace, meshPresence, meshPresenceLabel, activeMeshRetryAt,
    meshMembers, meshParticipantDevices, activeSuccession, canClaimSuccession,
    canBreakGlassOwnership, transferringOwnership, revokingPeer, peerAccessError,
    repairableHistory, repairHistory, transferWorkspaceOwnership, leaveWorkspaceMesh,
    setWorkspaceSuccessor, voteForWorkspaceSuccessor, claimWorkspaceSuccession,
    breakGlassWorkspaceOwnership, revokeWorkspacePeer,
  } = core
  return {
    device: { sync, chat },
    permissions: { currentRole, currentWorkspaceOwnerId, canEditItems, canEditBoard, canManageAccess, canImportWorkspace, canRenameWorkspace },
    mesh: {
      meshPresence, meshPresenceLabel, activeMeshRetryAt, meshMembers, meshParticipantDevices,
      activeSuccession, canClaimSuccession, canBreakGlassOwnership, transferringOwnership,
      revokingPeer, peerAccessError, repairableHistory, repairHistory, transferWorkspaceOwnership,
      leaveWorkspaceMesh, setWorkspaceSuccessor, voteForWorkspaceSuccessor,
      claimWorkspaceSuccession, breakGlassWorkspaceOwnership, revokeWorkspacePeer,
    },
  }
}

function useAppLifecycle(core: ReturnType<typeof useAppCore>, board: ReturnType<typeof useAppBoard>, actions: ReturnType<typeof useAppActions>) {
  let loadingTimer: ReturnType<typeof setTimeout> | undefined
  onMounted(async () => {
    loadingTimer = setTimeout(() => { core.showLoading.value = true }, 200)
    const startup = await runAppStartup({
      loadRuntime: async () => {
        const { initializeIrohBrowserRuntime } = await import("../iroh")
        await initializeIrohBrowserRuntime()
      },
      hydrate,
      setupLocalBoard: async () => {
        await board.setupBoardSortables()
        void registerWebMcpForApp(core, actions)
      },
      startSync: async () => {
        if (!core.sync.joinFromLocation(window.location.href)) await core.sync.startDurableMesh()
      },
    })
    clearTimeout(loadingTimer)
    core.showLoading.value = false
    if (startup.status === "fatal") {
      core.startupError.value = startupFailureMessage(startup.stage)
    } else if (startup.syncError) {
      core.sync.error.value = "Sync could not start. Your local board is still available."
    }
  })
  watchBoardSortables(core, board)
  const noticeTimer = watchNotice(core)
  watchWorkspaceReset(core)
  watchVisibleColumns(core, board)
  onBeforeUnmount(() => {
    void core.sync.shutdown()
    board.destroyBoardSortables()
    board.clearHighlightTimer()
    noticeTimer.clear()
    if (loadingTimer) clearTimeout(loadingTimer)
  })
}

async function registerWebMcpForApp(core: ReturnType<typeof useAppCore>, actions: ReturnType<typeof useAppActions>) {
  const unregister = await registerWebMcp({
    getActiveDoc: core.match.getActiveDoc,
    executeCommandAsync: core.match.executeCommandAsync,
    createWorkspaceAsync: actions.createAndSyncWorkspace,
    switchWorkspaceAsync: core.match.switchWorkspace,
    availableWorkspaces: core.match.availableWorkspaces,
    activeWorkspace: core.match.activeWorkspace,
    trashItems: core.match.trashItems,
    placementIssues: core.match.placementIssues,
    sendChatMessage: body => sendChatMessage(core.match.activeWorkspace.id, body),
  })
  core.hasExperimentalMcp.value = Boolean(unregister)
}

function watchBoardSortables(core: ReturnType<typeof useAppCore>, board: ReturnType<typeof useAppBoard>) {
  watch(() => [
    core.match.ready.value, core.match.docVersion.value, core.isEditingBoard.value, core.canEditItems.value,
    core.isArchiveOpen.value, core.boardRenderKey.value, board.hasFilters.value,
    board.visibleColumns.value.map(column => `${column.id}:${board.itemsForColumn(column).map(item => item.id).join(",")}`).join("|"),
  ], () => { void board.setupBoardSortables() }, { flush: "post" })
}

function watchNotice(core: ReturnType<typeof useAppCore>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  watch(core.notice, message => {
    if (timer) clearTimeout(timer)
    const hasUndo = core.archiveUndo.value && (message === "Item archived" || message.startsWith("Restore failed"))
    if (message && !hasUndo) timer = setTimeout(() => { core.notice.value = "" }, 4_000)
  })
  return { clear: () => { if (timer) clearTimeout(timer) } }
}

function watchWorkspaceReset(core: ReturnType<typeof useAppCore>) {
  watch(() => core.match.activeWorkspace.id, () => {
    core.isEditingBoard.value = false
    core.editingColumn.value = null
    core.showEntitySettings.value = false
    core.showItemForm.value = false
    core.filters.value = { columnId: "", fieldValues: {}, numberRanges: {}, dateRanges: {} }
    core.search.value = ""
    core.activeMobileColumnIndex.value = 0
    core.archiveUndo.value = null
    core.archiveError.value = ""
    core.historyRestoreError.value = ""
    core.historyRestoreNotice.value = ""
  })
}

function watchVisibleColumns(core: ReturnType<typeof useAppCore>, board: ReturnType<typeof useAppBoard>) {
  watch(() => board.visibleColumns.value.map(column => column.id).join("|"), () => {
    core.activeMobileColumnIndex.value = 0
    core.boardRef.value?.scrollTo({ left: 0, behavior: "instant" })
  }, { flush: "post" })
}
