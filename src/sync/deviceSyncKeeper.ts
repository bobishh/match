import { createKeeperWorkspaceHost, type WorkspaceHostContext } from "./deviceSyncHost"
import { deliverKeeperInvitation, type KeeperPairing, type KeeperPairingStatus } from "./lighthousePairing"
import type { WorkspaceJoinInvitation } from "@meta-uber/mesh-pairing"
import { ownerKeepers, saveOwnerKeeper } from "./ownerKeeper"

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
    const status = await deliverKeeperInvitation(pairing, invitation)
    if (status === "active") {
      const profile = await hostContext().getProfile()
      const previous = (await ownerKeepers(profile.identity.personId))
        .find(record => record.personId === pairing.discovery.personId)
      await saveOwnerKeeper(profile.identity.personId, {
        personId: pairing.discovery.personId,
        role: previous?.role ?? "visitor",
        details: {
          origin: pairing.discovery.origin,
          boardIds: pairing.workspaces.map(workspace => workspace.id),
          futureBoards: pairing.futureBoards === true,
        },
      })
    }
    return status
  }
}
