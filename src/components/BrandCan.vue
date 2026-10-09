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
  <span class="brand-mark" :title="label" :class="`is-${presence}`" :style="colors">
    <svg viewBox="0 0 64 80" role="img" :aria-label="label">
      <use :href="'/logo.svg?v=4#can-logo'" />
    </svg>
    <svg v-if="appearance" class="can-role-stamp" viewBox="0 0 64 80" role="img" :aria-label="`Workspace role: ${accessRole}`" :data-role-stamp="accessRole">
      <path transform="translate(23.6 44.5) scale(.7)" :d="appearance.stamp" fill="#171717" fill-opacity=".75" stroke="#171717" stroke-width="1.5" stroke-linejoin="round" />
    </svg>
  </span>
</template>
