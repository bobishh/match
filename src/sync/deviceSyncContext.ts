import type { LocalProfile } from "../domain/identity"
import type { DurableMesh } from "./durableMesh"
import type { DeviceSyncState } from "./deviceSyncState"
import type { SyncNode, SyncTransport } from "./transport"
import type { WorkspaceSetStore } from "./workspaceSet"

export type PairingContext = {
  state: DeviceSyncState
  workspaceStore?: WorkspaceSetStore
  meshWorkspaceStore?: WorkspaceSetStore
  durableMesh?: DurableMesh
  availableWorkspaces: { id: string; title: string }[]
  workspaceOwner?: (id: string) => Promise<string>
  origin: () => string
  transport: SyncTransport
  getProfile: () => Promise<LocalProfile>
  nextRun: () => number
  currentRun: () => number
  pauseMesh: () => Promise<void>
  stopNode: (reason: string) => Promise<void>
  setNode: (node: SyncNode | undefined) => void
}
