import { renewDeviceIdentity } from "../domain/identity"
import { userMessage, type DeviceSyncState } from "./deviceSyncState"

export function canReconnectDevice(state: DeviceSyncState) {
  return state.step.value === "error" && state.canRenewDevice.value &&
    state.parsedInvite.value?.kind === "workspace-join" && /Device access revoked/i.test(state.error.value)
}

export async function reconnectWorkspaceDevice(context: {
  state: DeviceSyncState
  stop: () => Promise<void>
  resetMesh: () => Promise<void>
  identityChanged?: () => Promise<void>
  refreshProfile: () => Promise<unknown>
  join: () => Promise<void>
}) {
  const { state } = context
  if (!canReconnectDevice(state)) return
  const invite = state.parsedInvite.value!
  if (Date.parse(invite.expiresAt) <= Date.now()) {
    state.error.value = "This invitation has expired. Ask the owner for a new link."
    return
  }
  state.step.value = "workspace-guest-waiting"
  try {
    await context.stop()
    await context.resetMesh()
    await renewDeviceIdentity()
    await context.identityChanged?.()
    await context.refreshProfile()
    state.step.value = "workspace-merge-confirm"
    await context.join()
  } catch (error) {
    state.step.value = "error"
    state.error.value = userMessage(error, "Couldn’t reconnect this device.")
  }
}
