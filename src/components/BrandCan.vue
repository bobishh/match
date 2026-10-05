<script setup lang="ts">
import { computed } from "vue"
import type { WorkspaceRole } from "../domain/permissions"
import { canRoles } from "../ui/canRole"

const props = withDefaults(defineProps<{
  presence?: "connected" | "reconnecting" | "offline" | "empty"
  label?: string
  accessRole?: WorkspaceRole | null
}>(), { presence: "empty", label: "tincanban", accessRole: null })
const appearance = computed(() => props.accessRole ? canRoles[props.accessRole] : null)
const colors = computed(() => appearance.value ? {
  "--can-body": appearance.value.body,
  "--can-highlight": appearance.value.highlight,
  "--can-shade": appearance.value.shade,
} : undefined)
</script>

<template>
  <span class="brand-mark" :class="`is-${presence}`" :style="colors">
    <svg viewBox="0 0 64 80" role="img" :aria-label="label">
      <use :href="'/logo.svg?v=2#can-logo'" />
    </svg>
    <svg v-if="appearance" class="can-role-stamp" viewBox="0 0 64 80" role="img" :aria-label="`Workspace role: ${accessRole}`" :data-role-stamp="accessRole">
      <circle cx="32" cy="50" r="14" :fill="appearance.body" />
      <path transform="translate(20 38)" :d="appearance.stamp" fill="#171717" />
    </svg>
  </span>
</template>
