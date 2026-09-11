<script setup lang="ts">
import ModalLayer from "./ModalLayer.vue"
import { computed, ref } from "vue"
import type { SyncStep } from "../sync/useDeviceSync"

const props = defineProps<{
  pendingJoins?: { id: string; name: string; personId: string; role: "visitor" | "editor" }[]
  step: SyncStep
  title: string
  qrCode: string
  inviteUrl: string
  copyNotice: string
  error: string
  enrollmentDeviceName?: string
  authCode?: string
  invitationWorkspaceTitle?: string
  invitationWorkspaces?: { id: string; title: string }[]
  availableWorkspaces?: { id: string; title: string }[]
  selectedWorkspaceIds?: string[]
  selectedWorkspaceId?: string
  meshMembers?: Array<{
    personId: string
    name: string
    role: "owner" | "editor" | "visitor"
    online: boolean
    devices: number
    self: boolean
  }>
  hasMesh?: boolean
  currentPersonId?: string
  currentRole?: "owner" | "editor" | "visitor"
  succession?: {
    successorPersonId: string | null
    eligibleEditorPersonIds: string[]
    votes: Array<{ voterPersonId: string; candidatePersonId: string }>
    quorum: number
  }
  canClaimSuccession?: boolean
  canManageMesh?: boolean
  transferringOwnership?: string
  meshActionError?: string
  workspaceConnected?: boolean
  meshDiagnostic?: string
  live?: boolean
}>()

const emit = defineEmits<{
  (e: "decideJoin", id: string, approve: boolean): void
  (e: "dismiss"): void
  (e: "selectSyncAll"): void
  (e: "selectSyncWorkspace"): void
  (e: "update:selectedWorkspaceIds", val: string[]): void
  (e: "update:selectedWorkspaceId", val: string): void
  (e: "generateWorkspaceInvite"): void
  (e: "transferOwnership", personId: string): void
  (e: "leaveMesh"): void
  (e: "setSuccessor", personId: string | null): void
  (e: "voteSuccessor", personId: string): void
  (e: "claimSuccession"): void
  (e: "copy", url?: string): void
  (e: "requestEnrollment"): void
  (e: "approveDevice"): void
  (e: "declineDevice"): void
  (e: "acceptAndJoin"): void
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
const selectedMemberId = ref("")
const confirmingLeave = ref(false)
const selectedMember = computed(() => props.meshMembers?.find(member => member.personId === selectedMemberId.value))
const currentVote = computed(() => props.succession?.votes.find(vote => vote.voterPersonId === props.currentPersonId))

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
      <template v-if="step === 'members'">
        <p class="dialog-copy mesh-connection-summary" role="status">
          <strong>{{ workspaceConnected ? "Connected" : "Offline" }}</strong>
          · {{ workspaceConnected ? "Live channel active." : "No live channel. Reconnecting automatically." }}
        </p>
        <p v-if="!workspaceConnected && meshDiagnostic && (meshMembers || []).some(member => !member.self)" class="sync-error" role="status">Reconnect: {{ meshDiagnostic }}</p>
        <p class="dialog-copy">People and devices trusted by {{ invitationWorkspaceTitle || "this workspace" }}.</p>
        <div class="mesh-member-list" role="list" aria-label="Mesh members">
          <button
            v-for="member in (meshMembers || [])"
            :key="member.personId"
            class="mesh-member"
            :class="{ 'is-selected': selectedMemberId === member.personId }"
            type="button"
            :aria-pressed="selectedMemberId === member.personId"
            @click="selectedMemberId = member.personId"
          >
            <span class="mesh-member-presence" :class="member.online ? 'is-online' : 'is-offline'" aria-hidden="true"></span>
            <span class="mesh-member-name"><strong>{{ member.name }}</strong><small>{{ member.devices }} {{ member.devices === 1 ? 'device' : 'devices' }}{{ member.self ? ' · You' : '' }}</small></span>
            <span class="mesh-member-role">{{ member.personId === succession?.successorPersonId ? 'successor' : member.role }}</span>
          </button>
          <p v-if="!(meshMembers || []).length" class="mesh-member-empty">No mesh members yet.</p>
        </div>

        <section v-if="selectedMember" class="mesh-member-action" aria-label="Selected mesh member">
          <strong>{{ selectedMember.name }}</strong>
          <p v-if="canManageMesh && selectedMember.role !== 'owner' && !selectedMember.online" class="dialog-copy">This member must be online before ownership can move.</p>
          <p v-else-if="canManageMesh && selectedMember.role !== 'owner'" class="dialog-copy">They become owner. You keep editor access.</p>
          <button
            v-if="canManageMesh && selectedMember.role !== 'owner'"
            class="button button-danger"
            type="button"
            :disabled="!selectedMember.online || Boolean(transferringOwnership)"
            @click="emit('transferOwnership', selectedMember.personId)"
          >{{ transferringOwnership === selectedMember.personId ? 'Transferring…' : 'Transfer ownership' }}</button>
          <button
            v-if="canManageMesh && selectedMember.role === 'editor' && selectedMember.personId !== succession?.successorPersonId"
            class="button" type="button" @click="emit('setSuccessor', selectedMember.personId)"
          >Name successor</button>
          <button
            v-if="canManageMesh && selectedMember.personId === succession?.successorPersonId"
            class="button" type="button" @click="emit('setSuccessor', null)"
          >Remove named successor</button>
          <button
            v-if="currentRole === 'editor' && selectedMember.role === 'editor' && !currentVote"
            class="button" type="button" @click="emit('voteSuccessor', selectedMember.personId)"
          >Vote for {{ selectedMember.self ? 'yourself' : selectedMember.name }}</button>
          <p v-if="currentRole === 'editor' && currentVote" class="dialog-copy">Vote recorded for {{ (meshMembers || []).find(member => member.personId === currentVote?.candidatePersonId)?.name || 'an editor' }}.</p>
        </section>
        <section v-if="hasMesh" class="sync-section" aria-label="Ownership succession">
          <p class="sync-section-copy">Ownership succession</p>
          <p v-if="succession" class="dialog-copy">
            <template v-if="succession.successorPersonId">Named successor: {{ (meshMembers || []).find(member => member.personId === succession?.successorPersonId)?.name || 'Unavailable member' }}.</template>
            <template v-else>Editor quorum: {{ succession.quorum }} of {{ succession.eligibleEditorPersonIds.length }}.</template>
          </p>
          <p v-if="succession && currentRole === 'editor'" class="dialog-copy">
            Votes for you: {{ succession.votes.filter(vote => vote.candidatePersonId === currentPersonId).length }} / {{ succession.quorum }}.
          </p>
          <p v-if="!succession" class="dialog-copy">No recovery policy. Owner must enable editor quorum or name a successor.</p>
          <button v-if="canManageMesh && !succession" class="button" type="button" @click="emit('setSuccessor', null)">Enable editor quorum</button>
          <button v-if="canClaimSuccession" class="button button-danger" type="button" @click="emit('claimSuccession')">Claim ownership</button>
        </section>
        <p v-if="meshActionError" class="sync-error" role="alert">{{ meshActionError }}</p>
        <section v-if="confirmingLeave" class="mesh-member-action" aria-label="Leave mesh confirmation">
          <strong>Leave this workspace mesh?</strong>
          <p class="dialog-copy">Workspace data stays on this device. Trusted peers, access grant, and automatic sync are removed.</p>
          <div class="dialog-actions">
            <button class="button button-danger" type="button" @click="emit('leaveMesh'); confirmingLeave = false">Leave mesh, keep copy</button>
            <button class="button button-quiet" type="button" @click="confirmingLeave = false">Cancel</button>
          </div>
        </section>
        <div class="dialog-actions sync-primary-actions">
          <button v-if="canManageMesh" class="button button-primary" type="button" @click="emit('selectSyncWorkspace')">Add someone</button>
          <button class="button button-quiet" type="button" @click="emit('dismiss')">Close</button>
          <button v-if="live" class="button button-quiet" type="button" @click="emit('stop')">Stop live sync</button>
          <button v-if="hasMesh" class="button button-danger" type="button" @click="confirmingLeave = true">Leave mesh</button>
        </div>
      </template>
      <!-- Step: Direct Workspace Selection (supersedes former preliminary chooser) -->
      <template v-else-if="step === 'workspace-select' || step === 'workspace-host-select' || step === 'chooser'">
        <p class="dialog-copy">Invite another person. Choose workspaces; select their role when they request access.</p>
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
          <p class="sync-section-copy">Your own device only. Uses your identity and Owner access to workspaces you own.</p>
          <button
            class="sync-section-action"
            type="button"
            aria-label="Add my device"
            @click="emit('selectSyncAll')"
          >
            <span>Add my device</span>
            <small>Your identity</small>
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
        <div v-if="step === 'enroll-host-pending'" class="approval-card">
          <p class="dialog-copy">{{ enrollmentDeviceName }} requests your identity and Owner access.</p>
          <span class="detail-label">Authentication code</span>
          <div class="auth-code">{{ authCode }}</div>
          <p class="dialog-copy sync-help">Verify this code matches on your second device before approving.</p>
          <button class="button button-primary" type="button" @click="emit('approveDevice')">Approve device</button>
          <button class="button" type="button" @click="emit('declineDevice')">Decline device</button>
        </div>
      </template>

      <!-- Step 2: Enroll host completed -->
      <template v-else-if="step === 'enroll-host-done'">
        <p class="sync-success sync-result" role="status">Device enrolled</p>
        <p class="dialog-copy">Your device has received your workspaces. Changes sync automatically.</p>
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
        <p class="dialog-copy">Add this device to the identity of your other device. You receive Owner access to the workspaces it owns. Existing boards stay saved on this device. The identity changes only after approval on your other device.</p>
        <div class="dialog-actions sync-step-actions">
          <button class="button button-primary" type="button" @click="emit('requestEnrollment')">Add this device</button>
        </div>
      </template>

      <!-- Step 6: Enroll guest waiting -->
      <template v-else-if="step === 'enroll-guest-waiting'">
        <p class="dialog-copy sync-step-title">Waiting for approval</p>
        <p class="dialog-copy sync-help">Confirm that this code matches on your primary device:</p>
        <div class="auth-code">{{ authCode }}</div>
        <button class="button" type="button" @click="emit('stop')">Cancel</button>
      </template>

      <template v-else-if="step === 'enroll-syncing'">
        <p role="status" class="dialog-copy">Approved. Saving workspaces and connecting…</p>
      </template>

      <!-- Step 7: Enroll guest done -->
      <template v-else-if="step === 'enroll-guest-done'">
        <p class="sync-success sync-result" role="status">Device enrolled</p>
        <p class="dialog-copy">Your workspaces are saved on this device. Changes sync automatically.</p>
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

      <template v-else-if="step === 'workspace-merge-confirm'">
        <p class="dialog-copy">A local copy of {{ invitationWorkspaceTitle || "this workspace" }} already exists.</p>
        <p class="dialog-copy">Existing local changes and incoming workspace history will be merged.</p>
        <div class="dialog-actions sync-step-actions">
          <button class="button button-primary" type="button" @click="emit('acceptAndJoin')">Merge and join</button>
          <button class="button button-quiet" type="button" @click="emit('dismiss')">Cancel</button>
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
.mesh-member-list { display: grid; gap: 8px; max-height: 300px; margin: 16px 0; overflow-y: auto; }
.mesh-member { width: 100%; min-height: 58px; display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 10px 12px; border: 2px solid var(--line); background: white; color: var(--ink); text-align: left; }
.mesh-member:not(:disabled) { cursor: pointer; }
.mesh-member:disabled { opacity: 1; }
.mesh-member.is-selected { background: var(--yellow); box-shadow: 3px 3px 0 var(--ink); transform: translate(-2px, -2px); }
.mesh-member-presence { width: 10px; height: 10px; border: 2px solid var(--ink); border-radius: 50%; background: var(--red); }
.mesh-member-presence.is-online { background: var(--green); }
.mesh-member-name { min-width: 0; display: grid; gap: 4px; }
.mesh-member-name strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mesh-member-name small, .mesh-member-role { color: var(--muted); font: 800 .64rem/1.2 ui-monospace, monospace; letter-spacing: .06em; text-transform: uppercase; }
.mesh-member-action { display: grid; gap: 10px; padding: 14px; border: 2px solid var(--line); background: var(--panel); }
.mesh-member-action p { margin: 0; }
.mesh-member-action .button { justify-self: start; }
.mesh-member-empty { margin: 0; padding: 16px; border: 2px dashed var(--soft); color: var(--muted); }
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
