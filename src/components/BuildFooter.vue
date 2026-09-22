<script setup lang="ts">
/* global __MATCH_BUILD_COMMIT__ */
const commit = __MATCH_BUILD_COMMIT__
const hasCommit = /^[0-9a-f]{40}$/i.test(commit)
const shortCommit = hasCommit ? commit.slice(0, 7) : commit
const commitUrl = hasCommit ? `https://github.com/bobishh/match/commit/${commit}` : undefined
</script>

<template>
  <footer class="site-footer" aria-label="Match build information">
    <svg class="tower-mark" viewBox="0 0 64 96" aria-hidden="true">
      <line x1="32" y1="3" x2="32" y2="19" />
      <circle class="tower-mark__sphere" cx="32" cy="29" r="10" />
      <path d="M32 39 L25 84 M32 39 L39 84 M21 84 H43" />
    </svg>
    <span class="footer-copy">Berlin · 2026 · <a v-if="commitUrl" :href="commitUrl" target="_blank" rel="noreferrer">{{ shortCommit }}</a><template v-else>{{ shortCommit }}</template></span>
  </footer>
</template>

<style scoped>
.site-footer { min-height: 152px; padding: 24px clamp(16px, 4vw, 56px); border-top: 2px solid var(--line); display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 10px; color: var(--ink); text-align: center; font: 700 .7rem/1.4 ui-monospace, monospace; }
.tower-mark { width: 36px; height: 54px; overflow: visible; fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: square; stroke-linejoin: miter; }
.tower-mark__sphere { fill: var(--red); }
.footer-copy { font-size: .78rem; }
.footer-copy a { color: inherit; text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 3px; }
.footer-copy a:hover { color: var(--red); }
</style>
