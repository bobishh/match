<script setup lang="ts">
import { ref, watch } from "vue"

const props = withDefaults(
  defineProps<{
    name: string
    displayName: string
    saving: boolean
    error: string
  }>(),
  {
    name: "",
    displayName: "",
    saving: false,
    error: "",
  }
)

const emit = defineEmits<{
  save: [name: string]
  randomize: []
}>()

const draftName = ref(props.name || "")
const isActivelyEdited = ref(false)

function handleInput() {
  isActivelyEdited.value = true
}

watch(
  () => props.name,
  (newName) => {
    if (!isActivelyEdited.value) {
      draftName.value = newName || ""
    }
  }
)

watch(
  () => props.saving,
  (newSaving, oldSaving) => {
    if (oldSaving && !newSaving) {
      if (!props.error) {
        isActivelyEdited.value = false
        draftName.value = props.name || ""
      }
    }
  }
)

function handleSave() {
  const trimmed = draftName.value.trim()
  if (!trimmed || props.saving) return
  emit("save", trimmed)
}

function handleRandomize() {
  if (props.saving) return
  isActivelyEdited.value = false
  emit("randomize")
}
</script>

<template>
  <section class="workspace-name-settings" aria-labelledby="name-settings-heading">
    <form class="name-settings-form" novalidate @submit.prevent="handleSave">
      <div class="name-settings-header">
        <span class="eyebrow">Workspace identity</span>
        <h3 id="name-settings-heading">Your name</h3>
      </div>

      <div v-if="displayName || name" class="effective-name-display">
        <span class="effective-label">Effective name:</span>
        <strong class="effective-value">{{ displayName || name }}</strong>
      </div>

      <div class="name-field-group">
        <label for="workspace-name-input" class="name-label">
          <span>Your name</span>
          <input
            id="workspace-name-input"
            v-model="draftName"
            type="text"
            class="name-input"
            maxlength="48"
            :disabled="saving"
            required
            aria-describedby="name-explanation"
            @input="handleInput"
          />
        </label>
        <p id="name-explanation" class="name-explanation">
          Your name in this workspace. Matching names get a unique suffix.
        </p>
      </div>

      <p v-if="error" class="form-error" role="alert">
        {{ error }}
      </p>

      <div class="name-settings-actions">
        <button
          class="button button-primary"
          type="submit"
          :disabled="saving || !draftName.trim()"
        >
          Save name
        </button>
        <button
          class="button button-quiet"
          type="button"
          :disabled="saving"
          @click="handleRandomize"
        >
          Suggest a name
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.workspace-name-settings {
  width: 100%;
  box-sizing: border-box;
}

.name-settings-form {
  display: grid;
  gap: 16px;
}

.name-settings-header {
  display: grid;
  gap: 4px;
}

.name-settings-header h3 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 800;
  line-height: 1.2;
  letter-spacing: -0.02em;
  color: var(--ink);
}

.eyebrow {
  display: block;
  color: var(--muted);
  font: 800 0.68rem/1 ui-monospace, monospace;
  letter-spacing: 0.13em;
  text-transform: uppercase;
}

.effective-name-display {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 2px solid var(--soft);
  background: white;
  font: 700 0.78rem/1.4 ui-monospace, monospace;
}

.effective-label {
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-size: 0.68rem;
}

.effective-value {
  color: var(--ink);
  font-size: 0.88rem;
}

.name-field-group {
  display: grid;
  gap: 6px;
}

.name-label {
  display: grid;
  gap: 10px;
  color: var(--muted);
  font: 800 0.68rem/1 ui-monospace, monospace;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.name-input {
  width: 100%;
  min-height: 42px;
  padding: 10px 12px;
  border: 2px solid var(--line);
  border-radius: 0;
  background: white;
  font: 400 1rem/1.4 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--ink);
  box-sizing: border-box;
}

.name-explanation {
  margin: 0;
  color: var(--muted);
  font-size: 0.8rem;
  line-height: 1.4;
}

.name-settings-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 4px;
}
</style>
