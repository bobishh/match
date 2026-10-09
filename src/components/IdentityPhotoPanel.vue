<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, ref, type Component } from "vue"
import { AVATAR_MAX_SOURCE_BYTES } from "../avatarCrop"
const AvatarCropDialog = defineAsyncComponent<Component>(() => import("./AvatarCropDialog.vue"))
const props = defineProps<{ avatarData?: string; saveAvatar: (value: string | null) => Promise<void> }>()
const avatarError = ref("")
const avatarSourceUrl = ref("")
const avatarDraft = ref("")
const cropping = ref(false)
const avatarSaving = ref(false)

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

async function cropped(value: string) {
  avatarDraft.value = value
  cropping.value = false
  discardSource()
  await persistAvatar(value)
}

async function persistAvatar(value: string | null) {
  if (avatarSaving.value) return
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
    <section class="mesh-member-action identity-avatar-form" aria-label="Identity photo">
      <h3>Your photo</h3>
      <p class="dialog-copy">One photo for your identity, shared with people in your workspaces.</p>
      <img v-if="avatarDraft || avatarData" class="participant-avatar participant-avatar-photo identity-avatar-preview" :src="avatarDraft || avatarData" alt="Your profile photo" />
      <div class="identity-avatar-actions">
        <label class="button" for="identity-avatar-file">Choose photo</label>
        <input id="identity-avatar-file" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" :disabled="avatarSaving" @change="choosePhoto" />
        <button v-if="avatarDraft" class="button button-primary" type="button" :disabled="avatarSaving" @click="persistAvatar(avatarDraft)">Retry save</button>
        <button v-else-if="avatarData" class="button button-danger" type="button" :disabled="avatarSaving" @click="persistAvatar(null)">Remove photo</button>
      </div>
      <p v-if="avatarError" class="sync-error" role="alert">{{ avatarError }}</p>
      <p v-if="avatarSaving" role="status">Saving photo…</p>
      <AvatarCropDialog v-if="cropping && avatarSourceUrl" :source-url="avatarSourceUrl" @save="cropped" @cancel="cancelCrop" />
    </section>
</template>
<style scoped>
.identity-avatar-preview { width: 96px; height: 96px; border-radius: 50%; object-fit: cover; }
.identity-avatar-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.identity-avatar-actions .button { min-height: 42px; }
</style>
