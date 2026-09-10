<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue"

const props = defineProps<{
  isOpen: boolean
  activeWorkspaceTitle: string
  isEditingBoard: boolean
  entityName: string
}>()

const emit = defineEmits<{
  (e: "close"): void
  (e: "openWorkspaces"): void
  (e: "openBoardSettings"): void
  (e: "toggleBoardEdit"): void
  (e: "openEntitySettings"): void
  (e: "openSync"): void
  (e: "openExport"): void
  (e: "openImport"): void
}>()

const drawerRef = ref<HTMLElement | null>(null)
const closeButtonRef = ref<HTMLButtonElement | null>(null)

watch(
  () => props.isOpen,
  async (open) => {
    if (open) {
      await nextTick()
      closeButtonRef.value?.focus()
    }
  }
)

onMounted(async () => {
  if (props.isOpen) {
    await nextTick()
    closeButtonRef.value?.focus()
  }
})

function handleAction(event: () => void) {
  emit("close")
  event()
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault()
    emit("close")
    return
  }

  if (e.key === "Tab" && drawerRef.value) {
    const focusable = drawerRef.value.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    if (!focusable.length) return

    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }
}
</script>

<template>
  <div v-if="isOpen" class="mobile-drawer-root">
    <div class="mobile-drawer-backdrop" aria-hidden="true" @click="emit('close')"></div>
    <nav
      id="mobile-drawer"
      ref="drawerRef"
      class="mobile-drawer"
      role="dialog"
      aria-modal="true"
      aria-label="Navigation menu"
      tabindex="-1"
      @keydown="handleKeydown"
    >
      <div class="drawer-header">
        <div class="drawer-workspace-info">
          <span class="drawer-eyebrow">WORKSPACE</span>
          <strong class="drawer-workspace-title">{{ activeWorkspaceTitle || "Match" }}</strong>
        </div>
        <button
          ref="closeButtonRef"
          class="icon-button drawer-close-btn"
          type="button"
          aria-label="Close menu"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>

      <div class="drawer-scroll">
        <!-- Workspaces Group -->
        <section class="drawer-group" aria-labelledby="heading-workspaces">
          <h3 id="heading-workspaces" class="drawer-group-title">Workspaces</h3>
          <div class="drawer-group-items">
            <button
              class="drawer-item-btn"
              type="button"
              @click="handleAction(() => emit('openWorkspaces'))"
            >
              <span>Workspaces</span>
              <span class="drawer-item-arrow" aria-hidden="true">→</span>
            </button>
          </div>
        </section>

        <section class="drawer-group" aria-labelledby="heading-settings">
          <h3 id="heading-settings" class="drawer-group-title">Settings</h3>
          <div class="drawer-group-items">
            <button
              class="drawer-item-btn"
              type="button"
              @click="handleAction(() => emit('openBoardSettings'))"
            >
              <span>Workspace settings</span>
              <span class="drawer-item-arrow" aria-hidden="true">→</span>
            </button>
            <button class="drawer-item-btn" type="button" @click="handleAction(() => emit('toggleBoardEdit'))">
              <span>{{ isEditingBoard ? "Done editing" : "Edit board" }}</span>
              <span class="drawer-item-arrow" aria-hidden="true">→</span>
            </button>
            <button v-if="isEditingBoard" class="drawer-item-btn" type="button" @click="handleAction(() => emit('openEntitySettings'))">
              <span>Edit {{ entityName }}</span>
              <span class="drawer-item-arrow" aria-hidden="true">→</span>
            </button>
          </div>
        </section>

        <!-- Collaboration Group -->
        <section class="drawer-group" aria-labelledby="heading-sync">
          <h3 id="heading-sync" class="drawer-group-title">Sync & data</h3>
          <div class="drawer-group-items">
            <button
              class="drawer-item-btn"
              type="button"
              @click="handleAction(() => emit('openSync'))"
            >
              <span>Sync, import & export</span>
              <span class="drawer-item-arrow" aria-hidden="true">→</span>
            </button>
          </div>
        </section>
      </div>
    </nav>
  </div>
</template>
