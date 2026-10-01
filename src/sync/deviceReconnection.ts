import { renewDeviceIdentity } from "../domain/identity"
import type { WorkspaceJoinInvitation } from "@meta-uber/mesh-pairing"
import { userMessage, type DeviceSyncState } from "./deviceSyncState"

export function canReconnectDevice(state: DeviceSyncState) {
  return state.canRenewDevice.value && state.parsedInvite.value?.kind === "workspace-join" &&
    (state.step.value === "workspace-reconnect-confirm" || state.step.value === "error" && /Device access revoked/i.test(state.error.value))
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
    state.step.value = "error"
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

export async function showWorkspaceJoinStep(state: DeviceSyncState, invite: WorkspaceJoinInvitation,
  localIds: string[], revokedIds: () => Promise<string[]>) {
  state.invitationWorkspaces.value = invite.workspaces || [{ id: invite.workspaceId, title: invite.workspaceTitle }]
  state.invitationWorkspaceTitle.value = state.invitationWorkspaces.value.map(item => item.title).join(", ")
  const revoked = await revokedIds()
  if (state.canRenewDevice.value && state.invitationWorkspaces.value.some(item => revoked.includes(item.id))) {
    state.step.value = "workspace-reconnect-confirm"
    return
  }
  state.step.value = state.invitationWorkspaces.value.some(item => localIds.includes(item.id)) ? "workspace-merge-confirm" : "workspace-guest"
}
