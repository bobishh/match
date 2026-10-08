import { describe, expect, it } from "vitest"
import type { KeeperIntegrationReference } from "../domain/model"
import type { KeeperIntegrationStatus } from "./keeperIntegrationStatus"
import { canonicalKeeperIntegrationId, selectCanonicalServiceIntegration, selectKeeperReference } from "./keeperIntegrationSelection"

function serviceIntegration(integrationId: string, overrides: Partial<KeeperIntegrationStatus> = {}): KeeperIntegrationStatus {
  return { integrationId, revision: 1, futureBoards: false, scopes: [], tombstones: [], ...overrides }
}

function reference(integrationId: string, revision: number, state: KeeperIntegrationReference["state"]): KeeperIntegrationReference {
  return { integrationId, serviceOrigin: "https://rusty.example", servicePersonId: "rusty-person",
    serviceDeviceId: "rusty-device", servicePublicKey: "key", serviceCertificates: [], workspaceIds: [],
    futureBoards: false, revision, state, verifiedAt: "2026-10-08T00:00:00.000Z" }
}

describe("keeper integration selection", () => {
  it("derives Rusty's stable owner/service integration ID", async () => {
    await expect(canonicalKeeperIntegrationId("owner-person", "rusty-person"))
      .resolves.toBe("4KvCYg4Y1dNSg4_p3KibEnDvbnLTat40WoczowmzKkI")
  })

  it("selects canonical live integration beside terminal legacy history", async () => {
    const canonical = await canonicalKeeperIntegrationId("owner-person", "rusty-person")
    const history = serviceIntegration("random-legacy-id", { revision: 9, tombstones: [
      { workspaceId: "removed-board", grantEpoch: 8, state: "removed", cleanup: "complete", operationId: "remove" },
    ] })
    const live = serviceIntegration(canonical, { revision: 2, scopes: [
      { workspaceId: "active-board", grantEpoch: 3, state: "active", activationOperationId: "activate" },
    ] })
    expect(selectCanonicalServiceIntegration([history, live], canonical)).toEqual(live)
    expect(() => selectCanonicalServiceIntegration([history, serviceIntegration("other-live", {
      scopes: [{ workspaceId: "other-board", grantEpoch: 1, state: "active", activationOperationId: "x" }],
    })], canonical)).toThrow("conflicting active keeper integrations")
  })

  it("treats a lone retired legacy integration as history, not rebind target", async () => {
    const canonical = await canonicalKeeperIntegrationId("owner-person", "rusty-person")
    const history = serviceIntegration("random-legacy-id", { tombstones: [
      { workspaceId: "removed-board", grantEpoch: 8, state: "removed", cleanup: "complete", operationId: "remove" },
    ] })
    expect(selectCanonicalServiceIntegration([history], canonical)).toBeUndefined()
    expect(selectCanonicalServiceIntegration([serviceIntegration(canonical, { revision: 8 })], canonical)?.revision).toBe(8)
  })

  it("fails closed on duplicate canonical rows or unfinished legacy tombstones", async () => {
    const canonical = await canonicalKeeperIntegrationId("owner-person", "rusty-person")
    expect(() => selectCanonicalServiceIntegration([
      serviceIntegration(canonical), serviceIntegration(canonical, { revision: 2 }),
    ], canonical)).toThrow("duplicate canonical keeper integrations")
    expect(() => selectCanonicalServiceIntegration([serviceIntegration("legacy", { tombstones: [
      { workspaceId: "board", grantEpoch: 4, state: "removed", cleanup: "pending", operationId: "remove" },
    ] })], canonical)).toThrow("conflicting active keeper integrations")
  })

  it("never ignores active, pending, or future-enabled legacy rows", async () => {
    const canonical = await canonicalKeeperIntegrationId("owner-person", "rusty-person")
    const active = serviceIntegration("legacy", { scopes: [
      { workspaceId: "board", grantEpoch: 1, state: "active", activationOperationId: "activate" },
    ] })
    const pending = serviceIntegration("legacy", { pendingOperation: {
      operationId: "pending", requestHash: "hash", expectedRevision: 1, scopes: [], status: "pending",
    } })
    const future = serviceIntegration("legacy", { futureBoards: true })
    for (const legacy of [active, pending, future]) {
      expect(() => selectCanonicalServiceIntegration([legacy], canonical)).toThrow("conflicting active keeper integrations")
    }
  })

  it("ignores removed references only when one live target exists and rejects ambiguity", () => {
    const values = { old: reference("old", 99, "removed"), current: reference("current", 1, "active") }
    expect(selectKeeperReference(values, "rusty-person")?.integrationId).toBe("current")
    expect(() => selectKeeperReference({ ...values, second: reference("second", 2, "active") }, "rusty-person"))
      .toThrow("Multiple saved Rusty integrations need review")
    expect(selectKeeperReference({ old: values.old }, "rusty-person")).toBeUndefined()
    expect(selectKeeperReference({ old: { ...values.old, pendingRemoval: {
      operationId: "remove", expectedRevision: 99, scopes: [{ workspaceId: "board", expectedGrantEpoch: 1 }],
    } } }, "rusty-person", { allowRemovalRetry: true })?.integrationId).toBe("old")
  })
})
