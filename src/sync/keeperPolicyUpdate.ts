import type { KeeperPairing } from "./lighthousePairing"

export async function beginKeeperPolicyUpdate(personId: string, baselineWorkspaceIds: string[]): Promise<KeeperPairing> {
  const [{ keeperIntegrationReferences }, { discoverLighthouse }, pairingApi] = await Promise.all([
    import("./ownerKeeper"), import("./lighthouseDiscovery"), import("./lighthousePairing"),
  ])
  const { integrations } = await keeperIntegrationReferences()
  const reference = Object.values(integrations).find(item => item.servicePersonId === personId && item.state === "active")
  if (!reference) throw new Error("Saved Rusty integration could not be verified.")
  const discovery = await discoverLighthouse(reference.serviceOrigin)
  const current = await pairingApi.getKeeperIntegrationStatus(discovery)
  const integration = current.integrations.find(item => item.integrationId === reference.integrationId)
  if (!integration || integration.pendingOperation || integration.futureBoards) {
    throw new Error("Rusty integration changed or has cleanup pending. Reload settings and retry.")
  }
  const completeBaseline = [...new Set([...baselineWorkspaceIds,
    ...integration.scopes.map(scope => scope.workspaceId), ...integration.tombstones.map(scope => scope.workspaceId)])].sort()
  return pairingApi.beginKeeperPairing(discovery, [], {
    futureBoards: true, futureBoardBaselineIds: completeBaseline, policyOnly: true,
  })
}
