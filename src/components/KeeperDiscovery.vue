<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, type Component } from "vue"
import { keeperApi, type KeeperWorkspace, type KeeperPairing, type KeeperPairingStatus, type KeeperDetails, type KeeperServiceDiscovery } from "../app/keeperApi"
import { pairingStatusTransition } from "../app/keeperWithdrawalUi"
import { keeperDisplayName, type MeshMemberView } from "../ui/deviceInfo"
import { keeperDotState, keeperRowStatus } from "../ui/keeperStatus"
import RustyMark from "./RustyMark.vue"
const KeeperDetailPanel = defineAsyncComponent(() => import("./KeeperDetailPanel.vue") as Promise<{ default: Component }>)

const props = defineProps<{
  ownedWorkspaces: KeeperWorkspace[]
  keepers: MeshMemberView[]
  provisionKeeper: (pairing: KeeperPairing) => Promise<KeeperPairingStatus>
  cancelKeeper: (pairing: KeeperPairing, operationId: string) => Promise<"cancel_pending" | "cancelled" | "orphan_resolved">
  removeKeeper?: (personId: string, discovery?: KeeperServiceDiscovery, knownServiceDeviceIds?: string[]) => Promise<"removed" | "pending">
  updateKeeperSettings?: (personId: string, futureBoards: boolean, removeWorkspaceIds: string[]) => Promise<"updated" | "pending">
  beginPolicyUpdate?: (personId: string, baselineWorkspaceIds: string[]) => Promise<KeeperPairing>
  activeWorkspaceId?: string
}>()
const emit = defineEmits<{ (event: "viewChange", view: "list" | "form" | "detail"): void }>()
const view = ref<"list" | "form" | "detail">("list")
const selectedKeeperId = ref("")
const retainedKeeper = ref<MeshMemberView | null>(null)
const pendingIntegrationKeepers = ref<MeshMemberView[]>([])
const savedIntegrationKeepers = ref<MeshMemberView[]>([])
const pendingIntegrationLoadError = ref("")
const pendingIntegrationsLoaded = ref(false)
const displayedKeepers = computed(() => {
  const byPerson = new Map(props.keepers.map(keeper => [keeper.personId, keeper]))
  for (const saved of savedIntegrationKeepers.value) {
    const current = byPerson.get(saved.personId)
    byPerson.set(saved.personId, current ? { ...current, integrationId: saved.integrationId,
      integrationRevision: saved.integrationRevision, integrationBoardIds: saved.integrationBoardIds,
      integrationAvailability: saved.integrationAvailability, integrationAvailabilityReason: saved.integrationAvailabilityReason } : saved)
  }
  for (const pending of pendingIntegrationKeepers.value) {
    const current = byPerson.get(pending.personId)
    byPerson.set(pending.personId, current ? { ...current, pendingRemoval: true } : pending)
  }
  return [...byPerson.values()]
})
const keeperDetails = ref<KeeperDetails | null>(null)
const confirmRemoval = ref(false)
const removingKeeper = ref(false)
const removalError = ref("")
const removalPending = ref(false)
const editingSettings = ref(false)
const settingsFutureBoards = ref(false)
const settingsRemoveWorkspaceIds = ref<string[]>([])
const settingsBusy = ref(false)
const settingsPending = ref(false)
const settingsStatus = ref("")
const settingsError = ref("")
const originInput = ref("")
const status = ref<"idle" | "loading" | "found" | "error" | "creating" | "pairing" | "approved" | "provisioning" | "active" | "rejected" | "expired" | "cancel_pending" | "cancelled" | "orphan_resolved">("idle")
const error = ref("")
const withdrawalOperationId = ref("")
const cancellingPairing = ref(false)
const pairingDismissed = ref(false)
const discovery = ref<Awaited<ReturnType<typeof keeperApi.discover>> | null>(null)
const selectedWorkspaceIds = ref<string[]>([])
const activeIntegrationWorkspaceIds = ref<string[]>([])
const futureBoards = ref(true)
const eligibleWorkspaces = ref<KeeperWorkspace[]>([])
const pairing = ref<KeeperPairing | null>(null)
const policyOnlyPairing = ref(false)
const controllerApproved = ref(false)
const flowEpoch = ref(0)
let statusObservationGeneration = 0
let pollTimer: ReturnType<typeof setTimeout> | undefined
let provisioning = false
let keeperDetailsRequest = 0
let keeperReferenceLoadGeneration = 0
let keeperDiscoveryUnmounted = false

const selectedWorkspaces = () => eligibleWorkspaces.value.filter(workspace => selectedWorkspaceIds.value.includes(workspace.id))
const selectedKeeper = () => displayedKeepers.value.find(keeper => keeper.personId === selectedKeeperId.value)
const selectedKeeperStatus = computed(() => {
  const keeper = selectedKeeper()
  return keeper ? keeperRowStatus(keeper, props.activeWorkspaceId) : ""
})
const currentPolicyBoardTitles = computed(() => (keeperDetails.value?.boardIds ?? [])
  .map(id => props.ownedWorkspaces.find(workspace => workspace.id === id)?.title ?? id))
const pendingPairing = () => pairing.value && ["pairing", "approved", "provisioning", "cancel_pending"].includes(status.value)
const isCurrentPairing = (epoch: number, current: KeeperPairing) => epoch === flowEpoch.value && pairing.value === current
const isCurrentStatusObservation = (epoch: number, current: KeeperPairing, generation: number) =>
  epoch === flowEpoch.value && pairing.value === current && generation === statusObservationGeneration
const isTerminalPairingStatus = (value: string) => ["active", "cancelled", "orphan_resolved", "rejected", "expired"].includes(value)
const fenceStatusObservations = () => { statusObservationGeneration += 1 }

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

function openIntegrationSettings() {
  if (!keeperDetails.value?.integrationId) return
  settingsFutureBoards.value = keeperDetails.value.futureBoards
  settingsRemoveWorkspaceIds.value = []
  settingsPending.value = false
  settingsStatus.value = ""
  settingsError.value = ""
  editingSettings.value = true
  policyOnlyPairing.value = false
}

function toggleSettingsRemoval(workspaceId: string, checked: boolean) {
  settingsRemoveWorkspaceIds.value = checked
    ? [...new Set([...settingsRemoveWorkspaceIds.value, workspaceId])]
    : settingsRemoveWorkspaceIds.value.filter(id => id !== workspaceId)
}

async function saveIntegrationSettings() {
  const { saveKeeperSettings } = await import("../app/keeperSettingsFlow")
  await saveKeeperSettings({ personId: selectedKeeperId.value, updateSettings: props.updateKeeperSettings,
    beginPolicyUpdate: props.beginPolicyUpdate, ownedWorkspaces: props.ownedWorkspaces, keeperDetails,
    settingsBusy, settingsError, settingsStatus, settingsPending, settingsFutureBoards, settingsRemoveWorkspaceIds,
    editingSettings, discovery, eligibleWorkspaces, activeWorkspaceIds: activeIntegrationWorkspaceIds,
    selectedWorkspaceIds, pairing, policyOnlyPairing, pairingDismissed, controllerApproved, status,
    showDetails: () => showView("detail"), refreshDetails: personId => keeperApi.keeperDetails(personId), scheduleStatusCheck })
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
    keeperReferenceLoadGeneration++
    savedIntegrationKeepers.value = savedIntegrationKeepers.value.filter(keeper => keeper.personId !== removedPersonId)
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
  fenceStatusObservations()
  status.value = "idle"
  error.value = ""
  discovery.value = null
  eligibleWorkspaces.value = []
  pairing.value = null
  policyOnlyPairing.value = false
  withdrawalOperationId.value = ""
  cancellingPairing.value = false
  pairingDismissed.value = false
  controllerApproved.value = false
  provisioning = false
  selectedKeeperId.value = ""
  retainedKeeper.value = null
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
    const integrationStatus = await keeperApi.integrationStatus(found)
    const existingIntegration = await keeperApi.selectCanonicalIntegration(found, integrationStatus.integrations)
    if (epoch !== flowEpoch.value) return
    discovery.value = found
    eligibleWorkspaces.value = eligible
    activeIntegrationWorkspaceIds.value = existingIntegration?.scopes.map(scope => scope.workspaceId) ?? []
    selectedWorkspaceIds.value = eligibleWorkspaces.value.map(workspace => workspace.id)
      .filter(workspaceId => !activeIntegrationWorkspaceIds.value.includes(workspaceId))
    futureBoards.value = existingIntegration?.futureBoards ?? true
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
    const created = await keeperApi.beginPairingAfterWithdrawalReconciliation(currentDiscovery, selected, {
      futureBoards: futureBoards.value,
      futureBoardBaselineIds: baselineIds,
    }, props.cancelKeeper, () => epoch === flowEpoch.value)
    if (epoch !== flowEpoch.value) return
    if (!created) return
    pairing.value = created
    policyOnlyPairing.value = false
    pairingDismissed.value = false
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
    if (!approve) {
      status.value = "rejected"
      fenceStatusObservations()
    }
    else await checkStatus()
  } catch (cause) {
    if (epoch !== flowEpoch.value) return
    error.value = cause instanceof Error ? cause.message : "Could not record controller decision."
  }
}

function scheduleStatusCheck() {
  clearTimeout(pollTimer)
  if (!pairing.value || !["pairing", "approved", "provisioning", "cancel_pending"].includes(status.value)) return
  pollTimer = setTimeout(() => { void checkStatus() }, 1800)
}

async function provision() {
  if (!pairing.value || provisioning || withdrawalOperationId.value) return
  const epoch = flowEpoch.value
  const currentPairing = pairing.value
  provisioning = true
  error.value = ""
  status.value = "provisioning"
  try {
    const result = await props.provisionKeeper(currentPairing)
    if (epoch !== flowEpoch.value) return
    if (withdrawalOperationId.value) { status.value = "cancel_pending"; return }
    status.value = result === "active" ? "active" : result === "pending" ? "pairing" : "provisioning"
    if (result === "active") fenceStatusObservations()
  } catch (cause) {
    if (epoch !== flowEpoch.value) return
    if (withdrawalOperationId.value) { status.value = "cancel_pending"; return }
    error.value = cause instanceof Error ? cause.message : "Provisioning is pending. Retry after checking service state."
    status.value = "provisioning"
  } finally {
    if (epoch === flowEpoch.value) {
      provisioning = false
      scheduleStatusCheck()
    }
  }
}

async function cancelKeeperRequest() {
  const currentPairing = pairing.value
  if (!currentPairing || cancellingPairing.value || status.value === "cancelled") return
  const epoch = flowEpoch.value
  const operationId = withdrawalOperationId.value || keeperApi.newOperationId()
  withdrawalOperationId.value = operationId
  cancellingPairing.value = true
  error.value = ""
  try {
    const result = await props.cancelKeeper(currentPairing, operationId)
    if (!isCurrentPairing(epoch, currentPairing)) return
    status.value = result
    if (isTerminalPairingStatus(result)) fenceStatusObservations()
    error.value = ""
  } catch (cause) {
    if (!isCurrentPairing(epoch, currentPairing)) return
    error.value = cause instanceof Error ? cause.message : "Could not confirm keeper request cancellation. Retry to check Rusty cleanup."
    // A lost response can follow a durable fence. Trust only a matching signed status.
    const latest = await keeperApi.withdrawalStatusAfterError(currentPairing, operationId)
    if (latest) {
      if (!isCurrentPairing(epoch, currentPairing)) return
      if (latest.withdrawal) {
        withdrawalOperationId.value = latest.withdrawal.operationId
        status.value = latest.withdrawal.status
        if (latest.withdrawal.status === "cancelled") {
          fenceStatusObservations()
          error.value = ""
        }
      }
    }
  } finally {
    if (epoch === flowEpoch.value) {
      cancellingPairing.value = false
      scheduleStatusCheck()
    }
  }
}

function dismissPendingPairing() {
  resetFlow()
  showView("list")
}

async function checkStatus() {
  if (!pairing.value) return
  const epoch = flowEpoch.value
  const observationGeneration = statusObservationGeneration
  const currentPairing = pairing.value
  try {
    const current = await keeperApi.pairingStatusInfo(currentPairing, withdrawalOperationId.value || undefined)
    if (!isCurrentStatusObservation(epoch, currentPairing, observationGeneration)) return
    const transition = pairingStatusTransition(current, Boolean(withdrawalOperationId.value))
    if (current.withdrawal) withdrawalOperationId.value = current.withdrawal.operationId
    if (transition.clearError) error.value = ""
    status.value = transition.status
    if (isTerminalPairingStatus(transition.status)) fenceStatusObservations()
    if (transition.provision) await provision()
  } catch (cause) {
    if (!isCurrentStatusObservation(epoch, currentPairing, observationGeneration)) return
    if (withdrawalOperationId.value) {
      status.value = "cancel_pending"
      error.value = cause instanceof Error ? cause.message : "Cancellation status unavailable. Retry cancellation to verify cleanup."
    } else if (currentPairing.expiresAt <= Math.floor(Date.now() / 1000)) { error.value = ""; status.value = "expired" }
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
  const generation = ++keeperReferenceLoadGeneration
  pendingIntegrationLoadError.value = ""
  try {
    const { loadKeeperReferenceViews } = await import("../app/keeperReferences")
    const earlyAvailability: Array<{ personId: string; integrationId: string; revision: number;
      state: "available" | "unavailable" | "needs-review"; reason?: string }> = []
    let viewsReady = false
    const applyAvailability = (personId: string, integrationId: string, revision: number,
      result: { state: "available" | "unavailable" | "needs-review"; reason?: string }) => {
      if (keeperDiscoveryUnmounted || generation !== keeperReferenceLoadGeneration) return
      savedIntegrationKeepers.value = savedIntegrationKeepers.value.map(keeper =>
        keeper.personId === personId && keeper.integrationId === integrationId && keeper.integrationRevision === revision
          ? { ...keeper, integrationAvailability: result.state, integrationAvailabilityReason: result.reason }
          : keeper)
    }
    const views = await loadKeeperReferenceViews((personId: string, integrationId: string, revision: number,
      result: { state: "available" | "unavailable" | "needs-review"; reason?: string }) => {
      if (!viewsReady) earlyAvailability.push({ personId, integrationId, revision, ...result })
      else applyAvailability(personId, integrationId, revision, result)
    })
    if (keeperDiscoveryUnmounted || generation !== keeperReferenceLoadGeneration) return
    savedIntegrationKeepers.value = views.saved
    pendingIntegrationKeepers.value = views.pending
    viewsReady = true
    for (const update of earlyAvailability) applyAvailability(update.personId, update.integrationId, update.revision, update)
  } catch (cause) {
    if (keeperDiscoveryUnmounted || generation !== keeperReferenceLoadGeneration) return
    pendingIntegrationKeepers.value = []
    savedIntegrationKeepers.value = []
    pendingIntegrationLoadError.value = cause instanceof Error ? cause.message : "Could not load saved keeper status."
  } finally {
    if (!keeperDiscoveryUnmounted && generation === keeperReferenceLoadGeneration) pendingIntegrationsLoaded.value = true
  }
}

onMounted(() => { void loadPendingIntegrationKeepers() })
onBeforeUnmount(() => { keeperDiscoveryUnmounted = true; keeperReferenceLoadGeneration++; clearTimeout(pollTimer) })
</script>

<template>
  <section class="sync-section keeper-discovery" aria-label="Keepers">
    <template v-if="view === 'list'">
      <p class="sync-section-copy">Keepers</p>
      <div v-if="displayedKeepers.length" class="keeper-list" role="list" aria-label="Keeper services">
        <button v-for="keeper in displayedKeepers" :key="keeper.personId" class="keeper-row" type="button" @click="openKeeper(keeper.personId)">
          <span class="keeper-dot" :data-state="keeperDotState(keeper)" aria-hidden="true"></span>
          <span class="keeper-row-copy"><strong>{{ keeperDisplayName(keeper.name) }}</strong><small :title="keeper.integrationAvailabilityReason">Keeper · {{ keeperRowStatus(keeper, activeWorkspaceId) }}</small></span>
          <span aria-hidden="true">›</span>
        </button>
      </div>
      <div v-if="pendingPairing() && !pairingDismissed" class="keeper-list" role="list" aria-label="Pending keeper requests">
        <button class="keeper-row" type="button" @click="showView('detail')">
          <span class="keeper-dot" data-state="reconnecting" aria-hidden="true"></span>
          <span class="keeper-row-copy"><strong>{{ keeperDisplayName(discovery?.displayName ?? "Rusty") }}</strong><small>{{ status === 'cancel_pending' ? 'Cancellation pending · retry available' : withdrawalOperationId ? 'Cancellation needs attention · retry available' : 'Approval pending · no access yet' }}</small></span>
          <span aria-hidden="true">›</span>
        </button>
      </div>
      <div v-if="pendingIntegrationLoadError" class="sync-error" role="alert" aria-label="Keeper integrations unavailable">
        <p>Saved keeper status could not be loaded: {{ pendingIntegrationLoadError }}</p>
        <button class="button" type="button" @click="loadPendingIntegrationKeepers">Retry loading keeper status</button>
      </div>
      <p v-else-if="pendingIntegrationsLoaded && !displayedKeepers.length && !pendingPairing() && !pairingDismissed && status !== 'cancelled'" class="keeper-empty">No keepers connected to this board.</p>
      <button class="button button-primary keeper-add" type="button" :disabled="status === 'creating' || cancellingPairing || Boolean(pendingPairing())" @click="startAddKeeper"><RustyMark compact aria-hidden="true" />Add keeper</button>
    </template>

    <KeeperDetailPanel
      v-else
      :form="view === 'form'"
      :origin-input="originInput"
      :status="status"
      :error="error"
      :discovery="discovery"
      :selected-keeper="selectedKeeper()"
      :selected-keeper-status="selectedKeeperStatus"
      :selected-keeper-status-reason="selectedKeeper()?.integrationAvailabilityReason ?? ''"
      :pairing="pairing"
      :policy-only-pairing="policyOnlyPairing"
      :current-policy-board-titles="currentPolicyBoardTitles"
      :eligible-workspaces="eligibleWorkspaces"
      :selected-workspace-ids="selectedWorkspaceIds"
      :active-integration-workspace-ids="activeIntegrationWorkspaceIds"
      :future-boards="futureBoards"
      :controller-approved="controllerApproved"
      :provisioning="provisioning"
      :pending-pairing="Boolean(pendingPairing())"
      :cancelling-pairing="cancellingPairing"
      :withdrawal-operation-id="withdrawalOperationId"
      :keeper-details="keeperDetails"
      :owned-workspaces="ownedWorkspaces"
      :settings-status="settingsStatus"
      :editing-settings="editingSettings"
      :settings-remove-workspace-ids="settingsRemoveWorkspaceIds"
      :settings-future-boards="settingsFutureBoards"
      :settings-busy="settingsBusy"
      :settings-pending="settingsPending"
      :settings-error="settingsError"
      :remove-keeper-available="Boolean(removeKeeper)"
      :confirm-removal="confirmRemoval"
      :removal-pending="removalPending"
      :removing-keeper="removingKeeper"
      :removal-error="removalError"
      @update:origin-input="originInput = $event"
      @update:selected-workspace-ids="selectedWorkspaceIds = $event"
      @update:future-boards="futureBoards = $event"
      @update:settings-future-boards="settingsFutureBoards = $event"
      @update:editing-settings="editingSettings = $event"
      @update:confirm-removal="confirmRemoval = $event"
      @clear-error="error = ''"
      @discover="discover"
      @back="backToList"
      @show-list="showView('list')"
      @request-pairing="requestPairing"
      @decide="decide"
      @provision="provision"
      @cancel="cancelKeeperRequest"
      @dismiss="dismissPendingPairing"
      @start-add="startAddKeeper"
      @open-settings="openIntegrationSettings"
      @save-settings="saveIntegrationSettings"
      @remove-keeper="removeSelectedKeeper"
      @toggle-settings-removal="toggleSettingsRemoval"
    />
  </section>
</template>

<style scoped src="./KeeperDiscovery.css"></style>
