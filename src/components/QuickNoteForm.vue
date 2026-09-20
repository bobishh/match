<script setup lang="ts">
defineProps<{
  modelValue: string
  saving?: boolean
  error?: string
  readOnly?: boolean
}>()

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void
  (e: "save"): void
}>()

function updateDraft(event: Event) {
  emit("update:modelValue", (event.target as HTMLTextAreaElement).value)
}
</script>

<template>
  <form class="quick-note-form" aria-label="Quick note" @submit.prevent="emit('save')">
    <label>
      <span class="detail-label">Quick note</span>
      <textarea
        :value="modelValue"
        :disabled="readOnly || saving"
        rows="3"
        aria-label="Quick note"
        placeholder="Write a note without creating a document…"
        @input="updateDraft"
      />
    </label>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <button class="button button-small" type="submit" :disabled="readOnly || saving || !modelValue.trim()">
      {{ saving ? "Saving…" : error ? "Retry note" : "Add note" }}
    </button>
  </form>
</template>
