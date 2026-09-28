<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue"
import { keeperApi, type KeeperWorkspace, type KeeperPairing, type KeeperPairingStatus } from "../app/keeperApi"

const props = defineProps<{
  ownedWorkspaces: KeeperWorkspace[]
  provisionKeeper: (pairing: KeeperPairing) => Promise<KeeperPairingStatus>
}>()
const open = ref(false)
const originInput = ref("")
const status = ref<"idle" | "loading" | "found" | "error" | "creating" | "pairing" | "approved" | "provisioning" | "active" | "rejected" | "expired">("idle")
const error = ref("")
const discovery = ref<Awaited<ReturnType<typeof keeperApi.discover>> | null>(null)
const selectedWorkspaceIds = ref<string[]>([])
const eligibleWorkspaces = ref<KeeperWorkspace[]>([])
const ineligibleWorkspaces = ref<KeeperWorkspace[]>([])
const pairing = ref<KeeperPairing | null>(null)
const controllerApproved = ref(false)
let pollTimer: ReturnType<typeof setTimeout> | undefined
let provisioning = false

const selectedWorkspaces = () => eligibleWorkspaces.value.filter(workspace => selectedWorkspaceIds.value.includes(workspace.id))

async function discover() {
  error.value = ""
  discovery.value = null
  status.value = "loading"
  try {
    discovery.value = await keeperApi.discover(originInput.value)
    eligibleWorkspaces.value = await keeperApi.eligibleWorkspaces(props.ownedWorkspaces)
    ineligibleWorkspaces.value = props.ownedWorkspaces.filter(workspace => !eligibleWorkspaces.value.some(eligible => eligible.id === workspace.id))
    selectedWorkspaceIds.value = eligibleWorkspaces.value.map(workspace => workspace.id)
    status.value = "found"
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not discover this Lighthouse service."
    status.value = "error"
  }
}

async function requestPairing() {
  if (!discovery.value) return
  error.value = ""
  status.value = "creating"
  try {
    pairing.value = await keeperApi.beginPairing(discovery.value, selectedWorkspaces())
    status.value = "pairing"
    scheduleStatusCheck()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not start keeper pairing."
    status.value = "found"
  }
}

async function decide(approve: boolean) {
  if (!pairing.value) return
  error.value = ""
  try {
    await keeperApi.decidePairing(pairing.value, approve)
    controllerApproved.value = approve
    if (!approve) status.value = "rejected"
    else await checkStatus()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not record controller decision."
  }
}

function scheduleStatusCheck() {
  clearTimeout(pollTimer)
  if (!pairing.value || !["pairing", "approved", "provisioning"].includes(status.value)) return
  pollTimer = setTimeout(() => { void checkStatus() }, 1800)
}

async function provision() {
  if (!pairing.value || provisioning) return
  provisioning = true
  error.value = ""
  status.value = "provisioning"
  try {
    const result = await props.provisionKeeper(pairing.value)
    status.value = result === "active" ? "active" : result === "pending" ? "pairing" : "provisioning"
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Provisioning is pending. Retry after checking service state."
    status.value = "provisioning"
  } finally {
    provisioning = false
    scheduleStatusCheck()
  }
}

async function checkStatus() {
  if (!pairing.value) return
  try {
    const current: KeeperPairingStatus = await keeperApi.pairingStatus(pairing.value)
    if (current === "rejected") status.value = "rejected"
    else if (current === "expired") status.value = "expired"
    else if (current === "approved") {
      status.value = "approved"
      await provision()
    } else if (current === "provisioning") {
      status.value = "provisioning"
      await provision()
    } else if (current === "active") status.value = "active"
    else status.value = "pairing"
  } catch (cause) {
    if (pairing.value.expiresAt <= Math.floor(Date.now() / 1000)) status.value = "expired"
    else error.value = cause instanceof Error ? cause.message : "Could not verify keeper pairing status."
  }
  scheduleStatusCheck()
}

function close() {
  open.value = false
  status.value = "idle"
  error.value = ""
  discovery.value = null
  pairing.value = null
  eligibleWorkspaces.value = []
  ineligibleWorkspaces.value = []
  controllerApproved.value = false
  clearTimeout(pollTimer)
}

onBeforeUnmount(() => clearTimeout(pollTimer))
</script>

<template>
  <section class="sync-section keeper-discovery" aria-label="Keeper discovery">
    <p class="sync-section-copy">Self-hosted Lighthouse</p>
    <button v-if="!open" class="button" type="button" @click="open = true">Add keeper</button>
    <div v-else class="keeper-discovery-form">
      <label class="pairing-paste">
        <span>Keeper hostname</span>
        <input v-model="originInput" type="url" autocomplete="url" placeholder="keeper.example.com" aria-label="Keeper hostname" @keydown.enter.prevent="discover" />
      </label>
      <div v-if="!pairing" class="dialog-actions">
        <button class="button button-primary" type="button" :disabled="status === 'loading' || !originInput.trim()" @click="discover">{{ status === 'loading' ? "Discovering…" : "Discover keeper" }}</button>
        <button class="button button-quiet" type="button" @click="close">Cancel</button>
      </div>
      <p v-if="error" class="sync-error" role="alert">{{ error }}</p>
      <section v-if="discovery" class="mesh-member-action" aria-label="Discovered keeper">
        <h3>{{ discovery.displayName }}</h3>
        <p class="dialog-copy">{{ discovery.origin }}</p>
        <p><span class="detail-label">Fingerprint</span><br /><code>{{ discovery.fingerprint }}</code></p>
        <p class="dialog-copy">Service identity: {{ discovery.personId }}. Discovery alone does not authenticate service ownership.</p>
        <p class="dialog-copy">Capabilities: {{ discovery.capabilities.modes.join(", ") }} mode; documents {{ discovery.capabilities.documentReplication ? "yes" : "no" }}; chat {{ discovery.capabilities.chatReplication ? "yes" : "no" }}; attachments {{ discovery.capabilities.blobReplication ? "yes" : "no" }}.</p>
        <p v-if="eligibleWorkspaces.length" class="sync-section-copy">Boards with verified owner proof</p>
        <div v-if="eligibleWorkspaces.length" class="sync-workspace-list">
          <label v-for="workspace in eligibleWorkspaces" :key="workspace.id" class="sync-checkbox-item">
            <input v-model="selectedWorkspaceIds" type="checkbox" :value="workspace.id" :aria-label="`Keeper board: ${workspace.title}`" />
            <span>{{ workspace.title }}<small class="sync-workspace-detail">Replicate · visitor access</small></span>
          </label>
        </div>
        <p v-else class="dialog-copy">No board has verified owner proof here. Open Sync on an owned board and retry.</p>
        <p v-if="ineligibleWorkspaces.length" class="dialog-copy">{{ ineligibleWorkspaces.map(workspace => workspace.title).join(", ") }} lack stored, Rust-verified scope genesis. Legacy proof backfill remains outstanding; pairing stays disabled for these boards.</p>
        <p v-if="discovery.capabilities.pairing !== true" class="dialog-copy" role="status">This keeper has no pairing endpoint. Discovery did not connect or grant access.</p>
        <button v-if="!pairing" class="button button-primary" type="button" :disabled="discovery.capabilities.pairing !== true || !selectedWorkspaceIds.length || status === 'creating'" @click="requestPairing">{{ status === "creating" ? "Starting request…" : "Request keeper access" }}</button>
        <section v-if="pairing" class="mesh-member-action" aria-label="Keeper pairing state">
          <p><span class="detail-label">Comparison code</span><br /><strong>{{ pairing.comparisonCode }}</strong></p>
          <p><span class="detail-label">Controller fingerprint</span><br /><code>{{ pairing.controllerFingerprint }}</code></p>
          <p class="dialog-copy">Compare code with keeper operator before approving. Request expires {{ new Date(pairing.expiresAt * 1000).toLocaleString() }}.</p>
          <a class="button button-quiet" :href="pairing.operatorUrl" target="_blank" rel="noopener noreferrer">Open operator approval</a>
          <p class="dialog-copy" role="status">{{ status === "rejected" ? "Pairing rejected. No access granted." : status === "expired" ? "Pairing expired. No access granted." : status === "active" ? "All selected boards activated and saved by Lighthouse." : status === "provisioning" ? "Both sides approved. Lighthouse is joining and saving every selected board; access remains pending until all boards commit." : status === "approved" ? "Both sides approved. Starting the selected-board join…" : controllerApproved ? "Awaiting operator approval. No access granted." : "Awaiting both approvals. No access granted." }}</p>
          <div v-if="status === 'pairing' && !controllerApproved" class="dialog-actions">
            <button class="button button-primary" type="button" @click="decide(true)">Code matches · approve</button>
            <button class="button button-quiet" type="button" @click="decide(false)">Decline</button>
          </div>
          <button v-if="status === 'provisioning' && error" class="button button-primary" type="button" :disabled="provisioning" @click="provision">Retry board setup</button>
        </section>
      </section>
    </div>
  </section>
</template>
