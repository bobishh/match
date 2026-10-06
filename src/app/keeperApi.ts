import { discoverLighthouse } from "../sync/lighthouseDiscovery"
import { beginKeeperPairing, decideKeeperPairing, getEligibleKeeperWorkspaces, getKeeperPairingStatus, type KeeperPairing } from "../sync/lighthousePairing"
import { bootstrapIdentity } from "../domain/identity"
import { ownerKeepers, rememberActivatedKeeper } from "../sync/ownerKeeper"

export type { KeeperWorkspace } from "../sync/lighthouseDiscovery"
export type { KeeperPairing, KeeperPairingStatus } from "../sync/lighthousePairing"
export type { KeeperDetails } from "../sync/ownerKeeper"

/** Application boundary used by keeper discovery and approval controls. */
export const keeperApi = {
  discover: discoverLighthouse,
  eligibleWorkspaces: getEligibleKeeperWorkspaces,
  beginPairing: beginKeeperPairing,
  decidePairing: decideKeeperPairing,
  async pairingStatus(pairing: KeeperPairing) {
    const status = await getKeeperPairingStatus(pairing)
    if (status === "active") {
      const profile = await bootstrapIdentity()
      await rememberActivatedKeeper(profile.identity.personId, pairing.discovery.personId, {
        origin: pairing.discovery.origin,
        boardIds: pairing.workspaces.map(workspace => workspace.id),
        futureBoards: pairing.futureBoards === true,
      })
    }
    return status
  },
  async keeperDetails(personId: string) {
    const profile = await bootstrapIdentity()
    return (await ownerKeepers(profile.identity.personId))
      .find(record => record.personId === personId)?.details ?? null
  },
}
