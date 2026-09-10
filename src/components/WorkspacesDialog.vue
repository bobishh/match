<script setup lang="ts">
import ModalLayer from "./ModalLayer.vue"
import { ref } from "vue"

const props = defineProps<{
  workspaces: { id: string; title: string; updatedAt: string }[]
  activeWorkspaceId: string
}>()

const emit = defineEmits<{
  (e: "close"): void
  (e: "switch", id: string): void
  (e: "create", payload: { title: string; preset: "blank" | "job-search" }): void
}>()

const isCreating = ref(false)
const title = ref("")
const preset = ref<"blank" | "job-search">("blank")
const error = ref("")

function handleCreate() {
  if (!title.value.trim()) {
    error.value = "Workspace title is required"
    return
  }
  emit("create", { title: title.value.trim(), preset: preset.value })
  title.value = ""
  preset.value = "blank"
  isCreating.value = false
}

function handleSwitch(id: string) {
  emit("switch", id)
  emit("close")
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
        <button
          v-for="ws in workspaces"
          :key="ws.id"
          class="workspace-item"
          :class="{ 'workspace-item-active': ws.id === activeWorkspaceId }"
          type="button"
          @click="handleSwitch(ws.id)"
        >
          <strong>{{ displayTitle(ws.title) }}</strong>
          <span v-if="ws.id === activeWorkspaceId" class="workspace-active-badge">Active</span>
        </button>
      </div>

      <div class="dialog-actions">
        <button class="button button-primary" type="button" @click="isCreating = true">New workspace</button>
        <button class="button button-quiet" type="button" @click="emit('close')">Close</button>
      </div>
    </section>

    <section v-else class="dialog" role="dialog" aria-modal="true" aria-label="Create workspace">
      <form novalidate @submit.prevent="handleCreate">
        <div class="dialog-head">
          <div>
            <span class="eyebrow">New workspace</span>
            <h2>Create workspace</h2>
          </div>
          <button class="icon-button" type="button" aria-label="Close" @click="isCreating = false">×</button>
        </div>

        <div class="workspace-create-form">
          <label>
            <span>Title</span>
            <input v-model="title" autofocus required placeholder="e.g. Reading List" />
          </label>

          <fieldset class="workspace-preset">
            <legend>Preset</legend>
            <div class="workspace-preset-options">
              <label>
                <input v-model="preset" type="radio" value="blank" />
                <span>Blank board</span>
              </label>
              <label>
                <input v-model="preset" type="radio" value="job-search" />
                <span>Job search</span>
              </label>
            </div>
          </fieldset>

          <p v-if="error" role="alert" class="form-error">{{ error }}</p>
        </div>

        <div class="dialog-actions">
          <button class="button button-quiet" type="button" @click="isCreating = false">Cancel</button>
          <button class="button button-primary" type="submit">Create</button>
        </div>
      </form>
    </section>
  </ModalLayer>
</template>
