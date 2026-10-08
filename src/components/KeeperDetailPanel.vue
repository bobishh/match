<script setup lang="ts">
import type { KeeperDetails, KeeperPairing, KeeperServiceDiscovery, KeeperWorkspace } from "../app/keeperApi"
import { keeperDisplayName, type MeshMemberView } from "../ui/deviceInfo"
import RustyMark from "./RustyMark.vue"

type PairingStatus = "idle" | "loading" | "found" | "error" | "creating" | "pairing" | "approved" | "provisioning" | "active" | "rejected" | "expired" | "cancel_pending" | "cancelled"
defineProps<{
  form: boolean; originInput: string; status: PairingStatus; error: string
  discovery: KeeperServiceDiscovery | null; selectedKeeper: MeshMemberView | undefined
  pairing: KeeperPairing | null; policyOnlyPairing: boolean; currentPolicyBoardTitles: string[]
  eligibleWorkspaces: KeeperWorkspace[]; selectedWorkspaceIds: string[]; activeIntegrationWorkspaceIds: string[]
  futureBoards: boolean; controllerApproved: boolean; provisioning: boolean; pendingPairing: boolean
  cancellingPairing: boolean; withdrawalOperationId: string; keeperDetails: KeeperDetails | null
  ownedWorkspaces: KeeperWorkspace[]; settingsStatus: string; editingSettings: boolean
  settingsRemoveWorkspaceIds: string[]; settingsFutureBoards: boolean; settingsBusy: boolean
  settingsPending: boolean; settingsError: string; removeKeeperAvailable: boolean; confirmRemoval: boolean
  removalPending: boolean; removingKeeper: boolean; removalError: string
}>()
const emit = defineEmits<{
  (event: "update:originInput", value: string): void
  (event: "update:selectedWorkspaceIds", value: string[]): void
  (event: "update:futureBoards", value: boolean): void
  (event: "update:settingsFutureBoards", value: boolean): void
  (event: "update:editingSettings", value: boolean): void
  (event: "update:confirmRemoval", value: boolean): void
  (event: "clearError"): void
  (event: "discover" | "back" | "showList" | "requestPairing" | "provision" | "cancel" | "dismiss" | "startAdd" | "openSettings" | "saveSettings" | "removeKeeper"): void
  (event: "decide", approve: boolean): void
  (event: "toggleSettingsRemoval", workspaceId: string, checked: boolean): void
}>()
</script>

<template>
  <div v-if="form" class="keeper-replacement" aria-label="Add keeper form">
    <div class="keeper-panel-head"><h3>Add keeper</h3><button class="button button-quiet" type="button" @click="emit('back')">Back</button></div>
    <label class="pairing-paste"><span>Keeper hostname</span><input :value="originInput" type="url" autocomplete="url" placeholder="keeper.example.com" aria-label="Keeper hostname" @input="emit('update:originInput', ($event.target as HTMLInputElement).value)" @keydown.enter.prevent="emit('discover')" /></label>
    <div class="dialog-actions"><button class="button button-primary" type="button" :disabled="status === 'loading' || !originInput.trim()" @click="emit('discover')">{{ status === 'loading' ? "Discovering…" : "Discover keeper" }}</button><button class="button button-quiet" type="button" @click="emit('back')">Cancel</button></div>
    <p v-if="error" class="sync-error" role="alert">{{ error }}</p>
  </div>
  <div v-else class="keeper-replacement" aria-label="Keeper details">
    <div class="keeper-panel-head"><h3>{{ keeperDisplayName(discovery?.displayName ?? selectedKeeper?.name ?? "Rusty") }}</h3><button class="button button-quiet" type="button" @click="discovery ? emit('back') : emit('showList')">Back</button></div>
    <p v-if="discovery" class="keeper-summary">Service identity <code>{{ discovery.personId }}</code> · <code>{{ discovery.origin }}</code></p>
    <template v-if="discovery">
      <p v-if="error && !pairing" class="sync-error" role="alert">{{ error }}</p>
      <p v-if="policyOnlyPairing" class="dialog-copy" role="status" aria-label="Current integration access">Current access stays active: {{ currentPolicyBoardTitles.join(", ") || "no active boards" }}.</p>
      <p v-if="eligibleWorkspaces.length && !policyOnlyPairing" class="sync-section-copy">Boards</p>
      <div v-if="eligibleWorkspaces.length && !policyOnlyPairing" class="sync-workspace-list">
        <label v-for="workspace in eligibleWorkspaces" :key="workspace.id" class="sync-checkbox-item"><input type="checkbox" :checked="selectedWorkspaceIds.includes(workspace.id)" :aria-label="`Keeper board: ${workspace.title}`" :disabled="Boolean(pairing) || activeIntegrationWorkspaceIds.includes(workspace.id)" @change="emit('update:selectedWorkspaceIds', ($event.target as HTMLInputElement).checked ? [...selectedWorkspaceIds, workspace.id] : selectedWorkspaceIds.filter(id => id !== workspace.id))" /><span>{{ workspace.title }}<small class="sync-workspace-detail">{{ activeIntegrationWorkspaceIds.includes(workspace.id) ? "Already active" : "Editor access" }}</small></span></label>
      </div>
      <p v-else-if="!policyOnlyPairing && !pairing" class="dialog-copy">No eligible owned boards found.</p>
      <template v-if="pairing && !policyOnlyPairing">
        <p v-if="pairing.workspaces.length" class="sync-section-copy">Requested boards</p>
        <ul class="keeper-devices"><li v-for="workspace in pairing.workspaces" :key="workspace.id">{{ workspace.title }}</li></ul>
      </template>
      <label v-if="eligibleWorkspaces.length && !pairing" class="sync-checkbox-item"><input type="checkbox" aria-label="Also replicate my future boards" :checked="futureBoards" @change="emit('update:futureBoards', ($event.target as HTMLInputElement).checked)" /><span>Include future boards</span></label>
      <p v-if="discovery.capabilities.pairing !== true" class="dialog-copy" role="status">This service cannot accept keeper requests.</p>
      <button v-if="!pairing" class="button button-primary" type="button" :disabled="discovery.capabilities.pairing !== true || !selectedWorkspaceIds.length || status === 'creating'" @click="emit('requestPairing')">{{ status === "creating" ? "Starting request…" : "Request access" }}</button>
      <section v-if="pairing" class="keeper-pairing" aria-label="Keeper pairing state">
        <p class="keeper-code"><span class="detail-label">Comparison code</span><strong>{{ pairing.comparisonCode }}</strong></p>
        <p v-if="status !== 'cancel_pending' && status !== 'cancelled'" class="dialog-copy">Both the operator and owner must approve this code before {{ policyOnlyPairing ? 'future-board policy changes' : 'access begins' }}.</p>
        <p class="dialog-copy" role="status">{{ status === "cancelled" ? "Keeper request cancelled. No access granted." : status === "cancel_pending" ? "Rusty cancellation is still pending. Request stays blocked until cleanup is confirmed." : status === "rejected" ? "Pairing rejected. No access granted." : status === "expired" ? "Pairing expired. No access granted." : status === "active" ? policyOnlyPairing ? activeIntegrationWorkspaceIds.length ? "Future boards enabled. Current board access remains active." : "Future boards enabled. No board access added." : "All selected boards activated and saved by Rusty." : status === "provisioning" ? policyOnlyPairing ? "Both sides approved. Rusty is applying the future-board policy." : "Both sides approved. Rusty is saving boards; access remains pending." : status === "approved" ? policyOnlyPairing ? "Both sides approved. Applying future-board policy…" : "Both sides approved. Starting board setup…" : controllerApproved ? "Waiting for operator approval. No access granted." : "Waiting for both approvals. No access granted." }}</p>
        <a v-if="status !== 'cancel_pending' && status !== 'cancelled'" class="button button-quiet" :href="pairing.operatorUrl" target="_blank" rel="noopener noreferrer">Open operator approval</a>
        <div v-if="status === 'pairing' && !controllerApproved" class="dialog-actions"><button class="button button-primary" type="button" @click="emit('decide', true)">Code matches · approve</button><button class="button button-quiet" type="button" @click="emit('decide', false)">Decline</button></div>
        <button v-if="status === 'provisioning' && error" class="button button-primary" type="button" :disabled="provisioning" @click="emit('provision')">Retry board setup</button>
        <button v-if="pendingPairing" class="button button-danger" type="button" :disabled="cancellingPairing" @click="emit('cancel')">{{ cancellingPairing ? 'Sending cancellation…' : status === 'cancel_pending' || withdrawalOperationId ? 'Retry cancellation' : 'Cancel keeper request' }}</button>
        <button v-if="pendingPairing" class="button button-quiet" type="button" :disabled="cancellingPairing" @click="emit('dismiss')">Dismiss from list</button>
        <button v-if="status === 'expired' || status === 'rejected' || status === 'cancelled'" class="button button-primary" type="button" @click="emit('startAdd')">Start new request</button>
        <div v-if="error" class="sync-error" role="alert"><p>{{ error }}</p><button class="button button-quiet" type="button" @click="emit('clearError')">Dismiss error</button></div>
      </section>
    </template>
    <template v-else-if="selectedKeeper">
      <p class="keeper-summary">Keeper · {{ selectedKeeper.online ? 'Connected' : selectedKeeper.reconnecting ? 'Reconnecting' : 'Offline' }}</p>
      <p v-if="keeperDetails?.origin" class="keeper-summary">{{ keeperDetails.origin }}</p><p v-if="keeperDetails?.futureBoards" class="keeper-summary">Includes future boards</p>
      <p v-if="keeperDetails" class="sync-section-copy">Boards</p><ul v-if="keeperDetails" class="keeper-devices"><li v-for="board in ownedWorkspaces.filter(workspace => keeperDetails?.boardIds.includes(workspace.id))" :key="board.id">{{ board.title }}</li></ul>
      <p v-if="settingsStatus" class="dialog-copy" role="status" aria-label="Keeper settings status">{{ settingsStatus }}</p>
      <button v-if="keeperDetails?.integrationId && keeperDetails.integrationSettingsSupported && !editingSettings" class="button button-quiet" type="button" @click="emit('openSettings')">Manage board access</button>
      <p v-else-if="keeperDetails?.integrationId && keeperDetails.integrationSettingsSupported === false" class="dialog-copy" role="status">Board settings require a newer Rusty version.</p><p v-else-if="keeperDetails?.integrationId" class="dialog-copy" role="status">Rusty status could not verify board settings support. Reconnect and try again.</p>
      <section v-if="editingSettings && keeperDetails?.integrationId" class="keeper-settings" aria-label="Keeper board settings">
        <p class="sync-section-copy">Board access</p>
        <label v-for="board in ownedWorkspaces.filter(workspace => keeperDetails?.boardIds.includes(workspace.id))" :key="board.id" class="keeper-setting-row"><input type="checkbox" :checked="settingsRemoveWorkspaceIds.includes(board.id)" :disabled="settingsBusy || settingsPending" @change="emit('toggleSettingsRemoval', board.id, ($event.target as HTMLInputElement).checked)" /><span>Remove access to {{ board.title }}</span></label>
        <label class="keeper-setting-row"><input type="checkbox" :checked="settingsFutureBoards" :disabled="settingsBusy || settingsPending" @change="emit('update:settingsFutureBoards', ($event.target as HTMLInputElement).checked)" /><span>Include future boards</span></label>
        <p v-if="settingsPending" class="dialog-copy" role="status">Settings update needs attention. Retry preserves this exact request.</p>
        <div class="dialog-actions"><button class="button button-primary" type="button" :disabled="settingsBusy || (!settingsPending && settingsFutureBoards === keeperDetails.futureBoards && !settingsRemoveWorkspaceIds.length)" @click="emit('saveSettings')">{{ settingsBusy ? 'Saving settings…' : settingsPending ? 'Retry settings update' : settingsFutureBoards && !keeperDetails.futureBoards ? 'Request future-board approval' : 'Save future-board setting' }}</button><button class="button button-quiet" type="button" :disabled="settingsBusy || settingsPending" @click="emit('update:editingSettings', false)">Cancel</button></div>
        <p v-if="settingsError" class="sync-error" role="alert" aria-label="Keeper settings error">{{ settingsError }}</p>
      </section>
      <ul class="keeper-devices"><li v-for="device in selectedKeeper.deviceList" :key="device.deviceId"><RustyMark compact :online="device.online" :reconnecting="device.reconnecting" />{{ keeperDisplayName(device.name) }} · {{ device.online ? 'Connected' : device.reconnecting ? 'Reconnecting' : 'Offline' }}</li></ul>
      <div v-if="removeKeeperAvailable" class="keeper-removal">
        <template v-if="!keeperDetails?.integrationId"><button v-if="!confirmRemoval && !removalPending" class="button button-danger" type="button" @click="emit('update:confirmRemoval', true)">Remove keeper</button><template v-else><p class="dialog-copy">Revoke this keeper’s access to your boards and remove it from the list.</p><p v-if="removalPending" class="dialog-copy" role="status" aria-label="Keeper removal status">Removal did not finish. Retry to revoke remaining access and remove this keeper.</p><div class="dialog-actions"><button class="button button-danger" type="button" :disabled="removingKeeper" @click="emit('removeKeeper')">{{ removingKeeper ? 'Removing keeper…' : removalPending ? 'Retry removal' : 'Remove keeper now' }}</button><button class="button button-quiet" type="button" :disabled="removingKeeper" @click="emit('update:confirmRemoval', false)">Cancel</button></div></template></template>
        <template v-else><button v-if="!confirmRemoval && !removalPending" class="button button-danger" type="button" @click="emit('update:confirmRemoval', true)">Remove keeper</button><template v-if="confirmRemoval || removalPending"><p class="dialog-copy">{{ removalPending ? "Removal is still pending Rusty confirmation." : "Remove access from all boards still owned by this identity?" }}</p><p v-if="removalPending" class="dialog-copy" role="status" aria-label="Keeper removal status">Remote removal is not confirmed. Retry removal.</p><div class="dialog-actions"><button class="button button-danger" type="button" :disabled="removingKeeper" @click="emit('removeKeeper')">{{ removingKeeper ? 'Removing keeper…' : removalPending ? 'Retry removal' : 'Remove access from all boards' }}</button><button class="button button-quiet" type="button" :disabled="removingKeeper" @click="emit('update:confirmRemoval', false)">Cancel</button></div></template></template>
        <p v-if="removalError" class="sync-error" role="alert">{{ removalError }}</p>
      </div>
    </template>
  </div>
</template>
