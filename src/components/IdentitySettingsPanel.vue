<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, ref, watch, type Component } from "vue"
import { AVATAR_MAX_SOURCE_BYTES } from "../avatarCrop"

const AvatarCropDialog = defineAsyncComponent<Component>(() => import("./AvatarCropDialog.vue"))

const props = defineProps<{ displayName: string; avatarData?: string; saveName: (value: string) => Promise<void>; saveAvatar?: (value: string | null) => Promise<void> }>()
const emit = defineEmits<{ recovery: [] }>()
const name = ref(props.displayName)
const saving = ref(false)
const error = ref("")
const avatarError = ref("")
const avatarSourceUrl = ref("")
const avatarDraft = ref("")
const cropping = ref(false)
const avatarSaving = ref(false)

watch(() => props.displayName, value => { name.value = value })

async function save() {
  const value = name.value.trim()
  if (!value || saving.value) return
  saving.value = true
  error.value = ""
  try {
    await props.saveName(value)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not save identity name"
  } finally {
    saving.value = false
  }
}

function discardSource() {
  if (avatarSourceUrl.value) URL.revokeObjectURL(avatarSourceUrl.value)
  avatarSourceUrl.value = ""
}

function choosePhoto(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ""
  avatarError.value = ""
  if (!file) return
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { avatarError.value = "Choose a PNG, JPEG, or WebP photo"; return }
  if (file.size > AVATAR_MAX_SOURCE_BYTES) { avatarError.value = "Photo is too large to crop"; return }
  discardSource()
  avatarSourceUrl.value = URL.createObjectURL(file)
  cropping.value = true
}

function cancelCrop() {
  cropping.value = false
  discardSource()
}

function cropped(value: string) {
  avatarDraft.value = value
  cropping.value = false
  discardSource()
}

async function persistAvatar(value: string | null) {
  if (!props.saveAvatar || avatarSaving.value) return
  avatarSaving.value = true
  avatarError.value = ""
  try {
    await props.saveAvatar(value)
    avatarDraft.value = ""
  } catch (cause) {
    avatarError.value = cause instanceof Error ? cause.message : "Could not save profile photo"
  } finally { avatarSaving.value = false }
}

onBeforeUnmount(discardSource)
</script>

<template>
  <section aria-label="Identity settings">
    <form class="mesh-member-action identity-name-form" @submit.prevent="save">
      <h3>Your name</h3>
      <label>Name<input v-model="name" maxlength="48" :disabled="saving" /></label>
      <button class="button button-primary" type="submit" :disabled="saving || !name.trim()">Save name</button>
    </form>
    <section v-if="saveAvatar" class="mesh-member-action identity-avatar-form" aria-label="Profile photo">
      <h3>Profile photo</h3>
      <p class="dialog-copy">Choose a crop. Saved photo is a small 128 × 128 image shared with this workspace.</p>
      <img v-if="avatarDraft || avatarData" class="participant-avatar participant-avatar-photo identity-avatar-preview" :src="avatarDraft || avatarData" alt="Your profile photo" />
      <div class="identity-avatar-actions">
        <label class="button" for="identity-avatar-file">Choose photo</label>
        <input id="identity-avatar-file" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" :disabled="avatarSaving" @change="choosePhoto" />
        <button v-if="avatarDraft" class="button button-primary" type="button" :disabled="avatarSaving" @click="persistAvatar(avatarDraft)">Save photo</button>
        <button v-else-if="avatarData" class="button button-danger" type="button" :disabled="avatarSaving" @click="persistAvatar(null)">Remove photo</button>
      </div>
      <p v-if="avatarError" class="sync-error" role="alert">{{ avatarError }}</p>
      <p v-if="avatarSaving" role="status">Saving photo…</p>
      <AvatarCropDialog v-if="cropping && avatarSourceUrl" :source-url="avatarSourceUrl" @save="cropped" @cancel="cancelCrop" />
    </section>
    <section class="mesh-member-action" aria-label="Identity recovery">
      <h3>Identity recovery</h3>
      <p class="dialog-copy">Create an encrypted identity backup or restore one on this device.</p>
      <button class="button" type="button" @click="emit('recovery')">Recovery backup</button>
    </section>
    <p v-if="error" class="sync-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.identity-name-form label { display: grid; gap: 7px; min-width: 0; }
.identity-name-form input, .identity-name-form .button { box-sizing: border-box; width: 100%; min-height: 46px; }
.identity-avatar-preview { width: 96px; height: 96px; border-radius: 50%; object-fit: cover; }
.identity-avatar-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.identity-avatar-actions .button { min-height: 42px; }
</style>
