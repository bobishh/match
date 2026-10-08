import { sha256Base64Url } from "../domain/identity"
import type { KeeperIntegrationReference } from "../domain/model"
import type { KeeperIntegrationStatus } from "./keeperIntegrationStatus"

const INTEGRATION_ID_DOMAIN = "MESH-LIGHTHOUSE-INTEGRATION/1\0"

export async function canonicalKeeperIntegrationId(controllerPersonId: string, servicePersonId: string): Promise<string> {
  const input = new TextEncoder().encode(`${INTEGRATION_ID_DOMAIN}${controllerPersonId}\0${servicePersonId}`)
  return sha256Base64Url(input)
}

function isRetiredHistory(integration: KeeperIntegrationStatus): boolean {
  return integration.scopes.length === 0 && !integration.futureBoards && !integration.pendingOperation
    && integration.tombstones.every(item => item.state === "removed" && item.cleanup === "complete")
}

/** Select stable canonical integration; keep terminal legacy rows only as history/floors. */
export function selectCanonicalServiceIntegration(integrations: KeeperIntegrationStatus[], canonicalId: string) {
  const canonicalRows = integrations.filter(item => item.integrationId === canonicalId)
  if (canonicalRows.length > 1) {
    throw new Error("Rusty returned duplicate canonical keeper integrations. Resolve them before changing access.")
  }
  const canonical = canonicalRows[0]
  const history = integrations.filter(item => item.integrationId !== canonicalId)
  if (history.some(item => !isRetiredHistory(item))) {
    throw new Error("Rusty has conflicting active keeper integrations. Resolve them before changing access.")
  }
  return canonical
}

export function selectKeeperReference(
  references: Record<string, KeeperIntegrationReference>,
  servicePersonId: string,
  options: { allowRemovalRetry?: boolean } = {},
): KeeperIntegrationReference | undefined {
  const matching = Object.values(references).filter(item => item.servicePersonId === servicePersonId)
  const live = matching.filter(item => item.state !== "removed")
  if (live.length > 1) {
    throw new Error("Multiple saved Rusty integrations need review before changing access.")
  }
  if (live.length === 1) return live[0]
  if (!options.allowRemovalRetry) return undefined
  const pending = matching.filter(item => item.pendingRemoval)
  if (pending.length > 1) throw new Error("Multiple Rusty removals need review before retrying cleanup.")
  if (pending.length === 1) return pending[0]
  if (matching.length === 1) return matching[0]
  if (matching.length > 1) throw new Error("Multiple removed Rusty integrations need review before retrying cleanup.")
  return undefined
}
