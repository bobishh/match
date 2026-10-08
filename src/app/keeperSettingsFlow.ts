import type { Ref } from "vue"
import type { KeeperDetails, KeeperPairing, KeeperServiceDiscovery, KeeperWorkspace } from "./keeperApi"

type SettingsFlow = {
  personId: string
  updateSettings?: (personId: string, futureBoards: boolean, removeWorkspaceIds: string[]) => Promise<"updated" | "pending">
  beginPolicyUpdate?: (personId: string, baselineWorkspaceIds: string[]) => Promise<KeeperPairing>
  ownedWorkspaces: KeeperWorkspace[]
  keeperDetails: Ref<KeeperDetails | null>
  settingsBusy: Ref<boolean>; settingsError: Ref<string>; settingsStatus: Ref<string>
  settingsPending: Ref<boolean>; settingsFutureBoards: Ref<boolean>; settingsRemoveWorkspaceIds: Ref<string[]>
  editingSettings: Ref<boolean>; discovery: Ref<KeeperServiceDiscovery | null>
  eligibleWorkspaces: Ref<KeeperWorkspace[]>; activeWorkspaceIds: Ref<string[]>; selectedWorkspaceIds: Ref<string[]>
  pairing: Ref<KeeperPairing | null>; policyOnlyPairing: Ref<boolean>; pairingDismissed: Ref<boolean>
  controllerApproved: Ref<boolean>; status: Ref<string>; showDetails: () => void
  refreshDetails: (personId: string) => Promise<KeeperDetails | null>
  scheduleStatusCheck: () => void
}

export async function saveKeeperSettings(flow: SettingsFlow): Promise<void> {
  const { personId } = flow
  if (!personId || !flow.updateSettings || flow.settingsBusy.value) return
  flow.settingsBusy.value = true
  flow.settingsError.value = ""
  flow.settingsStatus.value = ""
  try {
    if (!flow.keeperDetails.value?.integrationSettingsSupported) {
      throw new Error("This Rusty version does not support signed integration settings. Update Rusty before changing access.")
    }
    if (!flow.keeperDetails.value.futureBoards && flow.settingsFutureBoards.value) {
      await requestFutureBoardApproval(flow)
      return
    }
    const result = await flow.updateSettings(personId, flow.settingsFutureBoards.value, flow.settingsRemoveWorkspaceIds.value)
    if (result === "pending") {
      flow.settingsPending.value = true
      flow.settingsStatus.value = "Settings cleanup is pending Rusty confirmation. Existing access remains visible."
      return
    }
    flow.settingsPending.value = false
    flow.editingSettings.value = false
    flow.settingsStatus.value = flow.settingsFutureBoards.value
      ? "Board access updated. Future boards remain included."
      : "Future boards are off. Current board access remains active."
    flow.settingsRemoveWorkspaceIds.value = []
    flow.keeperDetails.value = await flow.refreshDetails(personId)
  } catch (cause) {
    flow.settingsError.value = cause instanceof Error ? cause.message : "Could not update keeper settings."
    flow.settingsPending.value = true
    flow.settingsStatus.value = "Current access remains active until Rusty confirms settings."
  } finally {
    flow.settingsBusy.value = false
  }
}

async function requestFutureBoardApproval(flow: SettingsFlow) {
  const latest = flow.keeperDetails.value
  if (flow.settingsRemoveWorkspaceIds.value.length) {
    const removal = await flow.updateSettings!(flow.personId, false, flow.settingsRemoveWorkspaceIds.value)
    if (removal === "pending") {
      flow.settingsPending.value = true
      flow.settingsStatus.value = "Board removal is pending Rusty confirmation. Retry before requesting future-board approval."
      return
    }
    flow.keeperDetails.value = await flow.refreshDetails(flow.personId)
  }
  if (!latest?.origin) throw new Error("Saved Rusty address is missing. Reopen keeper details and retry.")
  const baselineIds = [...new Set([...flow.ownedWorkspaces.map(workspace => workspace.id),
    ...(flow.keeperDetails.value?.futureBoardBaselineIds ?? [])])].sort()
  const created = await flow.beginPolicyUpdate?.(flow.personId, baselineIds)
  if (!created) throw new Error("Future-board approval is unavailable in this app version.")
  flow.discovery.value = created.discovery
  flow.eligibleWorkspaces.value = flow.ownedWorkspaces
  flow.activeWorkspaceIds.value = flow.keeperDetails.value?.boardIds ?? []
  flow.selectedWorkspaceIds.value = []
  flow.pairing.value = created
  flow.policyOnlyPairing.value = true
  flow.pairingDismissed.value = false
  flow.controllerApproved.value = false
  flow.editingSettings.value = false
  flow.settingsPending.value = false
  flow.status.value = "pairing"
  flow.settingsStatus.value = "Operator approval required. Current board access remains active."
  flow.showDetails()
  flow.scheduleStatusCheck()
}
