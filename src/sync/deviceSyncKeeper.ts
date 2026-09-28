import { createKeeperWorkspaceHost, type WorkspaceHostContext } from "./deviceSyncHost"
import { deliverKeeperInvitation, type KeeperPairing, type KeeperPairingStatus } from "./lighthousePairing"
import type { WorkspaceJoinInvitation } from "@meta-uber/mesh-pairing"

export function createKeeperProvisioner(
  ensureDurableMesh: () => Promise<unknown>,
  hostContext: () => WorkspaceHostContext,
) {
  const invitationHosts = new Map<string, Promise<WorkspaceJoinInvitation>>()
  return async (pairing: KeeperPairing): Promise<KeeperPairingStatus> => {
    await ensureDurableMesh()
    let invitationTask = invitationHosts.get(pairing.pairingId)
    if (!invitationTask) {
      invitationTask = createKeeperWorkspaceHost(hostContext(), pairing.workspaces, pairing.discovery.personId, pairing.futureBoards === true)
      invitationHosts.set(pairing.pairingId, invitationTask)
      void invitationTask.catch(() => {
        if (invitationHosts.get(pairing.pairingId) === invitationTask) invitationHosts.delete(pairing.pairingId)
      })
    }
    const invitation = await invitationTask
    return deliverKeeperInvitation(pairing, invitation)
  }
}
