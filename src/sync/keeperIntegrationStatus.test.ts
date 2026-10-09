import { describe, expect, it } from "vitest"
import type { KeeperDiscovery } from "./keeperDiscovery"
import { assertKeeperGrantFloorRefreshAllowed, keeperIntegrationSettingsSupported, parseKeeperIntegrationStatus } from "./keeperIntegrationStatus"

const discovery: KeeperDiscovery = {
  origin: "https://rusty.example",
  displayName: "Rusty",
  personId: "service-person",
  publicKey: "service-key",
  deviceId: "service-device",
  certificates: [],
  fingerprint: "service-fingerprint",
  capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true, blobReplication: true, pairing: true },
}

type IntegrationPayload = {
  integrationId: string
  revision: number
  policy: { futureBoards: boolean; baselineWorkspaceIds?: string[] }
  scopes: Array<{ workspaceId: string; grantEpoch: number; state: string; activationOperationId: string }>
  tombstones: Array<{ workspaceId: string; grantEpoch: number; operationId: string; state: string; cleanup: string }>
  pendingOperation?: unknown
}

type StatusPayload = {
  servicePersonId: string
  serviceDeviceId: string
  serviceOrigin: string
  revision: number
  integrations: IntegrationPayload[]
}

function status(pendingOperation: unknown): StatusPayload {
  return {
    servicePersonId: discovery.personId,
    serviceDeviceId: discovery.deviceId,
    serviceOrigin: discovery.origin,
    revision: 2,
    integrations: [{
      integrationId: "integration-1",
      revision: 2,
      policy: { futureBoards: false, baselineWorkspaceIds: undefined as string[] | undefined },
      scopes: [{ workspaceId: "board-1", grantEpoch: 1, state: "active", activationOperationId: "activation-1" }],
      tombstones: [],
      pendingOperation,
    }],
  }
}

describe("keeper integration status", () => {
  it("fails closed when a service omits or malforms signed settings capability", () => {
    expect(keeperIntegrationSettingsSupported({ capabilities: { integrationSettings: true } })).toBe(true)
    expect(keeperIntegrationSettingsSupported({ capabilities: { integrationSettings: false } })).toBe(false)
    expect(keeperIntegrationSettingsSupported({ capabilities: {} })).toBe(false)
    expect(keeperIntegrationSettingsSupported({ capabilities: null })).toBe(false)
    expect(keeperIntegrationSettingsSupported({ capabilities: { integrationSettings: "true" } })).toBe(false)
  })

  it("accepts Rusty's explicit null for an absent pending operation", () => {
    const [integration] = parseKeeperIntegrationStatus(status(null), discovery)
    expect(integration?.scopes.map(scope => scope.workspaceId)).toEqual(["board-1"])
    expect(integration?.pendingOperation).toBeUndefined()
  })

  it("accepts an omitted pending operation for compatible service responses", () => {
    const payload = status(null)
    delete payload.integrations[0]!.pendingOperation
    const [integration] = parseKeeperIntegrationStatus(payload, discovery)
    expect(integration?.pendingOperation).toBeUndefined()
  })

  it("rejects malformed pending operations instead of treating them as absent", () => {
    expect(() => parseKeeperIntegrationStatus(status({ status: "pending" }), discovery))
      .toThrow("Rusty returned malformed pending integration operation.")
  })

  it("parses a unique future-board baseline and rejects ambiguous signed policy", () => {
    const payload = status(null)
    payload.integrations[0]!.policy = { futureBoards: true, baselineWorkspaceIds: ["board-1", "old-board"] }
    expect(parseKeeperIntegrationStatus(payload, discovery)[0]?.baselineWorkspaceIds)
      .toEqual(["board-1", "old-board"])
    payload.integrations[0]!.policy = { futureBoards: true, baselineWorkspaceIds: ["board-1", "board-1"] }
    expect(() => parseKeeperIntegrationStatus(payload, discovery)).toThrow("Rusty returned malformed future-board baseline.")
  })

  it("keeps exact pending removal scope discoverable after local access is revoked", () => {
    const payload = status({
      operationId: "remove-1",
      requestHash: "request-hash",
      expectedRevision: 2,
      scopes: [{ workspaceId: "board-1", expectedGrantEpoch: 1 }],
      status: "pending",
    })
    const integration = payload.integrations[0]!
    integration.scopes = []
    integration.tombstones = [{
      workspaceId: "board-1", grantEpoch: 1, operationId: "remove-1",
      state: "pending", cleanup: "pending",
    }]

    const [parsed] = parseKeeperIntegrationStatus(payload, discovery)

    expect(parsed?.scopes).toEqual([])
    expect(parsed?.pendingOperation?.scopes).toEqual([{ workspaceId: "board-1", expectedGrantEpoch: 1 }])
    expect(parsed?.tombstones[0]).toMatchObject({ state: "pending", cleanup: "pending", operationId: "remove-1" })
  })

  it("accepts a fresh higher grant epoch while retaining completed removal history", () => {
    const payload = status(null)
    const integration = payload.integrations[0]!
    integration.scopes[0]!.grantEpoch = 2
    integration.scopes[0]!.activationOperationId = "activation-2"
    integration.tombstones = [{
      workspaceId: "board-1", grantEpoch: 1, operationId: "remove-1",
      state: "removed", cleanup: "complete",
    }]

    const [parsed] = parseKeeperIntegrationStatus(payload, discovery)

    expect(parsed?.scopes[0]).toMatchObject({ grantEpoch: 2, activationOperationId: "activation-2" })
    expect(parsed?.tombstones[0]).toMatchObject({ grantEpoch: 1, state: "removed", cleanup: "complete" })
  })

  it("rejects a pending removal whose tombstone belongs to another operation", () => {
    const payload = status({
      operationId: "remove-new",
      requestHash: "request-hash",
      expectedRevision: 2,
      scopes: [{ workspaceId: "board-1", expectedGrantEpoch: 1 }],
      status: "pending",
    })
    const integration = payload.integrations[0]!
    integration.scopes = []
    integration.tombstones = [{
      workspaceId: "board-1", grantEpoch: 1, operationId: "remove-old",
      state: "pending", cleanup: "pending",
    }]

    expect(() => parseKeeperIntegrationStatus(payload, discovery))
      .toThrow("Rusty pending operation does not match its scope tombstones.")
  })

  it("blocks grant refresh for a pending target integration even when policy-only request has no boards", () => {
    const payload = status({ operationId: "cleanup-1", requestHash: "hash", expectedRevision: 2,
      scopes: [{ workspaceId: "board-1", expectedGrantEpoch: 1 }], status: "pending" })
    payload.integrations[0]!.scopes = []
    payload.integrations[0]!.tombstones = [{ workspaceId: "board-1", grantEpoch: 1,
      operationId: "cleanup-1", state: "pending", cleanup: "pending" }]
    const integration = parseKeeperIntegrationStatus(payload, discovery)

    expect(() => assertKeeperGrantFloorRefreshAllowed(integration, [], "integration-1"))
      .toThrow("board cleanup pending")
  })

  it("blocks overlapping pending scopes but allows another integration's unrelated cleanup", () => {
    const payload = status({ operationId: "cleanup-1", requestHash: "hash", expectedRevision: 2,
      scopes: [{ workspaceId: "other-board", expectedGrantEpoch: 1 }], status: "pending" })
    payload.integrations[0]!.scopes = []
    payload.integrations[0]!.tombstones = [{ workspaceId: "other-board", grantEpoch: 1,
      operationId: "cleanup-1", state: "pending", cleanup: "pending" }]
    const integration = parseKeeperIntegrationStatus(payload, discovery)

    expect(() => assertKeeperGrantFloorRefreshAllowed(integration, ["other-board"], "different-integration"))
      .toThrow("board cleanup pending")
    expect(() => assertKeeperGrantFloorRefreshAllowed(integration, ["board-1"], "different-integration"))
      .not.toThrow()
    expect(() => assertKeeperGrantFloorRefreshAllowed(integration, ["board-1"], "integration-1"))
      .toThrow("board cleanup pending")
  })
})
