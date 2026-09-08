<script setup lang="ts">
import type { SyncPhase } from "../sync/useDeviceSync"

defineProps<{
  phase: SyncPhase
  title: string
  qrCode: string
  error: string
}>()

const emit = defineEmits<{ close: []; copy: []; join: [invite: string] }>()

function joinPastedInvite(event: ClipboardEvent) {
  const invite = event.clipboardData?.getData("text")?.trim()
  if (invite) emit("join", invite)
}
</script>

<template>
  <div class="overlay" @click.self="$emit('close')">
    <section class="dialog sync-dialog" role="dialog" aria-modal="true" aria-label="Device sync">
      <div class="dialog-head">
        <div><span class="eyebrow">Device sync</span><h2>{{ title }}</h2></div>
        <button class="icon-button" type="button" aria-label="Close" @click="$emit('close')">×</button>
      </div>

      <template v-if="phase === 'preparing'">
        <div class="pairing-qr pairing-qr-loading" aria-label="Preparing pairing QR code"></div>
        <p class="dialog-copy">Preparing your pairing QR…</p>
      </template>

      <template v-else-if="phase === 'ready' || phase === 'synced'">
        <img :src="qrCode" alt="Pairing QR code" class="pairing-qr" />
        <p class="dialog-copy">Scan this with your other device. Keep both tabs open until they sync.</p>
        <div class="dialog-actions"><button class="button button-quiet" type="button" @click="$emit('copy')">Copy pairing link</button></div>
        <label v-if="phase === 'ready'" class="pairing-paste"><span>Or paste a pairing link</span><textarea rows="2" placeholder="Paste and pair" @paste="joinPastedInvite"></textarea></label>
        <p v-if="phase === 'synced'" class="sync-success" role="status">Workspace synced.</p>
      </template>

      <template v-else-if="phase === 'joining'">
        <div class="pairing-qr pairing-qr-loading" aria-hidden="true"></div>
        <p class="dialog-copy">Pairing your devices…</p>
      </template>

      <template v-else-if="phase === 'error'">
        <p class="sync-error" role="alert">{{ error }}</p>
      </template>
    </section>
  </div>
</template>
