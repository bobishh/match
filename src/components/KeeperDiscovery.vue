<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue"
import { keeperApi, type KeeperWorkspace, type KeeperPairing, type KeeperPairingStatus, type KeeperDetails } from "../app/keeperApi"
import type { MeshMemberView } from "../ui/deviceInfo"
import LighthouseMark from "./LighthouseMark.vue"

const props = defineProps<{
  ownedWorkspaces: KeeperWorkspace[]
  keepers: MeshMemberView[]
  provisionKeeper: (pairing: KeeperPairing) => Promise<KeeperPairingStatus>
  removeKeeper?: (personId: string) => Promise<void>
}>()
const emit = defineEmits<{ (event: "viewChange", view: "list" | "form" | "detail"): void }>()
const view = ref<"list" | "form" | "detail">("list")
const selectedKeeperId = ref("")
const keeperDetails = ref<KeeperDetails | null>(null)
const confirmRemoval = ref(false)
const removingKeeper = ref(false)
const removalError = ref("")
const originInput = ref("")
const status = ref<"idle" | "loading" | "found" | "error" | "creating" | "pairing" | "approved" | "provisioning" | "active" | "rejected" | "expired">("idle")
const error = ref("")
const discovery = ref<Awaited<ReturnType<typeof keeperApi.discover>> | null>(null)
const selectedWorkspaceIds = ref<string[]>([])
const futureBoards = ref(true)
const eligibleWorkspaces = ref<KeeperWorkspace[]>([])
const pairing = ref<KeeperPairing | null>(null)
const controllerApproved = ref(false)
const flowEpoch = ref(0)
let pollTimer: ReturnType<typeof setTimeout> | undefined
let provisioning = false

const selectedWorkspaces = () => eligibleWorkspaces.value.filter(workspace => selectedWorkspaceIds.value.includes(workspace.id))
const selectedKeeper = () => props.keepers.find(keeper => keeper.personId === selectedKeeperId.value)
const pendingPairing = () => pairing.value && ["pairing", "approved", "provisioning"].includes(status.value)

async function openKeeper(personId: string) {
  selectedKeeperId.value = personId
  keeperDetails.value = null
  confirmRemoval.value = false
  removalError.value = ""
  showView("detail")
  try {
    const details = await keeperApi.keeperDetails(personId)
    if (selectedKeeperId.value === personId && view.value === "detail") keeperDetails.value = details
  } catch {
    if (selectedKeeperId.value === personId && view.value === "detail") keeperDetails.value = null
  }
}

function showView(next: "list" | "form" | "detail") {
  if (next === "list") confirmRemoval.value = false
  view.value = next
  emit("viewChange", next)
}

async function removeSelectedKeeper() {
  if (!selectedKeeperId.value || !props.removeKeeper || removingKeeper.value) return
  removingKeeper.value = true
  removalError.value = ""
  try {
    await props.removeKeeper(selectedKeeperId.value)
    selectedKeeperId.value = ""
    keeperDetails.value = null
    confirmRemoval.value = false
    showView("list")
  } catch (cause) {
    removalError.value = cause instanceof Error ? cause.message : "Could not remove keeper"
  } finally {
    removingKeeper.value = false
  }
}

function resetFlow() {
  flowEpoch.value += 1
  status.value = "idle"
  error.value = ""
  discovery.value = null
  eligibleWorkspaces.value = []
  pairing.value = null
  controllerApproved.value = false
  provisioning = false
  selectedKeeperId.value = ""
  keeperDetails.value = null
  clearTimeout(pollTimer)
}

async function discover() {
  const epoch = flowEpoch.value
  error.value = ""
  discovery.value = null
  status.value = "loading"
  try {
    const found = await keeperApi.discover(originInput.value)
    const eligible = await keeperApi.eligibleWorkspaces(props.ownedWorkspaces)
    if (epoch !== flowEpoch.value) return
    discovery.value = found
    eligibleWorkspaces.value = eligible
    selectedWorkspaceIds.value = eligibleWorkspaces.value.map(workspace => workspace.id)
    status.value = "found"
    showView("detail")
  } catch (cause) {
    if (epoch !== flowEpoch.value) return
    error.value = cause instanceof Error ? cause.message : "Could not discover this Lighthouse service."
    status.value = "error"
  }
}

async function requestPairing() {
  if (!discovery.value) return
  const epoch = flowEpoch.value
  const currentDiscovery = discovery.value
  error.value = ""
  status.value = "creating"
  try {
    const created = await keeperApi.beginPairing(currentDiscovery, selectedWorkspaces(), futureBoards.value)
    if (epoch !== flowEpoch.value) return
    pairing.value = created
    status.value = "pairing"
    scheduleStatusCheck()
  } catch (cause) {
    if (epoch !== flowEpoch.value) return
    error.value = cause instanceof Error ? cause.message : "Could not start keeper pairing."
    status.value = "found"
  }
}

async function decide(approve: boolean) {
  if (!pairing.value) return
  const epoch = flowEpoch.value
  const currentPairing = pairing.value
  error.value = ""
  try {
    await keeperApi.decidePairing(currentPairing, approve)
    if (epoch !== flowEpoch.value) return
    controllerApproved.value = approve
    if (!approve) status.value = "rejected"
    else await checkStatus()
  } catch (cause) {
    if (epoch !== flowEpoch.value) return
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
  const epoch = flowEpoch.value
  const currentPairing = pairing.value
  provisioning = true
  error.value = ""
  status.value = "provisioning"
  try {
    const result = await props.provisionKeeper(currentPairing)
    if (epoch !== flowEpoch.value) return
    status.value = result === "active" ? "active" : result === "pending" ? "pairing" : "provisioning"
  } catch (cause) {
    if (epoch !== flowEpoch.value) return
    error.value = cause instanceof Error ? cause.message : "Provisioning is pending. Retry after checking service state."
    status.value = "provisioning"
  } finally {
    if (epoch === flowEpoch.value) {
      provisioning = false
      scheduleStatusCheck()
    }
  }
}

async function checkStatus() {
  if (!pairing.value) return
  const epoch = flowEpoch.value
  const currentPairing = pairing.value
  try {
    const current: KeeperPairingStatus = await keeperApi.pairingStatus(currentPairing)
    if (epoch !== flowEpoch.value || pairing.value !== currentPairing) return
    if (current === "rejected") status.value = "rejected"
    else if (current === "expired") status.value = "expired"
    else if (current === "approved") { status.value = "approved"; await provision() }
    else if (current === "provisioning") { status.value = "provisioning"; await provision() }
    else if (current === "active") status.value = "active"
    else status.value = "pairing"
  } catch (cause) {
    if (epoch !== flowEpoch.value || pairing.value !== currentPairing) return
    if (currentPairing.expiresAt <= Math.floor(Date.now() / 1000)) status.value = "expired"
    else error.value = cause instanceof Error ? cause.message : "Could not verify keeper pairing status."
  }
  scheduleStatusCheck()
}

function backToList() {
  if (pairing.value) {
    showView("list")
    return
  }
  resetFlow()
  originInput.value = ""
  showView("list")
}

function startAddKeeper() {
  if (pairing.value) resetFlow()
  originInput.value = ""
  showView("form")
}

onBeforeUnmount(() => clearTimeout(pollTimer))
</script>

<template>
  <section class="sync-section keeper-discovery" aria-label="Keepers">
    <template v-if="view === 'list'">
      <p class="sync-section-copy">Keepers</p>
      <div v-if="keepers.length" class="keeper-list" role="list" aria-label="Keeper services">
        <button v-for="keeper in keepers" :key="keeper.personId" class="keeper-row" type="button" @click="openKeeper(keeper.personId)">
          <span class="keeper-dot" :data-state="keeper.online ? 'online' : keeper.reconnecting ? 'reconnecting' : 'offline'" aria-hidden="true"></span>
          <span class="keeper-row-copy"><strong>{{ keeper.name }}</strong><small>{{ keeper.role }} · {{ keeper.online ? 'Connected' : keeper.reconnecting ? 'Reconnecting' : 'Offline' }}</small></span>
          <span aria-hidden="true">›</span>
        </button>
      </div>
      <div v-if="pendingPairing()" class="keeper-list" role="list" aria-label="Pending keeper requests">
        <button class="keeper-row" type="button" @click="showView('detail')">
          <span class="keeper-dot" data-state="reconnecting" aria-hidden="true"></span>
          <span class="keeper-row-copy"><strong>{{ discovery?.displayName ?? "Lighthouse" }}</strong><small>Approval pending · no access yet</small></span>
          <span aria-hidden="true">›</span>
        </button>
      </div>
      <p v-if="!keepers.length" class="keeper-empty">No keepers connected to this board.</p>
      <button class="button button-primary" type="button" :disabled="Boolean(pendingPairing())" @click="startAddKeeper">Add keeper</button>
    </template>

    <div v-else-if="view === 'form'" class="keeper-replacement" aria-label="Add keeper form">
      <div class="keeper-panel-head"><h3>Add keeper</h3><button class="button button-quiet" type="button" @click="backToList">Back</button></div>
      <label class="pairing-paste">
        <span>Keeper hostname</span>
        <input v-model="originInput" type="url" autocomplete="url" placeholder="keeper.example.com" aria-label="Keeper hostname" @keydown.enter.prevent="discover" />
      </label>
      <div class="dialog-actions">
        <button class="button button-primary" type="button" :disabled="status === 'loading' || !originInput.trim()" @click="discover">{{ status === 'loading' ? "Discovering…" : "Discover keeper" }}</button>
        <button class="button button-quiet" type="button" @click="backToList">Cancel</button>
      </div>
      <p v-if="error" class="sync-error" role="alert">{{ error }}</p>
    </div>

    <div v-else class="keeper-replacement" aria-label="Keeper details">
      <div class="keeper-panel-head">
        <h3>{{ discovery?.displayName ?? selectedKeeper()?.name ?? "Lighthouse" }}</h3>
        <button class="button button-quiet" type="button" @click="discovery ? backToList() : showView('list')">Back</button>
      </div>
      <p v-if="discovery" class="keeper-summary">Service identity {{ discovery.personId }} · {{ discovery.origin }}</p>
      <template v-if="discovery">
        <p v-if="error && !pairing" class="sync-error" role="alert">{{ error }}</p>
        <p v-if="eligibleWorkspaces.length" class="sync-section-copy">Boards</p>
        <div v-if="eligibleWorkspaces.length" class="sync-workspace-list">
          <label v-for="workspace in eligibleWorkspaces" :key="workspace.id" class="sync-checkbox-item">
            <input v-model="selectedWorkspaceIds" type="checkbox" :value="workspace.id" :aria-label="`Keeper board: ${workspace.title}`" :disabled="Boolean(pairing)" />
            <span>{{ workspace.title }}<small class="sync-workspace-detail">Visitor access</small></span>
          </label>
        </div>
        <p v-else class="dialog-copy">No eligible owned boards found.</p>
        <label v-if="eligibleWorkspaces.length && !pairing" class="sync-checkbox-item">
          <input v-model="futureBoards" type="checkbox" aria-label="Also replicate my future boards" />
          <span>Include future boards</span>
        </label>
        <p v-if="discovery.capabilities.pairing !== true" class="dialog-copy" role="status">This service cannot accept keeper requests.</p>
        <button v-if="!pairing" class="button button-primary" type="button" :disabled="discovery.capabilities.pairing !== true || !selectedWorkspaceIds.length || status === 'creating'" @click="requestPairing">{{ status === "creating" ? "Starting request…" : "Request access" }}</button>
        <section v-if="pairing" class="keeper-pairing" aria-label="Keeper pairing state">
          <p class="keeper-code"><span class="detail-label">Comparison code</span><strong>{{ pairing.comparisonCode }}</strong></p>
          <p class="dialog-copy">Both the operator and owner must approve this code before access begins.</p>
          <p class="dialog-copy" role="status">{{ status === "rejected" ? "Pairing rejected. No access granted." : status === "expired" ? "Pairing expired. No access granted." : status === "active" ? "All selected boards activated and saved by Lighthouse." : status === "provisioning" ? "Both sides approved. Lighthouse is saving boards; access remains pending." : status === "approved" ? "Both sides approved. Starting board setup…" : controllerApproved ? "Waiting for operator approval. No access granted." : "Waiting for both approvals. No access granted." }}</p>
          <a class="button button-quiet" :href="pairing.operatorUrl" target="_blank" rel="noopener noreferrer">Open operator approval</a>
          <div v-if="status === 'pairing' && !controllerApproved" class="dialog-actions">
            <button class="button button-primary" type="button" @click="decide(true)">Code matches · approve</button>
            <button class="button button-quiet" type="button" @click="decide(false)">Decline</button>
          </div>
          <button v-if="status === 'provisioning' && error" class="button button-primary" type="button" :disabled="provisioning" @click="provision">Retry board setup</button>
          <p v-if="error" class="sync-error" role="alert">{{ error }}</p>
        </section>
      </template>
      <template v-else-if="selectedKeeper()">
        <p class="keeper-summary">{{ selectedKeeper()!.role }} · {{ selectedKeeper()!.online ? 'Connected' : selectedKeeper()!.reconnecting ? 'Reconnecting' : 'Offline' }}</p>
        <p v-if="keeperDetails?.origin" class="keeper-summary">{{ keeperDetails.origin }}</p>
        <p v-if="keeperDetails?.futureBoards" class="keeper-summary">Includes future boards</p>
        <p v-if="keeperDetails" class="sync-section-copy">Boards</p>
        <ul v-if="keeperDetails" class="keeper-devices"><li v-for="board in ownedWorkspaces.filter(workspace => keeperDetails?.boardIds.includes(workspace.id))" :key="board.id">{{ board.title }}</li></ul>
        <ul class="keeper-devices"><li v-for="device in selectedKeeper()!.deviceList" :key="device.deviceId"><LighthouseMark :online="device.online" :reconnecting="device.reconnecting" />{{ device.name }} · {{ device.online ? 'Connected' : device.reconnecting ? 'Reconnecting' : 'Offline' }}</li></ul>
        <div v-if="removeKeeper" class="keeper-removal">
          <button v-if="!confirmRemoval" class="button button-danger" type="button" @click="confirmRemoval = true">Remove keeper</button>
          <template v-else>
            <p class="dialog-copy">Remove access from all owned boards?</p>
            <div class="dialog-actions">
              <button class="button button-danger" type="button" :disabled="removingKeeper" @click="removeSelectedKeeper">{{ removingKeeper ? 'Removing keeper…' : 'Remove access from all boards' }}</button>
              <button class="button button-quiet" type="button" :disabled="removingKeeper" @click="confirmRemoval = false">Cancel</button>
            </div>
          </template>
          <p v-if="removalError" class="sync-error" role="alert">{{ removalError }}</p>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.keeper-list { display: grid; gap: 8px; }
.keeper-row { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: center; gap: 12px; width: 100%; min-height: 58px; padding: 10px 12px; border: 2px solid var(--line); background: white; color: var(--ink); text-align: left; cursor: pointer; }
.keeper-row:hover { background: var(--yellow); }
.keeper-row-copy { min-width: 0; display: grid; gap: 4px; }
.keeper-row-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.keeper-row small { color: var(--muted); font: 750 .68rem/1.2 ui-monospace, monospace; text-transform: uppercase; }
.keeper-dot { width: 10px; height: 10px; border: 2px solid var(--ink); border-radius: 50%; background: var(--red); }
.keeper-dot[data-state="online"] { background: var(--green); }
.keeper-dot[data-state="reconnecting"] { background: var(--yellow); }
.keeper-empty { margin: 0; padding: 12px; border: 1px dashed var(--soft); color: var(--muted); }
.keeper-replacement { display: grid; gap: 12px; }
.keeper-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.keeper-panel-head h3 { margin: 0; }
.keeper-summary { margin: 0; color: var(--muted); font-size: .8rem; overflow-wrap: anywhere; }
.keeper-code { display: grid; gap: 6px; margin: 0; padding: 12px; border: 2px solid var(--line); background: var(--yellow); }
.keeper-code strong { font: 900 1.5rem/1 ui-monospace, monospace; letter-spacing: .12em; }
.keeper-pairing { display: grid; gap: 10px; padding-top: 12px; border-top: 1px solid var(--soft); }
.keeper-pairing p { margin: 0; }
.keeper-removal { display: grid; gap: 10px; padding-top: 12px; border-top: 1px solid var(--soft); }
.keeper-removal p { margin: 0; }
.keeper-devices { display: grid; gap: 8px; margin: 0; padding-left: 18px; color: var(--muted); }
.keeper-devices li { display: flex; align-items: center; gap: 8px; }
.keeper-replacement .pairing-paste { margin-top: 0; }
.keeper-replacement .pairing-paste input { width: 100%; min-height: 44px; padding: 10px 12px; border: 2px solid var(--line); color: var(--ink); font: 600 .9rem/1.3 ui-monospace, monospace; text-transform: none; letter-spacing: 0; }
.keeper-replacement .sync-workspace-list { display: grid; gap: 8px; max-height: 220px; margin: 0; overflow-y: auto; }
.keeper-replacement .sync-checkbox-item { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 9px 12px; border: 2px solid var(--line); background: white; cursor: pointer; font-weight: 750; }
.keeper-replacement .sync-checkbox-item:has(input:checked) { background: var(--yellow); }
.keeper-replacement .sync-workspace-detail { display: block; overflow-wrap: anywhere; font-size: .75rem; font-weight: 400; }
</style>
