<script setup lang="ts">
import type { SyncPhase } from "../sync/useDeviceSync"

defineProps<{
  phase: SyncPhase
  title: string
  qrCode: string
  inviteUrl: string
  copyNotice: string
  error: string
}>()

const emit = defineEmits<{ dismiss: []; stop: []; copy: []; join: [invite: string]; connect: [] }>()

function joinPastedInvite(event: ClipboardEvent) {
  const invite = event.clipboardData?.getData("text")?.trim()
  if (invite) emit("join", invite)
}

function selectPairingLink(event: FocusEvent | MouseEvent) {
  ;(event.target as HTMLTextAreaElement).select()
}
</script>

<template>
  <div class="overlay" @click.self="$emit('dismiss')">
    <section class="dialog sync-dialog" role="dialog" aria-modal="true" aria-label="Device sync">
      <div class="dialog-head">
        <div><span class="eyebrow">Device sync</span><h2>{{ title }}</h2></div>
        <button class="icon-button" type="button" aria-label="Close" @click="$emit('dismiss')">×</button>
      </div>

      <template v-if="phase === 'preparing'">
        <div class="pairing-qr pairing-qr-loading" aria-label="Preparing pairing QR code"></div>
        <p class="dialog-copy">Preparing your pairing QR…</p>
      </template>

      <template v-else-if="phase === 'ready' || phase === 'synced'">
        <img :src="qrCode" alt="Pairing QR code" class="pairing-qr" />
        <p class="dialog-copy">Scan this with your other device. Keep both tabs open until they sync.</p>
        <div class="dialog-actions"><button class="button button-quiet" type="button" @click="$emit('copy')">Copy pairing link</button></div>
        <p v-if="copyNotice" class="sync-success" role="status">{{ copyNotice }}</p>
        <label class="pairing-paste"><span>Pairing link</span><textarea aria-label="Pairing link" rows="2" readonly :value="inviteUrl" @focus="selectPairingLink" @click="selectPairingLink"></textarea></label>
        <label v-if="phase === 'ready'" class="pairing-paste"><span>Or paste a pairing link</span><textarea rows="2" placeholder="Paste and pair" @paste="joinPastedInvite"></textarea></label>
        <p v-if="phase === 'synced'" class="sync-success" role="status">Live sync is on. Changes appear in both tabs.</p>
        <div v-if="phase === 'synced'" class="dialog-actions"><button class="button button-quiet" type="button" @click="$emit('stop')">Stop live sync</button></div>
      </template>

      <template v-else-if="phase === 'joining'">
        <div class="pairing-qr pairing-qr-loading" aria-hidden="true"></div>
        <p class="dialog-copy">Pairing your devices…</p>
      </template>

      <template v-else-if="phase === 'join-ready'">
        <p class="dialog-copy">Invite received. Connect when this browser is ready to join the mesh.</p>
        <div class="dialog-actions"><button class="button button-primary" type="button" @click="$emit('connect')">Connect to mesh</button></div>
      </template>

      <template v-else-if="phase === 'error'">
        <p class="sync-error" role="alert">{{ error }}</p>
      </template>
    </section>
  </div>
</template>
