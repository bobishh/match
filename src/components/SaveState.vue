<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useDelayedFlag } from "../ui/useDelayedFlag"

const props = defineProps<{ state: "idle" | "saving" | "saved" | "error" }>()
const showSaving = useDelayedFlag(() => props.state === "saving")
const settledState = ref(props.state)
watch(() => props.state, state => {
  if (state !== "saving") settledState.value = state
}, { immediate: true })
const label = computed(() => showSaving.value ? "Saving…" : settledState.value === "error" ? "Not saved"
  : settledState.value === "saved" ? "Saved on device" : "On this device")
</script>

<template>
  <span class="save-state" :class="{ 'save-state-error': label === 'Not saved' }" aria-live="polite" aria-atomic="true">{{ label }}</span>
</template>
