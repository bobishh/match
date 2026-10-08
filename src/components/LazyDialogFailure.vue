<script setup lang="ts">
defineProps<{ error?: Error }>()
defineEmits<{ (event: "cancel"): void }>()

function reload() { window.location.reload() }
</script>

<template>
  <section class="lazy-dialog-failure" role="alertdialog" aria-label="Dialog failed to load">
    <p role="alert">Dialog could not load. Dismiss it or reload app.</p>
    <button type="button" class="button button-quiet" @click="$emit('cancel')">Dismiss</button>
    <button type="button" class="button button-primary" @click="reload">Reload</button>
  </section>
</template>
