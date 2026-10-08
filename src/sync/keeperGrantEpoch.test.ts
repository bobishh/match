import { describe, expect, it } from "vitest"
import type { KeeperIntegrationStatus } from "./keeperIntegrationStatus"
import { assertKeeperGrantFloorsUnchanged, keeperServiceGrantFloors, nextKeeperGrantEpoch } from "./keeperGrantEpoch"

const integration = (tombstones: KeeperIntegrationStatus["tombstones"], scopes: KeeperIntegrationStatus["scopes"] = []): KeeperIntegrationStatus => ({
  integrationId: "rusty-integration",
  revision: 4,
  futureBoards: false,
  scopes,
  tombstones,
})

describe("keeper owner grant generation", () => {
  it("Given restored local grant history behind Rusty's signed tombstone, when issuing a new board grant, then advances beyond service floor", () => {
    const floors = keeperServiceGrantFloors([
      integration([
        { workspaceId: "job-search", grantEpoch: 5, state: "removed", cleanup: "complete", operationId: "remove-1" },
        { workspaceId: "other-board", grantEpoch: 8, state: "removed", cleanup: "complete", operationId: "remove-2" },
      ]),
      integration([
        { workspaceId: "job-search", grantEpoch: 7, state: "removed", cleanup: "complete", operationId: "remove-3" },
      ]),
      integration([], [{ workspaceId: "job-search", grantEpoch: 9, state: "active", activationOperationId: "activate-4" }]),
    ], ["job-search", "new-board"])

    expect(floors).toEqual({ "job-search": 9, "new-board": 0 })
    expect(nextKeeperGrantEpoch(5, floors["job-search"]!)).toBe(10)
    expect(nextKeeperGrantEpoch(11, floors["job-search"]!)).toBe(11)
  })

  it("Given a lost provisioning reply, when rechecking the same pairing, then excludes its own active scope but retains its tombstone fence", () => {
    const active = integration([], [{ workspaceId: "job-search", grantEpoch: 9, state: "active", activationOperationId: "pairing-1" }])
    const initial = keeperServiceGrantFloors([], ["job-search", "other-board"])
    const afterOwnActivation = keeperServiceGrantFloors([active], ["job-search", "other-board"], active.integrationId)
    expect(afterOwnActivation).toEqual(initial)
    expect(() => assertKeeperGrantFloorsUnchanged(initial, afterOwnActivation, ["job-search", "other-board"])).not.toThrow()

    const concurrentRemoval = integration([
      { workspaceId: "other-board", grantEpoch: 10, state: "removed", cleanup: "complete", operationId: "remove-2" },
    ], [{ workspaceId: "job-search", grantEpoch: 9, state: "active", activationOperationId: "pairing-1" }])
    const advanced = keeperServiceGrantFloors([concurrentRemoval], ["job-search", "other-board"], concurrentRemoval.integrationId)
    expect(advanced["other-board"]).toBe(10)
    expect(advanced["other-board"]).not.toBe(initial["other-board"])
    expect(() => assertKeeperGrantFloorsUnchanged(initial, advanced, ["job-search", "other-board"]))
      .toThrow("Rusty's removal history advanced after this invitation was created.")
  })

  it("Given an invalid epoch, when combining local and service history, then rejects it", () => {
    expect(() => nextKeeperGrantEpoch(0, 4)).toThrow("Keeper grant epoch floor is invalid.")
    expect(() => nextKeeperGrantEpoch(2, Number.MAX_SAFE_INTEGER)).toThrow("Keeper grant epoch floor is invalid.")
    expect(() => nextKeeperGrantEpoch(2, Number.MAX_SAFE_INTEGER + 1)).toThrow("Keeper grant epoch floor is invalid.")
  })
})
