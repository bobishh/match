<script setup lang="ts">
import rustyLogo from "../assets/rusty-logo.webp"
withDefaults(defineProps<{ online?: boolean; reconnecting?: boolean; compact?: boolean }>(), { online: false, reconnecting: false, compact: false })
</script>

<template>
  <img :src="rustyLogo" class="rusty-mark" :class="{ 'is-online': online, 'is-reconnecting': reconnecting, 'is-compact': compact }" alt="Rusty" width="32" height="40" />
</template>

<style scoped>
.rusty-mark:not(.is-compact) { flex-basis: 48px; width: 48px; height: 60px; }
.rusty-mark.is-compact { flex-basis: 40px; width: 40px; height: 50px; }
@media (max-width: 600px) {
  .rusty-mark:not(.is-compact) { flex-basis: 44px; width: 44px; height: 55px; }
}
</style>
