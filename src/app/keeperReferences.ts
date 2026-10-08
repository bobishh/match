import { keeperApi } from "./keeperApi"
import type { MeshMemberView } from "../ui/deviceInfo"

export async function loadKeeperReferenceViews(): Promise<{ pending: MeshMemberView[]; saved: MeshMemberView[] }> {
  const [references, activeReferences] = await Promise.all([
    keeperApi.pendingRemovalReferences(), keeperApi.activeIntegrationReferences(),
  ])
  const saved = activeReferences.map((reference): MeshMemberView => ({
    personId: reference.servicePersonId, name: "Rusty keeper", role: "editor", online: false,
    reconnecting: false, onlineDevices: 0, devices: 0, self: false, deviceList: [],
    integrationBoardIds: reference.workspaceIds,
  }))
  const pending = references.map((reference): MeshMemberView => {
    const deviceIds = "serviceDeviceIds" in reference ? reference.serviceDeviceIds : [reference.serviceDeviceId]
    const knownDeviceIds = (deviceIds?.length ? deviceIds : [reference.serviceDeviceId])
      .filter((deviceId): deviceId is string => typeof deviceId === "string" && deviceId.length > 0)
    return {
      personId: reference.servicePersonId, name: "Rusty keeper", role: "editor", online: false,
      reconnecting: false, onlineDevices: 0, devices: knownDeviceIds.length || 1, self: false,
      pendingRemoval: true,
      deviceList: knownDeviceIds.map(deviceId => ({ deviceId, name: "Rusty", online: false, reconnecting: false,
        lastSeen: reference.verifiedAt, userAgent: "mesh-lighthouse/1.0.0", description: "Rusty", tabs: 1 })),
    }
  })
  return { pending, saved }
}
