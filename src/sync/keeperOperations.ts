import type { KeeperPairing, KeeperPairingStatus } from "./lighthousePairing"
import type { WorkspaceHostContext } from "./deviceSyncHost"
import type { RemovalOptions } from "./deviceSyncKeeper"
import type { MeshPeerView } from "./durableMesh"

type KeeperRemovalActionOptions = Omit<RemovalOptions, "workspaces"> & {
  workspaces: { id: string; title: string }[]
  peers: () => MeshPeerView[]
  changed: () => void
}
type KeeperSettingsActionOptions = KeeperRemovalActionOptions

export function createKeeperOperations(ensureDurableMesh: () => Promise<unknown>, hostContext: () => WorkspaceHostContext) {
  let provisioner: ((pairing: KeeperPairing) => Promise<KeeperPairingStatus>) | undefined
  let removalPersonId = ""
  return {
    traceProjection(peers: MeshPeerView[]) {
      if (!removalPersonId) return
      const personId = removalPersonId
      const projection = peers.filter(peer => peer.personId === personId).map(peer => ({
        personId: peer.personId, workspaceId: peer.workspaceId, deviceId: peer.deviceId, revokedAt: peer.revokedAt,
      }))
      void import("./keeperRemovalTrace").then(({ recordKeeperRemovalProjection }) => {
        recordKeeperRemovalProjection(projection, "mesh-notify", personId)
      }).catch(() => {})
    },
    async provision(pairing: KeeperPairing): Promise<KeeperPairingStatus> {
      if (!provisioner) {
        const { createKeeperProvisioner } = await import("./deviceSyncKeeper")
        provisioner = createKeeperProvisioner(ensureDurableMesh, hostContext)
      }
      return provisioner(pairing)
    },
    async remove(personId: string, options: KeeperRemovalActionOptions): Promise<"removed" | "pending"> {
      removalPersonId = personId
      try {
        const trace = await import("./keeperRemovalTrace").catch(() => undefined)
        if (trace) return await trace.removeKeeperWithTrace(personId, options)
        const { removeKeeperAccess } = await import("./deviceSyncKeeper")
        const result = await removeKeeperAccess(personId, options)
        options.changed()
        return result
      } finally {
        removalPersonId = ""
      }
    },
    async updateSettings(personId: string, futureBoards: boolean, removeWorkspaceIds: string[], options: KeeperSettingsActionOptions) {
      const { updateKeeperIntegrationAccess } = await import("./deviceSyncKeeper")
      const result = await updateKeeperIntegrationAccess(personId, futureBoards, removeWorkspaceIds, options)
      options.changed()
      return result
    },
  }
}
