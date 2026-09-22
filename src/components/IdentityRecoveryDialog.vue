<script setup lang="ts">
import { computed, ref } from "vue"
import ModalLayer from "./ModalLayer.vue"
import { createIdentityRecovery, restoreIdentityRecovery, type IdentityRecoveryEnvelope, type IdentitySecurity } from "../domain/identity"

const props = defineProps<{ beforeRestore: () => Promise<void>; displayName: string }>()
const emit = defineEmits<{ close: []; restored: [] }>()
const security = ref<IdentitySecurity>("better")
const words = ref("")
const generated = ref<IdentityRecoveryEnvelope | null>(null)
const envelopeText = ref("")
const replace = ref(false)
const error = ref("")
const busy = ref(false)
const wordCount = computed(() => security.value === "insane" ? 24 : 12)

function downloadEnvelope(envelope: IdentityRecoveryEnvelope) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = "match-identity-recovery.json"
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 2_000)
}

async function generate() {
  busy.value = true; error.value = ""
  try {
    const backup = await createIdentityRecovery(security.value)
    words.value = backup.recoveryKey
    generated.value = backup.recoveryEnvelope
    downloadEnvelope(backup.recoveryEnvelope)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "Could not create recovery backup" }
  finally { busy.value = false }
}

async function restore() {
  busy.value = true; error.value = ""
  try {
    const envelope = JSON.parse(envelopeText.value) as IdentityRecoveryEnvelope
    await restoreIdentityRecovery(envelope, words.value, props.displayName, replace.value, props.beforeRestore)
    emit("restored")
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "Could not restore identity" }
  finally { busy.value = false }
}
</script>

<template>
  <ModalLayer class="overlay-level-120" @close="emit('close')">
    <section class="dialog" role="dialog" aria-modal="true" aria-label="Identity recovery">
      <div class="dialog-head"><div><span class="eyebrow">Account recovery</span><h2>Back up or restore your identity</h2></div><button class="icon-button" type="button" aria-label="Close" @click="emit('close')">×</button></div>
      <p class="dialog-copy">Your recovery file and words restore your Match identity, not workspace or board content. Keep both somewhere safe and separate.</p>
      <section class="mesh-member-action">
        <h3>Create a backup</h3>
        <label>Recovery words <select v-model="security"><option value="better">12 words</option><option value="insane">24 words</option></select></label>
        <button class="button button-primary" type="button" :disabled="busy" @click="generate">Generate and download recovery file</button>
        <p v-if="generated" class="dialog-copy"><strong>Write down these {{ wordCount }} words now:</strong><br><code class="recovery-words">{{ words }}</code><br>The encrypted recovery file was downloaded.</p>
      </section>
      <section class="mesh-member-action">
        <h3>Restore from a backup</h3>
        <label>Recovery words<textarea v-model="words" rows="3" autocomplete="off" /></label>
        <label>Recovery file<input type="file" accept="application/json" @change="async event => { const file = (event.target as HTMLInputElement).files?.[0]; if (file) envelopeText = await file.text() }" /></label>
        <label><input v-model="replace" type="checkbox" /> I understand this can replace the identity on this device. My local board data stays here.</label>
        <button class="button button-danger" type="button" :disabled="busy || !replace" @click="restore">Restore identity</button>
      </section>
      <p v-if="error" class="sync-error" role="alert">{{ error }}</p>
    </section>
  </ModalLayer>
</template>
