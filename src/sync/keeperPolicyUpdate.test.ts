import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  keeperIntegrationReferences: vi.fn(),
  discoverLighthouse: vi.fn(),
  getKeeperIntegrationStatus: vi.fn(),
  beginKeeperPairing: vi.fn(),
}))

vi.mock("./ownerKeeper", () => ({ keeperIntegrationReferences: mocks.keeperIntegrationReferences }))
vi.mock("./lighthouseDiscovery", () => ({ discoverLighthouse: mocks.discoverLighthouse }))
vi.mock("./lighthousePairing", () => ({
  getKeeperIntegrationStatus: mocks.getKeeperIntegrationStatus,
  beginKeeperPairing: mocks.beginKeeperPairing,
}))

import { beginKeeperPolicyUpdate } from "./keeperPolicyUpdate"

const reference = { integrationId: "integration-a", serviceOrigin: "https://rusty.example",
  servicePersonId: "rusty-person", state: "active" }
const discovery = { origin: "https://rusty.example", personId: "rusty-person" }
const active = { integrationId: "integration-a", futureBoards: false, scopes: [
  { workspaceId: "active-board", grantEpoch: 3, state: "active" as const },
], tombstones: [{ workspaceId: "removed-board", grantEpoch: 2, state: "removed" as const }] }
const pairing = { pairingId: "settings-pairing" }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.keeperIntegrationReferences.mockResolvedValue({ integrations: { "integration-a": reference } })
  mocks.discoverLighthouse.mockResolvedValue(discovery)
  mocks.getKeeperIntegrationStatus.mockResolvedValue({ integrations: [active] })
  mocks.beginKeeperPairing.mockResolvedValue(pairing)
})

describe("future-board policy approval", () => {
  it("requests policy-only owner and operator approval with complete owned-board baseline", async () => {
    await expect(beginKeeperPolicyUpdate("rusty-person", ["newly-owned", "active-board", "newly-owned"]))
      .resolves.toBe(pairing)
    expect(mocks.beginKeeperPairing).toHaveBeenCalledWith(discovery, [], {
      futureBoards: true, futureBoardBaselineIds: ["active-board", "newly-owned", "removed-board"], policyOnly: true,
    })
  })

  it("requires saved active integration and rejects pending or already-enabled service state", async () => {
    mocks.keeperIntegrationReferences.mockResolvedValueOnce({ integrations: {} })
    await expect(beginKeeperPolicyUpdate("rusty-person", [])).rejects.toThrow("could not be verified")
    mocks.getKeeperIntegrationStatus.mockResolvedValueOnce({ integrations: [] })
    await expect(beginKeeperPolicyUpdate("rusty-person", [])).rejects.toThrow("changed or has cleanup pending")
    mocks.getKeeperIntegrationStatus.mockResolvedValueOnce({ integrations: [{ ...active, pendingOperation: { operationId: "pending" } }] })
    await expect(beginKeeperPolicyUpdate("rusty-person", [])).rejects.toThrow("changed or has cleanup pending")
    mocks.getKeeperIntegrationStatus.mockResolvedValueOnce({ integrations: [{ ...active, futureBoards: true }] })
    await expect(beginKeeperPolicyUpdate("rusty-person", [])).rejects.toThrow("changed or has cleanup pending")
    expect(mocks.beginKeeperPairing).not.toHaveBeenCalled()
  })
})
