<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { keeperApi, type KeeperWorkspace, type KeeperPairing, type KeeperPairingStatus, type KeeperDetails, type KeeperServiceDiscovery } from "../app/keeperApi"
import { keeperDisplayName, type MeshMemberView } from "../ui/deviceInfo"
import RustyMark from "./RustyMark.vue"

const props = defineProps<{
  ownedWorkspaces: KeeperWorkspace[]
  keepers: MeshMemberView[]
  provisionKeeper: (pairing: KeeperPairing) => Promise<KeeperPairingStatus>
  removeKeeper?: (personId: string, discovery?: KeeperServiceDiscovery, knownServiceDeviceIds?: string[]) => Promise<"removed" | "pending">
}>()
const emit = defineEmits<{ (event: "viewChange", view: "list" | "form" | "detail"): void }>()
const view = ref<"list" | "form" | "detail">("list")
const selectedKeeperId = ref("")
const retainedKeeper = ref<MeshMemberView | null>(null)
const pendingIntegrationKeepers = ref<MeshMemberView[]>([])
const pendingIntegrationLoadError = ref("")
const pendingIntegrationsLoaded = ref(false)
const displayedKeepers = computed(() => {
  const byPerson = new Map(props.keepers.map(keeper => [keeper.personId, keeper]))
  for (const pending of pendingIntegrationKeepers.value) {
    const current = byPerson.get(pending.personId)
    byPerson.set(pending.personId, current ? { ...current, pendingRemoval: true } : pending)
  }
  if (retainedKeeper.value && !byPerson.has(retainedKeeper.value.personId)) byPerson.set(retainedKeeper.value.personId, retainedKeeper.value)
  return [...byPerson.values()]
})
const keeperDetails = ref<KeeperDetails | null>(null)
const confirmRemoval = ref(false)
const removingKeeper = ref(false)
const removalError = ref("")
const removalPending = ref(false)
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
let keeperDetailsRequest = 0

const selectedWorkspaces = () => eligibleWorkspaces.value.filter(workspace => selectedWorkspaceIds.value.includes(workspace.id))
const selectedKeeper = () => displayedKeepers.value.find(keeper => keeper.personId === selectedKeeperId.value)
const pendingPairing = () => pairing.value && ["pairing", "approved", "provisioning"].includes(status.value)

async function openKeeper(personId: string) {
  const request = ++keeperDetailsRequest
  retainedKeeper.value = displayedKeepers.value.find(keeper => keeper.personId === personId) ?? null
  selectedKeeperId.value = personId
  keeperDetails.value = null
  confirmRemoval.value = false
  removalError.value = ""
  removalPending.value = false
  showView("detail")
  try {
    const details = await keeperApi.keeperDetails(personId)
    if (request === keeperDetailsRequest && selectedKeeperId.value === personId && view.value === "detail") {
      keeperDetails.value = details
      removalPending.value = details?.removalPending === true
      confirmRemoval.value = removalPending.value
    }
  } catch {
    if (request === keeperDetailsRequest && selectedKeeperId.value === personId && view.value === "detail") keeperDetails.value = null
  }
}

function showView(next: "list" | "form" | "detail") {
  if (next !== "detail") keeperDetailsRequest += 1
  if (next === "list") confirmRemoval.value = false
  view.value = next
  emit("viewChange", next)
}

async function removeSelectedKeeper() {
  if (!selectedKeeperId.value || !props.removeKeeper || removingKeeper.value) return
  removingKeeper.value = true
  removalError.value = ""
  try {
    const result = await props.removeKeeper(selectedKeeperId.value, undefined,
      selectedKeeper()?.deviceList.map(device => device.deviceId) ?? [])
    if (result === "pending") {
      removalPending.value = true
      keeperDetails.value = { ...(await keeperApi.keeperDetails(selectedKeeperId.value) ?? { boardIds: [], futureBoards: false }),
        removalPending: true, localRevocationComplete: true }
      await loadPendingIntegrationKeepers()
      return
    }
    const removedPersonId = selectedKeeperId.value
    pendingIntegrationKeepers.value = pendingIntegrationKeepers.value
      .filter(keeper => keeper.personId !== removedPersonId)
    selectedKeeperId.value = ""
    retainedKeeper.value = null
    keeperDetails.value = null
    confirmRemoval.value = false
    showView("list")
  } catch (cause) {
    removalError.value = cause instanceof Error ? cause.message : "Could not remove keeper"
    removalPending.value = true
    if (keeperDetails.value) keeperDetails.value = { ...keeperDetails.value, removalPending: true }
    await loadPendingIntegrationKeepers()
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
  removalPending.value = false
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
    error.value = cause instanceof Error ? cause.message : "Could not discover this Rusty keeper."
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
    const baselineWorkspaces = await keeperApi.eligibleWorkspaces(props.ownedWorkspaces)
    const selected = selectedWorkspaces()
    const baselineIds = baselineWorkspaces.map(workspace => workspace.id)
    if (selected.some(workspace => !baselineIds.includes(workspace.id))) {
      throw new Error("A selected board changed before approval. Discover Rusty again and choose current boards.")
    }
    const created = await keeperApi.beginPairing(currentDiscovery, selected, {
      futureBoards: futureBoards.value,
      futureBoardBaselineIds: baselineIds,
    })
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
    else if (current === "active") { error.value = ""; status.value = "active" }
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

async function loadPendingIntegrationKeepers() {
  pendingIntegrationLoadError.value = ""
  try {
    const references = await keeperApi.pendingRemovalReferences()
    pendingIntegrationKeepers.value = references.map((reference): MeshMemberView => {
        const deviceIds = "serviceDeviceIds" in reference
          ? reference.serviceDeviceIds
          : [reference.serviceDeviceId]
        const knownDeviceIds = (deviceIds?.length ? deviceIds : [reference.serviceDeviceId])
          .filter((deviceId): deviceId is string => typeof deviceId === "string" && deviceId.length > 0)
        return {
        personId: reference.servicePersonId,
        name: "Rusty keeper",
        role: "editor",
        online: false,
        reconnecting: false,
        onlineDevices: 0,
        devices: knownDeviceIds.length || 1,
        self: false,
        pendingRemoval: true,
        deviceList: knownDeviceIds.map(deviceId => ({ deviceId, name: "Rusty", online: false, reconnecting: false,
          lastSeen: reference.verifiedAt, userAgent: "mesh-lighthouse/1.0.0", description: "Rusty", tabs: 1 })),
      }
    })
  } catch (cause) {
    pendingIntegrationKeepers.value = []
    pendingIntegrationLoadError.value = cause instanceof Error ? cause.message : "Could not load saved keeper status."
  } finally {
    pendingIntegrationsLoaded.value = true
  }
}

onMounted(() => { void loadPendingIntegrationKeepers() })
onBeforeUnmount(() => clearTimeout(pollTimer))
</script>

<template>
  <section class="sync-section keeper-discovery" aria-label="Keepers">
    <template v-if="view === 'list'">
      <p class="sync-section-copy">Keepers</p>
      <div v-if="displayedKeepers.length" class="keeper-list" role="list" aria-label="Keeper services">
        <button v-for="keeper in displayedKeepers" :key="keeper.personId" class="keeper-row" type="button" @click="openKeeper(keeper.personId)">
          <span class="keeper-dot" :data-state="keeper.online ? 'online' : keeper.reconnecting ? 'reconnecting' : 'offline'" aria-hidden="true"></span>
          <span class="keeper-row-copy"><strong>{{ keeperDisplayName(keeper.name) }}</strong><small>Keeper · {{ keeper.pendingRemoval ? 'Removal pending' : keeper.online ? 'Connected' : keeper.reconnecting ? 'Reconnecting' : 'Offline' }}</small></span>
          <span aria-hidden="true">›</span>
        </button>
      </div>
      <div v-if="pendingPairing()" class="keeper-list" role="list" aria-label="Pending keeper requests">
        <button class="keeper-row" type="button" @click="showView('detail')">
          <span class="keeper-dot" data-state="reconnecting" aria-hidden="true"></span>
          <span class="keeper-row-copy"><strong>{{ keeperDisplayName(discovery?.displayName ?? "Rusty") }}</strong><small>Approval pending · no access yet</small></span>
          <span aria-hidden="true">›</span>
        </button>
      </div>
      <div v-if="pendingIntegrationLoadError" class="sync-error" role="alert" aria-label="Keeper integrations unavailable">
        <p>Saved keeper status could not be loaded: {{ pendingIntegrationLoadError }}</p>
        <button class="button" type="button" @click="loadPendingIntegrationKeepers">Retry loading keeper status</button>
      </div>
      <p v-else-if="pendingIntegrationsLoaded && !displayedKeepers.length" class="keeper-empty">No keepers connected to this board.</p>
      <button class="button button-primary keeper-add" type="button" :disabled="Boolean(pendingPairing())" @click="startAddKeeper"><RustyMark compact aria-hidden="true" />Add keeper</button>
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
        <h3>{{ keeperDisplayName(discovery?.displayName ?? selectedKeeper()?.name ?? "Rusty") }}</h3>
        <button class="button button-quiet" type="button" @click="discovery ? backToList() : showView('list')">Back</button>
      </div>
      <p v-if="discovery" class="keeper-summary">Service identity <code>{{ discovery.personId }}</code> · <code>{{ discovery.origin }}</code></p>
      <template v-if="discovery">
        <p v-if="error && !pairing" class="sync-error" role="alert">{{ error }}</p>
        <p v-if="eligibleWorkspaces.length" class="sync-section-copy">Boards</p>
        <div v-if="eligibleWorkspaces.length" class="sync-workspace-list">
          <label v-for="workspace in eligibleWorkspaces" :key="workspace.id" class="sync-checkbox-item">
            <input v-model="selectedWorkspaceIds" type="checkbox" :value="workspace.id" :aria-label="`Keeper board: ${workspace.title}`" :disabled="Boolean(pairing)" />
            <span>{{ workspace.title }}<small class="sync-workspace-detail">Editor access</small></span>
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
          <p class="dialog-copy" role="status">{{ status === "rejected" ? "Pairing rejected. No access granted." : status === "expired" ? "Pairing expired. No access granted." : status === "active" ? "All selected boards activated and saved by Rusty." : status === "provisioning" ? "Both sides approved. Rusty is saving boards; access remains pending." : status === "approved" ? "Both sides approved. Starting board setup…" : controllerApproved ? "Waiting for operator approval. No access granted." : "Waiting for both approvals. No access granted." }}</p>
          <a class="button button-quiet" :href="pairing.operatorUrl" target="_blank" rel="noopener noreferrer">Open operator approval</a>
          <div v-if="status === 'pairing' && !controllerApproved" class="dialog-actions">
            <button class="button button-primary" type="button" @click="decide(true)">Code matches · approve</button>
            <button class="button button-quiet" type="button" @click="decide(false)">Decline</button>
          </div>
          <button v-if="status === 'provisioning' && error" class="button button-primary" type="button" :disabled="provisioning" @click="provision">Retry board setup</button>
          <button v-if="status === 'expired' || status === 'rejected'" class="button button-primary" type="button" @click="startAddKeeper">Start new request</button>
          <p v-if="error" class="sync-error" role="alert">{{ error }}</p>
        </section>
      </template>
      <template v-else-if="selectedKeeper()">
        <p class="keeper-summary">Keeper · {{ selectedKeeper()!.online ? 'Connected' : selectedKeeper()!.reconnecting ? 'Reconnecting' : 'Offline' }}</p>
        <p v-if="keeperDetails?.origin" class="keeper-summary">{{ keeperDetails.origin }}</p>
        <p v-if="keeperDetails?.futureBoards" class="keeper-summary">Includes future boards</p>
        <p v-if="keeperDetails" class="sync-section-copy">Boards</p>
        <ul v-if="keeperDetails" class="keeper-devices"><li v-for="board in ownedWorkspaces.filter(workspace => keeperDetails?.boardIds.includes(workspace.id))" :key="board.id">{{ board.title }}</li></ul>
        <ul class="keeper-devices"><li v-for="device in selectedKeeper()!.deviceList" :key="device.deviceId"><RustyMark compact :online="device.online" :reconnecting="device.reconnecting" />{{ keeperDisplayName(device.name) }} · {{ device.online ? 'Connected' : device.reconnecting ? 'Reconnecting' : 'Offline' }}</li></ul>
        <div v-if="removeKeeper" class="keeper-removal">
          <template v-if="!keeperDetails?.integrationId">
            <button v-if="!confirmRemoval && !removalPending" class="button button-danger" type="button" @click="confirmRemoval = true">Remove keeper</button>
            <template v-else>
              <p class="dialog-copy">Revoke this keeper’s access to your boards and remove it from the list.</p>
              <p v-if="removalPending" class="dialog-copy" role="status" aria-label="Keeper removal status">Removal did not finish. Retry to revoke remaining access and remove this keeper.</p>
              <div class="dialog-actions">
                <button class="button button-danger" type="button" :disabled="removingKeeper" @click="removeSelectedKeeper">{{ removingKeeper ? 'Removing keeper…' : removalPending ? 'Retry removal' : 'Remove keeper now' }}</button>
                <button class="button button-quiet" type="button" :disabled="removingKeeper" @click="confirmRemoval = false">Cancel</button>
              </div>
            </template>
          </template>
          <template v-else>
            <button v-if="!confirmRemoval && !removalPending" class="button button-danger" type="button" @click="confirmRemoval = true">Remove keeper</button>
            <template v-if="confirmRemoval || removalPending">
              <p class="dialog-copy">{{ removalPending ? "Removal is still pending Rusty confirmation." : "Remove access from all boards still owned by this identity?" }}</p>
              <p v-if="removalPending" class="dialog-copy" role="status" aria-label="Keeper removal status">Remote removal is not confirmed. Retry removal.</p>
              <div class="dialog-actions">
                <button class="button button-danger" type="button" :disabled="removingKeeper" @click="removeSelectedKeeper">{{ removingKeeper ? 'Removing keeper…' : removalPending ? 'Retry removal' : 'Remove access from all boards' }}</button>
                <button class="button button-quiet" type="button" :disabled="removingKeeper" @click="confirmRemoval = false">Cancel</button>
              </div>
            </template>
          </template>
          <p v-if="removalError" class="sync-error" role="alert">{{ removalError }}</p>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.keeper-add { gap: 8px; }
.keeper-list { display: grid; gap: 8px; }
.keeper-row { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: center; gap: 12px; width: 100%; min-height: 58px; padding: 10px 12px; border: 2px solid var(--line); color: var(--ink); text-align: left; cursor: pointer; }
.keeper-row-copy { min-width: 0; display: grid; gap: 4px; }
.keeper-row-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.keeper-row small { color: var(--muted); font: 700 .8rem/1.2 var(--site-font-sans); text-transform: uppercase; }
.keeper-empty { margin: 0; padding: 12px; border: 1px dashed var(--soft); color: var(--muted); }
.keeper-replacement { display: grid; gap: 12px; }
.keeper-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.keeper-panel-head h3 { margin: 0; }
.keeper-summary { margin: 0; color: var(--muted); font-size: .8rem; overflow-wrap: anywhere; }
.keeper-code { display: grid; gap: 6px; margin: 0; padding: 12px; border: 2px solid var(--line); }
.keeper-code strong { font: 600 1.2rem/1.4 var(--site-font-mono); letter-spacing: .08em; }
.keeper-pairing { display: grid; gap: 10px; padding-top: 12px; border-top: 1px solid var(--soft); }
.keeper-pairing p { margin: 0; }
.keeper-removal { display: grid; gap: 10px; padding-top: 12px; border-top: 1px solid var(--soft); }
.keeper-removal p { margin: 0; }
.keeper-devices { display: grid; gap: 8px; margin: 0; padding-left: 18px; color: var(--muted); }
.keeper-devices li { display: flex; align-items: center; gap: 8px; }
.keeper-replacement .pairing-paste { margin-top: 0; }
.keeper-replacement .pairing-paste input { width: 100%; min-height: 44px; padding: 10px 12px; border: 2px solid var(--line); color: var(--ink); font: 400 .75rem/1.5 var(--site-font-mono); text-transform: none; letter-spacing: 0; }
.keeper-replacement .sync-workspace-list { display: grid; gap: 8px; max-height: 220px; margin: 0; overflow-y: auto; }
.keeper-replacement .sync-checkbox-item { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 9px 12px; border: 2px solid var(--line); cursor: pointer; font-weight: 700; }
.keeper-replacement .sync-workspace-detail { display: block; overflow-wrap: anywhere; font-size: .8rem; font-weight: 400; }
</style>
