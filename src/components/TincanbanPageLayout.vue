<script setup lang="ts">
defineProps<{ busy?: boolean }>()
</script>

<template>
  <main class="shell" :aria-busy="busy">
    <header class="topbar" :inert="busy || undefined"><slot name="header" /></header>
    <slot />
  </main>
</template>
