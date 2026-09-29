<script setup lang="ts">
defineProps<{ label: string; uppercase?: boolean }>()
</script>

<template>
  <h1>MATCH <span class="brand-separator">//</span> <span class="workspace-heading">{{ uppercase ? label.toUpperCase() : label }}</span></h1>
</template>
