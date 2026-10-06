import { createKeeperWorkspaceHost, type WorkspaceHostContext } from "./deviceSyncHost"
import { deliverKeeperInvitation, type KeeperPairing, type KeeperPairingStatus } from "./lighthousePairing"
import type { WorkspaceJoinInvitation } from "@meta-uber/mesh-pairing"
import { ownerKeepers, removeOwnerKeeper, saveOwnerKeeper } from "./ownerKeeper"
import type { LocalProfile } from "../domain/identity"
import type { DurableMesh } from "./durableMesh"

export async function removeKeeperAccess(personId: string, options: {
  getProfile: () => Promise<LocalProfile>
  workspaces: { id: string }[]
  workspaceOwner?: (id: string) => Promise<string>
  mesh: () => Promise<DurableMesh | undefined>
  activeWorkspaceId?: string
}) {
  const profile = await options.getProfile()
  if (personId === profile.identity.personId) throw new Error("Cannot remove this identity")
  if (!options.workspaceOwner) throw new Error("Workspace ownership is unavailable")
  const workspaceIds: string[] = []
  for (const workspace of options.workspaces) {
    if (await options.workspaceOwner(workspace.id) === profile.identity.personId) workspaceIds.push(workspace.id)
  }
  if (!workspaceIds.length) throw new Error("No owned boards available")
  const mesh = await options.mesh()
  if (!mesh) throw new Error("Mesh unavailable")
  for (const workspaceId of workspaceIds.sort((a, b) => Number(a === options.activeWorkspaceId) - Number(b === options.activeWorkspaceId))) {
    await mesh.revokePerson(workspaceId, personId)
  }
  await removeOwnerKeeper(profile.identity.personId, personId)
}

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
