import type { LighthouseDiscovery } from "./lighthouseDiscovery"

export type KeeperDisconnectScope = { workspaceId: string; expectedGrantEpoch: number }
type KeeperIntegrationScope = {
  workspaceId: string
  grantEpoch: number
  state: "active"
  activationOperationId: string
}
export type KeeperIntegrationStatus = {
  integrationId: string
  revision: number
  futureBoards: boolean
  baselineWorkspaceIds?: string[]
  scopes: KeeperIntegrationScope[]
  tombstones: Array<{
    workspaceId: string
    grantEpoch: number
    state: "pending" | "removed"
    cleanup: "pending" | "complete"
    operationId: string
  }>
  pendingOperation?: {
    operationId: string
    requestHash: string
    expectedRevision: number
    scopes: KeeperDisconnectScope[]
    status: "pending"
  }
}
export type KeeperDisconnectReceipt = {
  integrationId: string
  operationId: string
  requestHash: string
  revision: number
  status: "removed" | "pending"
  scopes: Array<{ workspaceId: string; grantEpoch: number; state: "removed" | "pending"; cleanup: "complete" | "pending" }>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null
}

function parseScopes(value: unknown): KeeperIntegrationScope[] {
  if (!Array.isArray(value)) throw new Error("Rusty returned malformed integration scopes.")
  const ids = new Set<string>()
  return value.map(raw => {
    const item = record(raw)
    const workspaceId = item?.workspaceId
    const grantEpoch = item?.grantEpoch
    const activationOperationId = item?.activationOperationId
    if (typeof workspaceId !== "string" || !workspaceId || ids.has(workspaceId)
      || !Number.isSafeInteger(grantEpoch) || (grantEpoch as number) < 1 || item?.state !== "active"
      || typeof activationOperationId !== "string" || !activationOperationId) {
      throw new Error("Rusty returned malformed integration scope status.")
    }
    ids.add(workspaceId)
    return { workspaceId, grantEpoch: grantEpoch as number, activationOperationId, state: "active" }
  })
}

function parseTombstones(value: unknown): KeeperIntegrationStatus["tombstones"] {
  if (!Array.isArray(value)) throw new Error("Rusty returned malformed integration tombstones.")
  const ids = new Set<string>()
  return value.map(raw => {
    const item = record(raw)
    const workspaceId = item?.workspaceId
    const grantEpoch = item?.grantEpoch
    const operationId = item?.operationId
    if (typeof workspaceId !== "string" || !workspaceId || ids.has(workspaceId)
      || !Number.isSafeInteger(grantEpoch) || (grantEpoch as number) < 1
      || !["pending", "removed"].includes(String(item?.state))
      || !["pending", "complete"].includes(String(item?.cleanup))
      || typeof operationId !== "string" || !operationId) throw new Error("Rusty returned malformed integration tombstone.")
    ids.add(workspaceId)
    return { workspaceId, grantEpoch: grantEpoch as number, operationId,
      state: item.state as "pending" | "removed", cleanup: item.cleanup as "pending" | "complete" }
  })
}

function parseBaselineWorkspaceIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 512) throw new Error("Rusty returned malformed future-board baseline.")
  const ids = value.map(id => typeof id === "string" ? id : "")
  if (ids.some(id => !id) || new Set(ids).size !== ids.length
    || ids.some((id, index) => index > 0 && ids[index - 1]! > id)) {
    throw new Error("Rusty returned malformed future-board baseline.")
  }
  return ids
}

function parseIntegrationPolicy(value: unknown): { futureBoards: boolean; baselineWorkspaceIds?: string[] } {
  const policy = record(value)
  if (typeof policy?.futureBoards !== "boolean") throw new Error("Rusty returned malformed integration status.")
  const baselineWorkspaceIds = parseBaselineWorkspaceIds(policy.baselineWorkspaceIds)
  return { futureBoards: policy.futureBoards, ...(baselineWorkspaceIds ? { baselineWorkspaceIds } : {}) }
}

function parsePending(value: unknown, scopes: KeeperIntegrationScope[],
  tombstones: KeeperIntegrationStatus["tombstones"]): KeeperIntegrationStatus["pendingOperation"] {
  if (isAbsent(value)) return undefined
  const item = record(value)
  if (!item || typeof item.operationId !== "string" || !item.operationId || typeof item.requestHash !== "string"
    || !Number.isSafeInteger(item.expectedRevision) || !Array.isArray(item.scopes) || item.status !== "pending") {
    throw new Error("Rusty returned malformed pending integration operation.")
  }
  const ids = new Set<string>()
  const pendingScopes = (item.scopes as unknown[]).map(raw => {
    const scope = record(raw)
    if (typeof scope?.workspaceId !== "string" || !scope.workspaceId || ids.has(scope.workspaceId)
      || !Number.isSafeInteger(scope.expectedGrantEpoch) || (scope.expectedGrantEpoch as number) < 1) {
      throw new Error("Rusty returned malformed pending integration scope.")
    }
    ids.add(scope.workspaceId)
    return { workspaceId: scope.workspaceId, expectedGrantEpoch: scope.expectedGrantEpoch as number }
  })
  if (!pendingScopes.length) throw new Error("Rusty returned an empty pending integration operation.")
  for (const scope of pendingScopes) {
    const tombstone = tombstones.find(candidate => candidate.workspaceId === scope.workspaceId
      && candidate.grantEpoch === scope.expectedGrantEpoch && candidate.operationId === item.operationId)
    if (!tombstone || tombstone.state !== "pending" || tombstone.cleanup !== "pending"
      || scopes.some(active => active.workspaceId === scope.workspaceId)) {
      throw new Error("Rusty pending operation does not match its scope tombstones.")
    }
  }
  return { operationId: item.operationId, requestHash: item.requestHash,
    expectedRevision: item.expectedRevision as number, scopes: pendingScopes, status: "pending" }
}

function parseIntegration(raw: unknown): KeeperIntegrationStatus {
  const item = record(raw)
  const policy = parseIntegrationPolicy(item?.policy)
  if (!item || typeof item.integrationId !== "string" || !item.integrationId
    || !Number.isSafeInteger(item.revision) || (item.revision as number) < 0) throw new Error("Rusty returned malformed integration status.")
  const scopes = parseScopes(item.scopes)
  const tombstones = parseTombstones(item.tombstones)
  for (const scope of scopes) {
    const tombstone = tombstones.find(candidate => candidate.workspaceId === scope.workspaceId)
    if (tombstone && (tombstone.grantEpoch >= scope.grantEpoch || tombstone.state !== "removed" || tombstone.cleanup !== "complete")) {
      throw new Error("Rusty active scope does not advance its completed removal generation.")
    }
  }
  const pendingOperation = parsePending(item.pendingOperation, scopes, tombstones)
  return { integrationId: item.integrationId, revision: item.revision as number,
    ...policy,
    scopes, tombstones, ...(pendingOperation ? { pendingOperation } : {}) }
}

export function parseKeeperIntegrationStatus(payload: Record<string, unknown>, discovery: LighthouseDiscovery) {
  if (payload.servicePersonId !== discovery.personId || payload.serviceDeviceId !== discovery.deviceId || payload.serviceOrigin !== discovery.origin) {
    throw new Error("Rusty status belongs to a different service identity or address.")
  }
  if (!Number.isSafeInteger(payload.revision) || (payload.revision as number) < 0 || !Array.isArray(payload.integrations)) {
    throw new Error("Rusty returned invalid integration status.")
  }
  const integrations = payload.integrations.map(parseIntegration)
  if (new Set(integrations.map(item => item.integrationId)).size !== integrations.length) {
    throw new Error("Rusty returned duplicate keeper integrations.")
  }
  return integrations
}
