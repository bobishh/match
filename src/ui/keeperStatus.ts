import type { MeshMemberView } from "./deviceInfo"

export function keeperRowStatus(keeper: MeshMemberView, activeWorkspaceId?: string): string {
  if (keeper.pendingRemoval) return "Removal pending"
  if (keeper.integrationBoardIds) {
    if (!keeper.integrationBoardIds.length) return "No boards · not connected to this board"
    const serviceStatus = keeper.integrationAvailability === "available" ? "Service available"
      : keeper.integrationAvailability === "unavailable" ? "Service unreachable"
        : keeper.integrationAvailability === "needs-review" ? "Status needs review" : ""
    const notConnected = activeWorkspaceId && !keeper.integrationBoardIds.includes(activeWorkspaceId)
    if (serviceStatus) return notConnected ? `${serviceStatus} · Not connected to this board` : serviceStatus
    if (notConnected) return "Not connected to this board"
    return "Checking service"
  }
  return keeper.online ? "Connected" : keeper.reconnecting ? "Reconnecting" : "Offline"
}

export function keeperDotState(keeper: MeshMemberView): string {
  if (keeper.pendingRemoval) return "reconnecting"
  if (keeper.integrationBoardIds) {
    if (keeper.integrationAvailability === "available") return "service-available"
    if (keeper.integrationAvailability === "unavailable") return "service-unavailable"
    return "service-checking"
  }
  return keeper.online ? "online" : keeper.reconnecting ? "reconnecting" : "offline"
}
