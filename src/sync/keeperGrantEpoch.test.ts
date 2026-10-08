import { describe, expect, it } from "vitest"
import type { KeeperIntegrationStatus } from "./keeperIntegrationStatus"
import { keeperServiceGrantFloors, nextKeeperGrantEpoch } from "./keeperGrantEpoch"

const integration = (tombstones: KeeperIntegrationStatus["tombstones"]): KeeperIntegrationStatus => ({
  integrationId: "rusty-integration",
  revision: 4,
  futureBoards: false,
  scopes: [],
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
    ], ["job-search", "new-board"])

    expect(floors).toEqual({ "job-search": 7, "new-board": 0 })
    expect(nextKeeperGrantEpoch(5, floors["job-search"]!)).toBe(8)
    expect(nextKeeperGrantEpoch(10, floors["job-search"]!)).toBe(10)
  })

  it("Given an invalid epoch, when combining local and service history, then rejects it", () => {
    expect(() => nextKeeperGrantEpoch(0, 4)).toThrow("Keeper grant epoch floor is invalid.")
    expect(() => nextKeeperGrantEpoch(2, Number.MAX_SAFE_INTEGER)).toThrow("Keeper grant epoch floor is invalid.")
    expect(() => nextKeeperGrantEpoch(2, Number.MAX_SAFE_INTEGER + 1)).toThrow("Keeper grant epoch floor is invalid.")
  })
})
