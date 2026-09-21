import { createDeviceSyncController, type DeviceSyncOptions } from "./deviceSyncController"

export type { SyncStep } from "./deviceSyncState"
export { userMessage } from "./deviceSyncState"

export function useDeviceSync(options: DeviceSyncOptions) {
  return createDeviceSyncController(options)
}
