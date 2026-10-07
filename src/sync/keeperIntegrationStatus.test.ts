import { describe, expect, it } from "vitest"
import type { LighthouseDiscovery } from "./lighthouseDiscovery"
import { parseKeeperIntegrationStatus } from "./keeperIntegrationStatus"

const discovery: LighthouseDiscovery = {
  origin: "https://rusty.example",
  displayName: "Rusty",
  personId: "service-person",
  publicKey: "service-key",
  deviceId: "service-device",
  certificates: [],
  fingerprint: "service-fingerprint",
  capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true, blobReplication: true, pairing: true },
}

function status(pendingOperation: unknown) {
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
})
