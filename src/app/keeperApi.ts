import { discoverLighthouse, type LighthouseDiscovery } from "../sync/lighthouseDiscovery"
import { beginKeeperPairing, decideKeeperPairing, getEligibleKeeperWorkspaces, getKeeperIntegrationStatus, newKeeperOperationId, rememberActiveKeeperIntegration, type KeeperPairing } from "../sync/lighthousePairing"
import { completeKeeperPairingWithdrawal, getKeeperPairingStatusInfo, requestKeeperPairingWithdrawal } from "../sync/lighthousePairingWithdrawalApi"
import { bootstrapIdentity } from "../domain/identity"
import { keeperIntegrationReferences, ownerKeepers, pendingKeeperWithdrawals, type KeeperDetails } from "../sync/ownerKeeper"

export type { KeeperWorkspace } from "../sync/lighthouseDiscovery"
export type { KeeperPairing, KeeperPairingStatus } from "../sync/lighthousePairing"
export type { KeeperDetails } from "../sync/ownerKeeper"
export type { PendingKeeperWithdrawal } from "../sync/ownerKeeper"
export type KeeperServiceDiscovery = LighthouseDiscovery

/** Application boundary used by keeper discovery and approval controls. */
export const keeperApi = {
  discover: discoverLighthouse,
  integrationStatus: getKeeperIntegrationStatus,
  eligibleWorkspaces: getEligibleKeeperWorkspaces,
  beginPairing: beginKeeperPairing,
  decidePairing: decideKeeperPairing,
  newOperationId: newKeeperOperationId,
  requestWithdrawal: requestKeeperPairingWithdrawal,
  completeWithdrawal: completeKeeperPairingWithdrawal,
  pendingWithdrawals: pendingKeeperWithdrawals,
  async pairingStatus(pairing: KeeperPairing) {
    const result = await getKeeperPairingStatusInfo(pairing)
    if (result.status === "active" && !result.withdrawal) await rememberActiveKeeperIntegration(pairing)
    return result.status
  },
  async pairingStatusInfo(pairing: KeeperPairing, expectedWithdrawalOperationId?: string) {
    const result = await getKeeperPairingStatusInfo(pairing, expectedWithdrawalOperationId)
    if (result.status === "active" && !result.withdrawal) await rememberActiveKeeperIntegration(pairing)
    return result
  },
  async withdrawalStatusAfterError(pairing: KeeperPairing, operationId: string) {
    try { return await getKeeperPairingStatusInfo(pairing, operationId) }
    catch { return null }
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
  async pendingRemovalReferences() {
    const { integrations } = await keeperIntegrationReferences()
    const descriptors = Object.values(integrations).filter(reference =>
      reference.state === "removing" || Boolean(reference.pendingRemoval))
    const descriptorPeople = new Set(descriptors.map(reference => reference.servicePersonId))
    const profile = await bootstrapIdentity()
    const legacy = (await ownerKeepers(profile.identity.personId))
      .filter(record => record.details?.removalPending && !descriptorPeople.has(record.personId))
      .map(record => ({
        servicePersonId: record.personId,
        serviceDeviceId: record.details?.serviceDeviceId,
        serviceDeviceIds: record.details?.serviceDeviceIds ?? (record.details?.serviceDeviceId ? [record.details.serviceDeviceId] : []),
        verifiedAt: new Date().toISOString(),
      }))
    return [...descriptors, ...legacy]
  },
}
