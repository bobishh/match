<script setup lang="ts">
import ModalLayer from "./ModalLayer.vue"
import { defineAsyncComponent, ref } from "vue"
import type { WorkspaceCreationDraft } from "../domain/seeds"

const CreateWorkspaceDialog = defineAsyncComponent(() => import("./CreateWorkspaceDialog.vue"))

const props = defineProps<{
  workspaces: { id: string; title: string; updatedAt: string }[]
  archivedWorkspaces: { id: string; title: string; updatedAt: string }[]
  activeWorkspaceId: string
  renameWorkspace: (payload: { id: string; title: string }) => Promise<void>
  archiveWorkspace: (id: string) => Promise<void>
  restoreWorkspace: (id: string) => Promise<void>
  canRenameWorkspace: (id: string) => boolean
  createWorkspace: (payload: { title: string; preset: "blank" | "job-search"; config?: WorkspaceCreationDraft }) => Promise<void>
}>()

const emit = defineEmits<{
  (e: "close"): void
  (e: "switch", id: string): void
  (e: "import"): void
}>()

const isCreating = ref(false)
const editingId = ref("")
const editingTitle = ref("")
const renameError = ref("")
const renaming = ref(false)
const archivingId = ref("")
const archiveError = ref("")
const archiveBusy = ref(false)
const showArchived = ref(false)

function handleSwitch(id: string) {
  emit("switch", id)
  emit("close")
}

function startRename(workspace: { id: string; title: string }) {
  editingId.value = workspace.id
  editingTitle.value = workspace.title
  renameError.value = ""
}

async function handleRename() {
  if (!editingTitle.value.trim()) {
    renameError.value = "Workspace name is required"
    return
  }
  renameError.value = ""
  renaming.value = true
  try {
    await props.renameWorkspace({ id: editingId.value, title: editingTitle.value.trim() })
    editingId.value = ""
  } catch (error) {
    renameError.value = error instanceof Error ? error.message : "Could not rename workspace"
  } finally {
    renaming.value = false
  }
}

function startArchive(id: string) {
  archivingId.value = id
  archiveError.value = ""
  editingId.value = ""
  renameError.value = ""
}

async function confirmArchive(id: string) {
  archiveBusy.value = true
  archiveError.value = ""
  try {
    await props.archiveWorkspace(id)
    archivingId.value = ""
  } catch (error) {
    archiveError.value = error instanceof Error ? error.message : "Could not archive workspace"
  } finally {
    archiveBusy.value = false
  }
}

async function restoreArchived(id: string) {
  archiveBusy.value = true
  archiveError.value = ""
  try {
    await props.restoreWorkspace(id)
  } catch (error) {
    archiveError.value = error instanceof Error ? error.message : "Could not restore workspace"
  } finally {
    archiveBusy.value = false
  }
}

function displayTitle(title: string) {
  return title.toLowerCase() === "job search" ? "jobs" : title
}
</script>

<template>
  <ModalLayer protect-draft class="overlay" @close="emit('close')">
    <section v-if="!isCreating" class="dialog" role="dialog" aria-modal="true" aria-label="Workspaces">
      <div class="dialog-head">
        <div>
          <span class="eyebrow">Workspaces</span>
          <h2>Your workspaces</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Close" @click="emit('close')">×</button>
      </div>

      <div class="workspace-list">
        <div
          v-for="ws in workspaces"
          :key="ws.id"
          class="workspace-item"
          :class="{ 'workspace-item-active': ws.id === activeWorkspaceId }"
        >
          <button class="workspace-switch" type="button" @click="handleSwitch(ws.id)">
            <strong>{{ displayTitle(ws.title) }}</strong>
            <span v-if="ws.id === activeWorkspaceId" class="workspace-active-badge">Active</span>
          </button>
          <div class="workspace-item-actions">
            <button v-if="canRenameWorkspace(ws.id)" type="button" aria-label="Rename" @click="startRename(ws)">Rename</button>
            <button type="button" aria-label="Archive" @click="startArchive(ws.id)">Archive</button>
          </div>
          <form v-if="editingId === ws.id" class="workspace-rename-form" :aria-busy="renaming" @submit.prevent="handleRename">
            <label>
              <span class="sr-only">Workspace name</span>
              <input v-model="editingTitle" aria-label="Workspace name" :disabled="renaming" autofocus />
            </label>
            <button class="button button-primary" type="submit" :disabled="renaming">{{ renaming ? 'Saving…' : 'Save name' }}</button>
            <button class="button button-quiet" type="button" :disabled="renaming" @click="editingId = ''; renameError = ''">Cancel</button>
            <p v-if="renameError" class="form-error" role="alert">{{ renameError }}</p>
          </form>
          <div v-if="archivingId === ws.id" class="workspace-delete-confirm" role="group" :aria-label="`Archive ${ws.title}`">
            <p>Archive “{{ ws.title }}” and hide it from active workspaces? Its cards and documents remain saved.</p>
            <button class="button button-danger" type="button" :disabled="archiveBusy" @click="confirmArchive(ws.id)">{{ archiveBusy ? 'Archiving…' : 'Archive workspace' }}</button>
            <button class="button button-quiet" type="button" :disabled="archiveBusy" @click="archivingId = ''">Cancel</button>
            <p v-if="archiveError" class="form-error" role="alert">{{ archiveError }}</p>
          </div>
        </div>
      </div>

      <button v-if="archivedWorkspaces.length" class="button button-quiet" type="button" @click="showArchived = !showArchived">{{ showArchived ? 'Hide archived' : 'Show archived' }}</button>
      <div v-if="showArchived" class="workspace-list" aria-label="Archived workspaces">
        <div v-for="ws in archivedWorkspaces" :key="ws.id" class="workspace-item">
          <div class="workspace-label"><strong>{{ displayTitle(ws.title) }}</strong></div>
          <div class="workspace-item-actions"><button type="button" :disabled="archiveBusy" @click="restoreArchived(ws.id)">{{ archiveBusy ? 'Restoring…' : 'Restore workspace' }}</button></div>
        </div>
        <p v-if="archiveError" class="form-error" role="alert">{{ archiveError }}</p>
      </div>

      <div class="dialog-actions">
        <button class="button button-primary" type="button" @click="isCreating = true">New workspace</button>
        <button class="button button-quiet" type="button" @click="emit('import')">Import as new board</button>
        <button class="button button-quiet" type="button" @click="emit('close')">Close</button>
      </div>
    </section>

    <CreateWorkspaceDialog v-else :create-workspace="createWorkspace" @close="isCreating = false" />
  </ModalLayer>
</template>
