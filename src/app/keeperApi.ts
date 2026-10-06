import { discoverLighthouse } from "../sync/lighthouseDiscovery"
import { beginKeeperPairing, decideKeeperPairing, getEligibleKeeperWorkspaces, getKeeperPairingStatus } from "../sync/lighthousePairing"
import { bootstrapIdentity } from "../domain/identity"
import { ownerKeepers } from "../sync/ownerKeeper"

export type { KeeperWorkspace } from "../sync/lighthouseDiscovery"
export type { KeeperPairing, KeeperPairingStatus } from "../sync/lighthousePairing"
export type { KeeperDetails } from "../sync/ownerKeeper"

/** Application boundary used by keeper discovery and approval controls. */
export const keeperApi = {
  discover: discoverLighthouse,
  eligibleWorkspaces: getEligibleKeeperWorkspaces,
  beginPairing: beginKeeperPairing,
  decidePairing: decideKeeperPairing,
  pairingStatus: getKeeperPairingStatus,
  async keeperDetails(personId: string) {
    const profile = await bootstrapIdentity()
    return (await ownerKeepers(profile.identity.personId))
      .find(record => record.personId === personId)?.details ?? null
  },
}
