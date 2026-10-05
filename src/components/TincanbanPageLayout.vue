<script setup lang="ts">
defineProps<{ busy?: boolean }>()
</script>

<template>
  <main class="shell" :aria-busy="busy">
    <header class="topbar"><slot name="header" /></header>
    <slot />
  </main>
</template>
