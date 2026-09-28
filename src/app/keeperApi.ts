import { discoverLighthouse } from "../sync/lighthouseDiscovery"
import { beginKeeperPairing, decideKeeperPairing, getEligibleKeeperWorkspaces, getKeeperPairingStatus } from "../sync/lighthousePairing"

export type { KeeperWorkspace } from "../sync/lighthouseDiscovery"
export type { KeeperPairing, KeeperPairingStatus } from "../sync/lighthousePairing"

/** Application boundary used by keeper discovery and approval controls. */
export const keeperApi = {
  discover: discoverLighthouse,
  eligibleWorkspaces: getEligibleKeeperWorkspaces,
  beginPairing: beginKeeperPairing,
  decidePairing: decideKeeperPairing,
  pairingStatus: getKeeperPairingStatus,
}
