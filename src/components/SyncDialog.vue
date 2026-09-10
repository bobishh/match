<script setup lang="ts">
import ModalLayer from "./ModalLayer.vue"
import { computed } from "vue"
import type { SyncStep } from "../sync/useDeviceSync"

const props = defineProps<{
  pendingJoins?: { id: string; name: string; personId: string; role: "visitor" | "editor" }[]
  step: SyncStep
  title: string
  qrCode: string
  inviteUrl: string
  copyNotice: string
  error: string
  authCode?: string
  invitationWorkspaceTitle?: string
  invitationWorkspaces?: { id: string; title: string }[]
  availableWorkspaces?: { id: string; title: string }[]
  selectedWorkspaceIds?: string[]
  selectedWorkspaceId?: string
}>()

const emit = defineEmits<{
  (e: "decideJoin", id: string, approve: boolean): void
  (e: "dismiss"): void
  (e: "selectSyncAll"): void
  (e: "selectSyncWorkspace"): void
  (e: "update:selectedWorkspaceIds", val: string[]): void
  (e: "update:selectedWorkspaceId", val: string): void
  (e: "generateWorkspaceInvite"): void
  (e: "copy", url?: string): void
  (e: "requestEnrollment"): void
  (e: "approveDevice"): void
  (e: "acceptAndJoin"): void
  (e: "connect"): void
  (e: "stop"): void
  (e: "export"): void
  (e: "import"): void
}>()

const selectedIds = computed(() => {
  if (props.selectedWorkspaceIds && props.selectedWorkspaceIds.length > 0) {
    return props.selectedWorkspaceIds
  }
  if (props.selectedWorkspaceId) {
    return [props.selectedWorkspaceId]
  }
  return []
})

const hasSelection = computed(() => selectedIds.value.length > 0)

function isWorkspaceSelected(id: string) {
  return selectedIds.value.includes(id)
}

function toggleWorkspace(id: string) {
  const current = [...selectedIds.value]
  const idx = current.indexOf(id)
  if (idx >= 0) {
    current.splice(idx, 1)
  } else {
    current.push(id)
  }
  emit("update:selectedWorkspaceIds", current)
  if (current.length > 0) {
    emit("update:selectedWorkspaceId", current[0])
  } else {
    emit("update:selectedWorkspaceId", "")
  }
}

const guestWorkspaces = computed(() => {
  if (props.invitationWorkspaces && props.invitationWorkspaces.length > 0) {
    return props.invitationWorkspaces
  }
  if (props.invitationWorkspaceTitle) {
    return [{ id: "ws_default", title: props.invitationWorkspaceTitle }]
  }
  return [{ id: "ws_default", title: "Workspace" }]
})

function selectPairingLink(event: FocusEvent | MouseEvent) {
  ;(event.target as HTMLTextAreaElement).select()
}
</script>

<template>
  <ModalLayer class="overlay" @close="emit('dismiss')">
    <section class="dialog sync-dialog" role="dialog" aria-modal="true" aria-label="Device sync">
      <div class="dialog-head">
        <div>
          <span class="eyebrow">Device sync</span>
          <h2>{{ title }}</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Close" @click="emit('dismiss')">×</button>
      </div>

      <section v-for="request in pendingJoins" :key="request.id" class="join-request" aria-label="Access request">
        <h3>{{ request.name }} wants to join</h3>
        <small>{{ request.personId.slice(0, 12) }}</small>
        <label>Role<select v-model="request.role" aria-label="Participant role"><option value="visitor">Visitor — view only</option><option value="editor">Editor — edit items</option></select></label>
        <div class="dialog-actions"><button class="button button-primary" @click="emit('decideJoin', request.id, true)">Approve access</button><button class="button" @click="emit('decideJoin', request.id, false)">Decline</button></div>
      </section>
      <!-- Step: Direct Workspace Selection (supersedes former preliminary chooser) -->
      <template v-if="step === 'workspace-select' || step === 'workspace-host-select' || step === 'chooser'">
        <p class="dialog-copy">Select which workspaces to include in this invitation:</p>
        <div class="sync-workspace-list">
          <label
            v-for="ws in (availableWorkspaces || [])"
            :key="ws.id"
            class="sync-checkbox-item"
          >
            <input
              type="checkbox"
              :aria-label="ws.title"
              :value="ws.id"
              :checked="isWorkspaceSelected(ws.id)"
              @change="toggleWorkspace(ws.id)"
            />
            <span>{{ ws.title }}</span>
          </label>
        </div>

        <div class="dialog-actions sync-primary-actions">
          <button
            class="button button-primary"
            type="button"
            aria-label="Generate link"
            :disabled="!hasSelection"
            @click="emit('generateWorkspaceInvite')"
          >
            Generate link
          </button>
          <button class="button button-quiet" type="button" aria-label="Cancel" @click="emit('dismiss')">Cancel</button>
        </div>

        <!-- Distinct Secondary Action: Add my device / Sync all -->
        <section class="sync-section">
          <p class="sync-section-copy">Add another device under your personal identity:</p>
          <button
            class="sync-section-action"
            type="button"
            aria-label="Sync all"
            @click="emit('selectSyncAll')"
          >
            <span>Add my device</span>
            <small>Sync all</small>
          </button>
        </section>

        <section class="sync-section">
          <p class="sync-section-copy">Move or back up this workspace:</p>
          <div class="dialog-actions sync-data-actions">
            <button class="button button-quiet" type="button" @click="emit('export')">Export .match</button>
            <button class="button button-quiet" type="button" @click="emit('import')">Import .match</button>
          </div>
        </section>
      </template>

      <!-- Step 1: Enroll host (Add my device) -->
      <template v-else-if="step === 'enroll-host' || step === 'enroll-host-pending'">
        <p class="dialog-copy sync-step-title">Add your second device</p>
        <img v-if="qrCode" :src="qrCode" alt="Pairing QR code" aria-label="Pairing QR code" class="pairing-qr" />
        <p class="dialog-copy">Scan this with your other device or copy the enrollment link below:</p>
        <div class="dialog-actions sync-wrap-actions">
          <button class="button button-primary" type="button" @click="emit('copy')">Copy enrollment link</button>
          <button class="button button-quiet" type="button" @click="emit('copy')">Copy pairing link</button>
        </div>
        <p v-if="copyNotice" class="sync-success" role="status">{{ copyNotice }}</p>
        <label class="pairing-paste">
          <span>Pairing link</span>
          <textarea aria-label="Pairing link" rows="2" readonly :value="inviteUrl" @focus="selectPairingLink" @click="selectPairingLink"></textarea>
        </label>

        <!-- Authentication code and approval -->
        <div v-if="authCode" class="approval-card">
          <span class="detail-label">Authentication code</span>
          <div class="auth-code">{{ authCode }}</div>
          <p class="dialog-copy sync-help">Verify this code matches on your second device before approving.</p>
          <button class="button button-primary" type="button" @click="emit('approveDevice')">Approve device</button>
        </div>
      </template>

      <!-- Step 2: Enroll host completed -->
      <template v-else-if="step === 'enroll-host-done'">
        <p class="sync-success sync-result" role="status">Device enrolled</p>
        <p class="dialog-copy">Your device is now securely connected to your personal account.</p>
        <div class="dialog-actions">
          <button class="button button-quiet" type="button" @click="emit('dismiss')">Close</button>
        </div>
      </template>

      <!-- Step 4: Workspace host invite display -->
      <template v-else-if="step === 'workspace-host'">
        <p class="dialog-copy sync-step-title">Invite someone</p>
        <img v-if="qrCode" :src="qrCode" alt="Pairing QR code" class="pairing-qr" />
        <div class="dialog-actions">
          <button class="button button-primary" type="button" @click="emit('copy')">Copy invite link</button>
        </div>
        <p v-if="copyNotice" class="sync-success" role="status">{{ copyNotice }}</p>
        <label class="pairing-paste">
          <span>Pairing link</span>
          <textarea aria-label="Pairing link" rows="2" readonly :value="inviteUrl" @focus="selectPairingLink" @click="selectPairingLink"></textarea>
        </label>
      </template>

      <!-- Step 5: Enroll guest request -->
      <template v-else-if="step === 'enroll-guest'">
        <p class="dialog-copy">Connect this device to your Match account.</p>
        <div class="dialog-actions sync-step-actions">
          <button class="button button-primary" type="button" @click="emit('requestEnrollment')">Request enrollment</button>
          <button class="button button-quiet" type="button" @click="emit('connect')">Connect to mesh</button>
        </div>
      </template>

      <!-- Step 6: Enroll guest waiting -->
      <template v-else-if="step === 'enroll-guest-waiting'">
        <p class="dialog-copy sync-step-title">Waiting for approval</p>
        <p class="dialog-copy sync-help">Confirm that this code matches on your primary device:</p>
        <div class="auth-code">{{ authCode }}</div>
      </template>

      <!-- Step 7: Enroll guest done -->
      <template v-else-if="step === 'enroll-guest-done'">
        <p class="sync-success sync-result" role="status">Device enrolled</p>
        <p class="dialog-copy">Your device is now securely enrolled.</p>
        <div class="dialog-actions">
          <button class="button button-quiet" type="button" @click="emit('dismiss')">Close</button>
        </div>
      </template>

      <!-- Step 8: Workspace guest join -->
      <template v-else-if="step === 'workspace-guest'">
        <p class="dialog-copy">You have been invited to join {{ invitationWorkspaceTitle || "Workspace" }}</p>
        <ul v-if="guestWorkspaces.length > 1" class="guest-workspace-list">
          <li v-for="ws in guestWorkspaces" :key="ws.id">
            {{ ws.title }}
          </li>
        </ul>
        <div class="dialog-actions sync-step-actions">
          <button class="button button-primary" type="button" @click="emit('acceptAndJoin')">Accept and join</button>
        </div>
      </template>

      <template v-else-if="step === 'workspace-guest-waiting'">
        <p class="dialog-copy" role="status">Waiting for owner approval, then receiving workspaces… Keep both devices open.</p>
        <div class="dialog-actions">
          <button class="button button-quiet" type="button" @click="emit('stop')">Cancel</button>
        </div>
      </template>

      <template v-else-if="step === 'workspace-reconnecting'">
        <p class="dialog-copy" role="status">Reconnecting automatically… Your changes are saved on this device.</p>
        <div class="dialog-actions">
          <button class="button button-quiet" type="button" @click="emit('dismiss')">Keep working</button>
          <button class="button button-quiet" type="button" @click="emit('stop')">Stop sync</button>
        </div>
      </template>

      <!-- Step 9: Workspace guest done -->
      <template v-else-if="step === 'workspace-guest-done'">
        <p class="sync-success sync-result" role="status">Connected to {{ invitationWorkspaceTitle || "Workspace" }}</p>
        <ul v-if="guestWorkspaces.length > 1" class="guest-workspace-list">
          <li v-for="ws in guestWorkspaces" :key="ws.id">
            {{ ws.title }}
          </li>
        </ul>
        <div class="dialog-actions">
          <button class="button button-quiet" type="button" @click="emit('dismiss')">Close</button>
        </div>
      </template>

      <!-- Step 10: Synced legacy -->
      <template v-else-if="step === 'synced'">
        <p class="sync-success" role="status">Live sync is on. Changes appear in both tabs.</p>
        <div class="dialog-actions">
          <button class="button button-primary" type="button" @click="emit('selectSyncWorkspace')">Invite peers</button>
          <button class="button button-quiet" type="button" @click="emit('stop')">Stop live sync</button>
        </div>
      </template>

      <!-- Step 11: Error -->
      <template v-else-if="step === 'error'">
        <p class="sync-error" role="alert">{{ error }}</p>
        <div class="dialog-actions sync-step-actions">
          <button class="button button-quiet" type="button" @click="emit('dismiss')">Dismiss</button>
        </div>
      </template>
    </section>
  </ModalLayer>
</template>

<style scoped>
.sync-workspace-list { display: grid; gap: 8px; max-height: 220px; margin: 16px 0; overflow-y: auto; }
.sync-checkbox-item { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 10px 12px; border: 2px solid var(--line); background: white; cursor: pointer; font-weight: 750; }
.sync-checkbox-item:has(input:checked) { background: var(--yellow); }
.sync-primary-actions { justify-content: flex-start; margin-top: 16px; }
.sync-section { display: grid; gap: 10px; margin-top: 20px; padding-top: 20px; border-top: 2px solid var(--line); }
.sync-section-copy { margin: 0; color: var(--muted); font: 800 .68rem/1.45 ui-monospace, monospace; letter-spacing: .06em; text-transform: uppercase; }
.sync-section-action { min-height: 52px; display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border: 2px solid var(--line); background: white; font-weight: 850; text-align: left; }
.sync-section-action:hover { background: var(--yellow); }
.sync-section-action small { color: var(--muted); font: 800 .65rem/1 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
.sync-data-actions { justify-content: flex-start; margin: 0; }
.sync-step-title { margin-bottom: 8px; font-weight: 700; }
.sync-wrap-actions { flex-wrap: wrap; }
.sync-step-actions { margin-top: 16px; }
.approval-card { margin-top: 16px; padding: 16px; border: 2px solid var(--line); background: white; }
.auth-code { margin: 10px 0; font: 900 1.5rem/1 ui-monospace, monospace; letter-spacing: .12em; }
.sync-help { margin-bottom: 12px; font-size: .85rem; }
.sync-result { font-size: 1.1rem; font-weight: 700; }
.guest-workspace-list { margin: 8px 0 16px 20px; padding: 0; }
.guest-workspace-list li { margin: 4px 0; font-weight: 650; }
</style>
