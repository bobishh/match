<script setup lang="ts">
defineProps<{ online: boolean; reconnecting: boolean }>()
</script>

<template>
  <svg class="lighthouse-mark" :class="{ 'is-online': online, 'is-reconnecting': reconnecting }" viewBox="0 0 24 28" role="img" aria-label="Lighthouse">
    <path d="M7 25 9 12h6l2 13M6 25h12M8 12h8M9 12V7h6v5M8 7l4-4 4 4M3 8 1 6M3 11l-2 2M21 8l2-2M21 11l2 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M9 18h6" stroke="currentColor" stroke-width="3" />
  </svg>
</template>

<style scoped>
.lighthouse-mark { flex: 0 0 24px; width: 24px; height: 28px; color: var(--muted); }
.lighthouse-mark.is-online { color: #3f6848; }
.lighthouse-mark.is-reconnecting { color: #9a6b20; }
</style>
