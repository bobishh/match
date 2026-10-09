import type { KeeperIntegrationReference } from "../domain/model"
import { getKeeperIntegrationStatus, type KeeperIntegrationStatus } from "../sync/keeperPairing"
import type { KeeperDiscovery } from "../sync/keeperDiscovery"

type KeeperIntegrationAvailability = "unknown" | "available" | "unavailable" | "needs-review"
export type KeeperIntegrationAvailabilityResult = {
  state: Exclude<KeeperIntegrationAvailability, "unknown">
  reason?: string
}
type IntegrationStatus = Awaited<ReturnType<typeof getKeeperIntegrationStatus>>
export type KeeperIntegrationStatusProbe = (discovery: KeeperDiscovery) => Promise<IntegrationStatus>

function cachedDiscovery(reference: KeeperIntegrationReference): KeeperDiscovery | undefined {
  if (!hasPinnedServiceIdentity(reference) || !isCanonicalServiceOrigin(reference.serviceOrigin)) return undefined
  return {
    origin: reference.serviceOrigin,
    displayName: "Rusty keeper",
    personId: reference.servicePersonId,
    deviceId: reference.serviceDeviceId,
    publicKey: reference.servicePublicKey,
    certificates: reference.serviceCertificates,
    fingerprint: "",
    capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true,
      blobReplication: true, pairing: true },
  }
}

function hasPinnedServiceIdentity(reference: KeeperIntegrationReference): boolean {
  return Boolean(reference.serviceOrigin && reference.servicePersonId && reference.serviceDeviceId
    && reference.servicePublicKey && Array.isArray(reference.serviceCertificates))
}

function isCanonicalServiceOrigin(value: string): boolean {
  try {
    const origin = new URL(value)
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
    const secure = origin.protocol === "https:" || (import.meta.env.DEV && origin.protocol === "http:" && loopback)
    return secure && origin.origin === value && !origin.username && !origin.password
      && origin.pathname === "/" && !origin.search && !origin.hash
  } catch { return false }
}

function sameStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, index) => value === sortedRight[index])
}

function matchesSavedKeeperIntegration(reference: KeeperIntegrationReference,
  integration: KeeperIntegrationStatus): boolean {
  return integration.integrationId === reference.integrationId
    && integration.revision === reference.revision
    && !integration.pendingOperation
    && matchesWorkspaceIds(reference.workspaceIds, integration)
    && matchesPolicy(reference, integration)
    && (!reference.scopeReceipts || matchesScopeReceipts(reference.scopeReceipts, integration))
}

function matchesWorkspaceIds(savedIds: string[], integration: KeeperIntegrationStatus): boolean {
  const serviceIds = integration.scopes.map(scope => scope.workspaceId)
  return new Set(savedIds).size === savedIds.length && sameStrings(savedIds, serviceIds)
}

function matchesPolicy(reference: KeeperIntegrationReference, integration: KeeperIntegrationStatus): boolean {
  if (integration.futureBoards !== reference.futureBoards) return false
  return reference.futureBoardBaselineIds === undefined
    || sameStrings(reference.futureBoardBaselineIds, integration.baselineWorkspaceIds ?? [])
}

function matchesScopeReceipts(receipts: NonNullable<KeeperIntegrationReference["scopeReceipts"]>,
  integration: KeeperIntegrationStatus): boolean {
  if (receipts.length !== integration.scopes.length
    || new Set(receipts.map(scope => scope.workspaceId)).size !== receipts.length) return false
  return receipts.every(saved => integration.scopes.some(scope => scope.workspaceId === saved.workspaceId
    && scope.grantEpoch === saved.grantEpoch && scope.activationOperationId === saved.activationOperationId))
}

function isTransportFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) return true
  if (error && typeof error === "object" && "status" in error) {
    const status = Number((error as { status?: unknown }).status)
    return status === 408 || status === 429 || status >= 500
  }
  return false
}

export async function keeperIntegrationAvailability(reference: KeeperIntegrationReference,
  probe: KeeperIntegrationStatusProbe = getKeeperIntegrationStatus): Promise<KeeperIntegrationAvailabilityResult> {
  const discovery = cachedDiscovery(reference)
  if (!discovery) return { state: "needs-review", reason: "Saved Rusty identity or address is incomplete." }
  try {
    const status = await probe(discovery)
    const integration = status.integrations.find(item => item.integrationId === reference.integrationId)
    return integration && matchesSavedKeeperIntegration(reference, integration)
      ? { state: "available" }
      : { state: "needs-review", reason: "Signed Rusty status differs from saved integration." }
  } catch (error) {
    return isTransportFailure(error)
      ? { state: "unavailable", reason: "Rusty did not respond to its signed status check." }
      : { state: "needs-review", reason: "Rusty status could not be verified or does not match this integration." }
  }
}
