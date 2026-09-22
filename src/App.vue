<!-- Workspace role gates are enforced again at command and sync boundaries. -->
<script setup lang="ts">
import { useAppController } from "./app/useAppController"
import { isArchiveColumn } from "./domain/archive"
import { showEnteringElement, hideLeavingElement } from "./ui/modal"
import { artifactKindLabels, priorityLabels, statusLabels, type DocumentInput } from "./types"
import ModalLayer from "./components/ModalLayer.vue"
import SyncDialog from "./components/SyncDialog.vue"
import LeadFilters from "./components/LeadFilters.vue"
import WorkspacesDialog from "./components/WorkspacesDialog.vue"
import ColumnDialog from "./components/ColumnDialog.vue"
import SchemaEditorDialog from "./components/SchemaEditorDialog.vue"
import WorkspaceChat from "./components/WorkspaceChat.vue"
import WorkspaceParticipants from "./components/WorkspaceParticipants.vue"
import ItemFormDialog from "./components/ItemFormDialog.vue"
import ItemDetailDialog from "./components/ItemDetailDialog.vue"
import QuickNoteForm from "./components/QuickNoteForm.vue"
import MoveItemDialog from "./components/MoveItemDialog.vue"
import MobileDrawer from "./components/MobileDrawer.vue"
import SaveState from "./components/SaveState.vue"
import ItemDocuments from "./components/ItemDocuments.vue"
import IdentityRecoveryDialog from "./components/IdentityRecoveryDialog.vue"
import IdentitySettingsPanel from "./components/IdentitySettingsPanel.vue"
import BuildFooter from "./components/BuildFooter.vue"
import WorkspaceFileActions from "./components/WorkspaceFileActions.vue"
import { ref } from "vue"

const app = useAppController()
const showIdentityRecovery = ref(false)
const showSettings = ref(false)
async function stopSyncForIdentityRestore() {
  await app.collaboration.device.sync.shutdown()
}
function restoredIdentity() {
  window.location.reload()
}
const {
  workspace, ready, saveState, availableWorkspaces, activeWorkspace, activeBoard,
  isBlankBoard, genericColumns, boardFields, getActiveDoc, documentsFor,
} = app.workspace
const { state: ui, controls: uiControls } = app.ui
const {
  detailDialog, importInput, showArtifactForm, search, filters,
  notice, archiveUndo, undoSaving, archiveError, historyRestoreSaving,
  historyRestoreError, historyRestoreNotice, isArchiveOpen, artifactError,
  showWorkspaces, showEntitySettings, isEditingBoard,
  newBoardColumnTitle, boardRef, boardRenderKey, movedItemId, movedColumnId,
  activeMobileColumnIndex, showItemForm, itemFormError, savingItem, editingColumn,
  selectedItemId, editingItemId, itemToMove, showMoveDialog, storageError,
  quickNoteDraft, quickNoteSaving, quickNoteError, hasExperimentalMcp,
  showMobileMenu, menuButtonRef, showLoading, startupError,
  artifactDraft,
} = ui
const { toggleMobileMenu, closeMobileMenu } = uiControls
const {
  workspaceLabel, entityName, addItemLabel, itemFormColumns, itemFormParentValue,
  computedItemFieldIds, itemFormOptionValues, visibleItems, hasFilters, workspacePresenceSummary,
  visibleColumns, clearFilters, leadForItem, cardNotes, cardFields, columnStatus, itemsForColumn,
  updateMobileColumnIndex, moveMobileColumn, selectedItem, subitemsForSelectedItem,
  selectedItemHistory, editingItem, candidateParentsForMove,
} = app.board
const {
  sync, chat,
} = app.collaboration.device
const {
  currentRole, workspaceAccessErrors, workspaceRoleStatus, currentWorkspaceOwnerId, canEditItems, canEditBoard, canManageAccess, canRenameWorkspace,
} = app.collaboration.permissions
const {
  meshPresence, meshPresenceLabel,
  activeMeshRetryAt, meshMembers, meshParticipantDevices, activeSuccession,
  canClaimSuccession, transferringOwnership, revokingPeer,
  peerAccessError, repairableHistory, repairHistory, transferWorkspaceOwnership,
  leaveWorkspaceMesh, setWorkspaceSuccessor, voteForWorkspaceSuccessor,
  claimWorkspaceSuccession, revokeWorkspacePeer, promoteWorkspacePeer,
} = app.collaboration.mesh
const {
  selectedLead, selectedLeadItem, selectedDocuments, selectedArtifacts, availableArtifactTemplates,
  reloadPage, openBoardItem,
  restoreSelectedItemVersion, saveQuickNote, submitDocument, handleSaveTemplate,
  openArtifactForm, submitArtifact, setStatus, handleUpdateRejectionReason,
  exportWorkspace, openImport, importWorkspace, closeDetail, handleCreateWorkspace,
  handleSwitchWorkspace, handleRenameWorkspace, handleDeleteWorkspace, openAddItem,
  handleSaveItem, currentDocHeads, handleApplySchema, handleApplyWorkspaceSettings,
  handleDeleteItem, undoArchive, handleOpenItemEdit, handleAddSubitem,
  handleStartMove, handleConfirmMove, handleRenameColumn, handleDeleteColumn,
  addBoardColumn,
} = app.actions

function saveSelectedItemDocument(document: Omit<DocumentInput, "leadId">) {
  const item = selectedItem.value
  if (!item) return Promise.reject(new Error("Item is no longer open"))
  return submitDocument(item.id, document)
}

function saveSelectedLeadDocument(document: Omit<DocumentInput, "leadId">) {
  const item = selectedLeadItem.value
  if (!item) return Promise.reject(new Error("Lead is no longer open"))
  return submitDocument(item.id, document)
}

async function applyWorkspaceSettings(payload: Parameters<typeof handleApplyWorkspaceSettings>[0]) {
  if (await handleApplyWorkspaceSettings(payload)) showSettings.value = false
}
</script>

<template>
  <main class="shell" :aria-busy="!ready.value && !startupError">
    <header class="topbar">
      <button class="brand brand-button" type="button" aria-label="Open workspaces" :disabled="!ready.value" @click="showWorkspaces = true">
        <span class="brand-presence">
          <span v-if="ready.value && workspaceRoleStatus === 'verified' && currentRole === 'owner'" class="owner-crown" role="img" aria-label="Workspace role: owner">♛</span>
          <span v-else-if="ready.value" class="workspace-role-icon" role="img" :aria-label="workspaceRoleStatus === 'verified' ? `Workspace role: ${currentRole}` : `Workspace permissions: ${workspaceRoleStatus}`">
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
        <button class="button button-quiet" type="button" aria-label="Settings" @click="showSettings = true">Settings</button>
        <button v-if="canEditBoard" class="button button-quiet" type="button" @click="isEditingBoard = !isEditingBoard">{{ isEditingBoard ? "Done" : "Edit board" }}</button>
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
      :can-edit-board="canEditBoard"
      :entity-name="entityName"
      @close="closeMobileMenu"
      @open-workspaces="showWorkspaces = true"
      @open-settings="showSettings = true"
      @toggle-board-edit="isEditingBoard = !isEditingBoard"
      @open-entity-settings="showEntitySettings = true"
      @open-sync="sync.open"
    />

    <TransitionGroup name="notice" tag="aside" class="notice-overlay" aria-live="polite" aria-atomic="true" @before-enter="showEnteringElement" @before-leave="hideLeavingElement">
      <div v-for="error in workspaceAccessErrors" :key="error" role="alert" class="notice notice-error">{{ error }}. Other boards remain available. You can export this board and import it as a new board.</div>
      <div v-if="storageError && !showItemForm" key="storage-error" role="alert" class="notice notice-error">
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
        <SaveState :state="saveState" :settled-label="workspacePresenceSummary" aria-label="Workspace presence" />
      </div>
    </section>

    <div v-if="hasFilters" class="filter-summary" aria-live="polite">
      <span>{{ visibleItems ? 'Showing matching cards' : 'No matching cards' }}</span>
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
        <button v-if="isArchiveColumn(column) && !isArchiveOpen && !hasFilters" class="bin-closed" type="button" :aria-label="`Open ${column.title} with ${itemsForColumn(column).length} cards`" @click="isArchiveOpen = true"><span class="bin-icon" aria-hidden="true"></span><strong>{{ column.title }}</strong><small>{{ itemsForColumn(column).length }}</small></button>
        <template v-else>
          <header class="column-header" :class="{ 'column-drag-handle': isEditingBoard }">
            <div class="column-title"><span class="column-dot"></span><h2 :title="isEditingBoard ? 'Double-click to edit column' : undefined" @dblclick="isEditingBoard && (editingColumn = column)">{{ column.title }}</h2></div>
            <div class="column-actions"><span class="count">{{ itemsForColumn(column).length }}</span><button v-if="isArchiveColumn(column) && !hasFilters" class="bin-close" type="button" :aria-label="`Collapse ${column.title}`" @click="isArchiveOpen = false">×</button><button v-if="isEditingBoard" class="button button-small button-quiet" type="button" aria-label="Edit column" @click="editingColumn = column">Edit</button></div>
          </header>
          <div class="card-stack" :data-column-id="column.id">
            <button v-for="item in itemsForColumn(column)" :key="item.id" class="lead-card item-card" :class="{ 'card-moved': movedItemId === item.id }" :data-item-id="item.id" type="button" :aria-label="`Open ${item.title}`" @click="openBoardItem(item)">
              <div class="card-main">
              <template v-if="leadForItem(item)">
                <div class="card-head"><span class="company">{{ leadForItem(item)?.company }}</span><span v-if="leadForItem(item)?.priority" class="priority" :class="leadForItem(item)?.priority">{{ leadForItem(item)?.priority?.toUpperCase() }}</span></div>
                <strong>{{ leadForItem(item)?.role }}</strong>
                <div class="card-meta"><span v-if="leadForItem(item)?.location">{{ leadForItem(item)?.location }}</span><span v-if="leadForItem(item)?.fitScore !== undefined" class="fit">{{ leadForItem(item)?.fitScore }}/10 fit</span></div>
              </template>
              <template v-else><strong>{{ item.title }}</strong><p v-if="item.body && !hasFilters" class="item-card-body">{{ item.body }}</p></template>
              </div>
              <div v-if="hasFilters && (cardNotes(item) || cardFields(item).length)" class="card-context">
                <p v-if="cardNotes(item)" class="card-notes">{{ cardNotes(item) }}</p>
                <dl v-if="cardFields(item).length" class="card-fields">
                  <div v-for="field in cardFields(item)" :key="field.id"><dt>{{ field.title }}</dt><dd>{{ field.value }}</dd></div>
                </dl>
              </div>
            </button>
            <div v-if="!itemsForColumn(column).length" class="empty-column">{{ hasFilters ? 'No matches in this column' : `No ${entityName}s` }}</div>
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
      :rename-workspace="handleRenameWorkspace"
      :can-rename-workspace="canRenameWorkspace"
      @close="showWorkspaces = false"
      @switch="handleSwitchWorkspace"
      @create="handleCreateWorkspace"
      @import="openImport"
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
      v-if="showSettings && activeBoard && getActiveDoc()"
      :doc="getActiveDoc()!"
      :read-only="!canEditBoard"
      :board="activeBoard"
      :columns="genericColumns"
      :fields="boardFields"
      :templates="workspace.templates"
      :heads="currentDocHeads"
      mode="templates"
      @close="showSettings = false"
      @save-template="handleSaveTemplate"
      @apply-workspace-settings="applyWorkspaceSettings"
    >
      <template #identity>
        <IdentitySettingsPanel :display-name="app.workspace.getCurrentProfile()?.identity.displayName ?? 'Match User'"
          @saved="app.workspace.refreshIdentity()" @recovery="showIdentityRecovery = true" />
      </template>
      <template #participants>
        <WorkspaceParticipants
          :members="chat.members.value"
          :current-person-id="chat.personId.value"
          :current-role="currentRole"
          :owner-person-id="currentWorkspaceOwnerId"
          :peers="meshParticipantDevices"
          :can-manage-access="canManageAccess"
          :revoking-person-id="revokingPeer"
          :error="peerAccessError"
          @revoke="revokeWorkspacePeer"
        />
      </template>
      <template #data><WorkspaceFileActions export-only @export="exportWorkspace" /></template>
    </SchemaEditorDialog>
    <ModalLayer v-else-if="showSettings" @close="showSettings = false">
      <section class="dialog" role="dialog" aria-modal="true" aria-label="Settings">
        <div class="dialog-head"><div><span class="eyebrow">Identity</span><h2>Settings</h2></div><button class="icon-button" type="button" aria-label="Close" @click="showSettings = false">×</button></div>
        <IdentitySettingsPanel :display-name="app.workspace.getCurrentProfile()?.identity.displayName ?? 'Match User'"
          @saved="app.workspace.refreshIdentity()" @recovery="showIdentityRecovery = true" />
      </section>
    </ModalLayer>
    <IdentityRecoveryDialog v-if="showIdentityRecovery" :before-restore="stopSyncForIdentityRestore" @close="showIdentityRecovery = false" @restored="restoredIdentity" />

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
      :read-only="!canEditBoard"
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

    <ItemDetailDialog
      v-if="selectedItem"
      :item="selectedItem"
      :read-only="!canEditItems"
      :subitems="subitemsForSelectedItem"
      :fields="boardFields"
      :documents="documentsFor(selectedItem.id)"
      :save-document="saveSelectedItemDocument"
      :history="selectedItemHistory"
      :archive-error="archiveError"
      :restore-saving="historyRestoreSaving"
      :restore-error="historyRestoreError"
      :restore-notice="historyRestoreNotice"
      :quick-note="quickNoteDraft"
      :note-saving="quickNoteSaving"
      :note-error="quickNoteError"
      @close="selectedItemId = null; historyRestoreError = ''; historyRestoreNotice = ''"
      @edit="handleOpenItemEdit"
      @add-subitem="handleAddSubitem"
      @start-move="handleStartMove"
      @delete-item="handleDeleteItem"
      @restore-version="restoreSelectedItemVersion"
      @update:quick-note="quickNoteDraft = $event"
      @save-note="saveQuickNote(selectedItem)"
    />

    <ItemFormDialog
      v-if="showItemForm"
      :parent-id="itemFormParentValue"
      :fields="boardFields"
      :columns="itemFormColumns"
      :item="editingItem"
      :show-core-fields="isBlankBoard"
      :hidden-field-ids="computedItemFieldIds"
      :computed-fields-message="computedItemFieldIds.length ? 'Priority and fit are calculated from workspace preferences.' : undefined"
      :option-values="itemFormOptionValues"
      :error-message="itemFormError"
      :saving="savingItem"
      @cancel="showItemForm = false; editingItemId = null; itemFormError = ''"
      @save="handleSaveItem"
    />

    <MoveItemDialog
      v-if="showMoveDialog && itemToMove"
      :item="itemToMove"
      :candidate-parents="candidateParentsForMove"
      @close="showMoveDialog = false; itemToMove = null"
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
      v-bind="{ activeWorkspaceId: activeWorkspace.id, localDeviceId: sync.localDeviceId.value,
        removableDeviceWorkspaces: sync.removableDeviceWorkspaces, removeDevice: sync.removeDevice, enrollmentConflict: sync.enrollmentConflict.value }"
      :has-mesh="meshMembers.length > 0"
      :current-person-id="chat.personId.value"
      :current-role="currentRole"
      :succession="activeSuccession"
      :can-claim-succession="canClaimSuccession"
      :can-manage-mesh="canManageAccess"
      :transferring-ownership="transferringOwnership"
      :mesh-action-error="peerAccessError"
      :workspace-connected="meshPresence === 'connected'"
      :mesh-diagnostic="sync.meshDiagnostic.value"
      :retry-at="activeMeshRetryAt"
      :network-online="sync.networkOnline.value"
      :repairable-history="repairableHistory"
      @repair-history="repairHistory"
      :live="sync.isEnabled.value"
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
      @promote-peer="promoteWorkspacePeer"
      @request-enrollment="sync.requestEnrollment"
      :enrollment-device-name="sync.enrollmentDeviceName.value"
      @approve-device="sync.approveEnrollment"
      @decline-device="sync.declineEnrollment"
      @accept-and-join="sync.acceptWorkspaceJoin"
      @copy="sync.copyInvite"
      @export="exportWorkspace"
      @import="openImport"
      @dismiss="sync.dismiss"
      @start="sync.startDurableMesh"
      @stop="sync.stopLiveSync"
    />

    <ModalLayer v-if="selectedLead" class="overlay detail-overlay" @close="closeDetail">
      <section ref="detailDialog" class="dialog detail-dialog" role="dialog" aria-modal="true" aria-label="Lead details" tabindex="-1" @keydown.esc="closeDetail">
        <div class="detail-head">
          <div><span class="eyebrow">Lead card</span><h2>{{ selectedLead.company }}</h2><p>{{ selectedLead.role }}</p></div>
          <div class="detail-head-actions">
            <button v-if="selectedLeadItem" class="button button-small" type="button" :disabled="!canEditItems" @click="handleOpenItemEdit(selectedLeadItem)">Edit</button>
            <button class="icon-button" type="button" aria-label="Close detail" @click="closeDetail">×</button>
          </div>
        </div>
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
        <QuickNoteForm
          v-if="selectedLeadItem"
          v-model="quickNoteDraft"
          :saving="quickNoteSaving"
          :error="quickNoteError"
          :read-only="!canEditItems"
          @save="saveQuickNote(selectedLeadItem)"
        />
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

        <ItemDocuments
          v-if="selectedLeadItem"
          :documents="selectedDocuments"
          :read-only="!canEditItems"
          :save="saveSelectedLeadDocument"
        />
      </div>
      </section>
    </ModalLayer>
    </template>
  </main>
  <BuildFooter />
</template>
