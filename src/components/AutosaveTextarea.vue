<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"

const props = defineProps<{
  value: string
  label: string
  placeholder?: string
  readOnly?: boolean
  save: (value: string) => Promise<void>
}>()
const draft = ref(props.value)
const saved = ref(props.value)
const saving = ref(false)
const error = ref("")
const dirty = computed(() => draft.value !== saved.value)
let timer: ReturnType<typeof setTimeout> | undefined
let inFlight: Promise<boolean> | undefined

watch(() => props.value, value => {
  if (!dirty.value && !saving.value) draft.value = saved.value = value
})

function cancelTimer() { clearTimeout(timer); timer = undefined }
function input(event: Event) {
  draft.value = (event.target as HTMLTextAreaElement).value
  error.value = ""
  cancelTimer()
  timer = setTimeout(() => { void flush() }, 600)
}

async function persist(): Promise<boolean> {
  saving.value = true
  error.value = ""
  try {
    // Keep newer edits local while an older value is being committed.
    while (dirty.value) {
      const value = draft.value
      await props.save(value)
      saved.value = value
    }
    return true
  } catch (cause) {
    error.value = `Not saved: ${cause instanceof Error ? cause.message : String(cause)}`
    return false
  } finally { saving.value = false }
}

async function flush(): Promise<boolean> {
  cancelTimer()
  if (inFlight) return inFlight
  if (!dirty.value || props.readOnly) return !dirty.value
  inFlight = persist()
  try { return await inFlight }
  finally { inFlight = undefined }
}

onBeforeUnmount(cancelTimer)
defineExpose({ flush })
</script>

<template>
  <textarea :value="draft" :readonly="readOnly" :aria-label="label" :placeholder="placeholder"
    rows="3" @input="input" @blur="flush()"></textarea>
  <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  <button v-if="error" class="button button-small" type="button" @click="flush()">Retry save</button>
  <span v-if="!readOnly" class="save-state" role="status">{{ saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved' }}</span>
</template>
