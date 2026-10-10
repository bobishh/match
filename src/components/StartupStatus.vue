<script setup lang="ts">
defineProps<{
  message: string
  viewOnly: boolean
  error: { message: string; detail: string; stage: string } | null
}>()
</script>

<template>
  <aside class="startup-status" :class="{ 'startup-status-error': error }" :role="error ? 'alert' : 'status'" aria-label="Board status" aria-live="polite">
    <span class="startup-status-mark" aria-hidden="true">{{ error ? '!' : '' }}</span>
    <div class="startup-status-copy">
      <span>{{ error ? (viewOnly ? 'Checks could not finish. Saved board is view only.' : error.message) : message }}</span>
      <details v-if="error"><summary>Details</summary><p>{{ error.detail }}</p><p v-if="error.stage === 'storage'">Keep your website data. Reload to retry.</p></details>
    </div>
    <span v-if="viewOnly && !error" class="startup-status-mode">View only</span>
  </aside>
</template>

<style scoped>
.startup-status { width: min(var(--site-content-max), 100%); margin: 8px auto 0; padding: 8px var(--site-gutter); display: flex; align-items: center; gap: 10px; color: var(--muted); font: 700 .85rem/1.35 var(--site-font-sans); }
.startup-status-mark { flex: 0 0 16px; width: 16px; height: 16px; border: 2px solid var(--line); border-top-color: var(--blue); border-radius: 48% 52% 46% 54%; animation: status-turn 1.6s linear infinite; }
.startup-status-copy { min-width: 0; }
.startup-status-mode { margin-left: auto; flex-shrink: 0; padding: 3px 8px; border: 1px solid var(--line); border-radius: 3px 5px 4px 2px; background: var(--soft); font-size: .7rem; white-space: nowrap; }
.startup-status-error { color: var(--red); align-items: start; }
.startup-status-error .startup-status-mark { border-color: var(--red); text-align: center; line-height: 12px; animation: none; }
.startup-status-copy details { margin-top: 4px; color: var(--muted); }
.startup-status-copy summary { cursor: pointer; }
.startup-status-copy p { margin: 6px 0 0; overflow-wrap: anywhere; }
@keyframes status-turn { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .startup-status-mark { animation: none; } }
</style>
