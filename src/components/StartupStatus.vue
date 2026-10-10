<script setup lang="ts">
defineProps<{
  message: string
  viewOnly: boolean
  error: { message: string; detail: string; stage: string } | null
}>()
</script>

<template>
  <aside class="startup-status" :class="{ 'startup-status-error': error }" :role="error ? 'alert' : 'status'" aria-label="Board status" aria-live="polite">
    <span class="startup-status-mark" aria-hidden="true">
      <template v-if="error">!</template>
      <template v-else><span v-for="dot in 3" :key="dot" class="startup-status-dot">•</span></template>
    </span>
    <div class="startup-status-copy">
      <span>{{ error ? (viewOnly ? 'Checks could not finish. Saved board is view only.' : error.message) : message }}</span>
      <details v-if="error"><summary>Details</summary><p>{{ error.detail }}</p><p v-if="error.stage === 'storage'">Keep your website data. Reload to retry.</p></details>
    </div>
    <span v-if="viewOnly && !error" class="startup-status-mode">View only</span>
  </aside>
</template>

<style scoped>
.startup-status { width: min(var(--site-content-max), 100%); margin: 8px auto 0; padding: 8px var(--site-gutter); display: flex; align-items: center; gap: 10px; color: var(--muted); font: 700 .85rem/1.35 var(--site-font-sans); }
.startup-status-mark { flex: 0 0 22px; color: var(--blue); letter-spacing: 2px; }
.startup-status-dot { animation: status-one 1.8s steps(1, end) infinite; }
.startup-status-dot:nth-child(2) { animation-name: status-two; }
.startup-status-dot:nth-child(3) { animation-name: status-three; }
.startup-status-copy { min-width: 0; }
.startup-status-mode { margin-left: auto; flex-shrink: 0; padding: 3px 8px; border: 1px solid var(--line); border-radius: 3px 5px 4px 2px; background: var(--soft); font-size: .7rem; white-space: nowrap; }
.startup-status-error { color: var(--red); align-items: start; }
.startup-status-error .startup-status-mark { color: var(--red); text-align: center; }
.startup-status-copy details { margin-top: 4px; color: var(--muted); }
.startup-status-copy summary { cursor: pointer; }
.startup-status-copy p { margin: 6px 0 0; overflow-wrap: anywhere; }
@keyframes status-one { 0% { opacity: 1; } 75%, 100% { opacity: 0; } }
@keyframes status-two { 0%, 75%, 100% { opacity: 0; } 25% { opacity: 1; } }
@keyframes status-three { 0%, 75%, 100% { opacity: 0; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .startup-status-dot { animation: none; } }
</style>
