import { discoverLighthouse } from "../sync/lighthouseDiscovery"
import { beginKeeperPairing, decideKeeperPairing, getEligibleKeeperWorkspaces, getKeeperIntegrationStatus, getKeeperPairingStatus, rememberActiveKeeperIntegration, type KeeperPairing } from "../sync/lighthousePairing"
import { bootstrapIdentity } from "../domain/identity"
import { keeperIntegrationReferences, ownerKeepers, type KeeperDetails } from "../sync/ownerKeeper"

export type { KeeperWorkspace } from "../sync/lighthouseDiscovery"
export type { KeeperPairing, KeeperPairingStatus } from "../sync/lighthousePairing"
export type { KeeperDetails } from "../sync/ownerKeeper"

/** Application boundary used by keeper discovery and approval controls. */
export const keeperApi = {
  discover: discoverLighthouse,
  integrationStatus: getKeeperIntegrationStatus,
  eligibleWorkspaces: getEligibleKeeperWorkspaces,
  beginPairing: beginKeeperPairing,
  decidePairing: decideKeeperPairing,
  async pairingStatus(pairing: KeeperPairing) {
    const status = await getKeeperPairingStatus(pairing)
    if (status === "active") await rememberActiveKeeperIntegration(pairing)
    return status
  },
  async keeperDetails(personId: string) {
    const profile = await bootstrapIdentity()
    const details = (await ownerKeepers(profile.identity.personId)).find(record => record.personId === personId)?.details
    const { integrations } = await keeperIntegrationReferences()
    const reference = Object.values(integrations).find(item => item.servicePersonId === personId && item.state !== "removed")
    if (!reference) return details ?? null
    const fromRoot: KeeperDetails = {
      origin: reference.serviceOrigin,
      boardIds: reference.workspaceIds,
      futureBoards: reference.futureBoards,
      futureBoardBaselineIds: reference.futureBoardBaselineIds,
      integrationId: reference.integrationId,
      servicePersonId: reference.servicePersonId,
      serviceDeviceId: reference.serviceDeviceId,
      servicePublicKey: reference.servicePublicKey,
      serviceCertificates: reference.serviceCertificates,
      revision: reference.revision,
      removalPending: reference.state === "removing" || Boolean(reference.pendingRemoval),
    }
    return { ...details, ...fromRoot }
  },
}
