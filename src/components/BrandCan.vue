<script setup lang="ts">
withDefaults(defineProps<{ presence?: "connected" | "reconnecting" | "offline" | "empty"; label?: string }>(), {
  presence: "empty", label: "tincanban",
})
</script>

<template>
  <svg class="brand-mark" :class="`is-${presence}`" viewBox="0 0 64 80" role="img" :aria-label="label">
    <use :href="'/logo.svg?v=1#can-logo'" />
  </svg>
</template>
