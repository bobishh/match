<script setup lang="ts">
import { ref, watch } from "vue"
import ModalLayer from "./ModalLayer.vue"
import { renameIdentity } from "../domain/identity"

const props = defineProps<{ displayName: string }>()
const emit = defineEmits<{ close: []; saved: []; recovery: [] }>()
const name = ref(props.displayName)
const saving = ref(false)
const error = ref("")

watch(() => props.displayName, value => { name.value = value })

async function save() {
  const value = name.value.trim()
  if (!value || saving.value) return
  saving.value = true
  error.value = ""
  try {
    await renameIdentity(value)
    emit("saved")
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not save identity name"
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <ModalLayer @close="emit('close')">
    <section class="dialog" role="dialog" aria-modal="true" aria-label="Settings">
      <div class="dialog-head"><div><span class="eyebrow">Identity</span><h2>Settings</h2></div><button class="icon-button" type="button" aria-label="Close" @click="emit('close')">×</button></div>
      <form class="mesh-member-action" @submit.prevent="save">
        <h3>Your name</h3>
        <label>Name<input v-model="name" maxlength="256" :disabled="saving" /></label>
        <button class="button button-primary" type="submit" :disabled="saving || !name.trim()">Save name</button>
      </form>
      <section class="mesh-member-action" aria-label="Identity recovery">
        <h3>Identity recovery</h3>
        <p class="dialog-copy">Create an encrypted identity backup or restore one on this device.</p>
        <button class="button" type="button" @click="emit('recovery')">Recovery backup</button>
      </section>
      <p v-if="error" class="sync-error" role="alert">{{ error }}</p>
    </section>
  </ModalLayer>
</template>
