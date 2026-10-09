import { describe, expect, it } from "vitest"
import type { KeeperPairing } from "./keeperPairing"
import { assertOwnerOriginAdmission, ownerOriginForDiscovery } from "./keeperOriginAdmission"

const pairing = {
  controllerOrigin: "https://match.example",
  workspaces: [{ id: "board-a", title: "A" }, { id: "board-b", title: "B" }],
  futureBoards: true,
  futureBoardBaselineIds: ["board-a", "board-b", "board-c"],
} as KeeperPairing

const approvedStatus = {
  admissionSource: "owner_origin",
  controllerOrigin: "https://match.example",
  controllerPersonId: "owner-person",
  controllerDeviceId: "owner-device",
  operatorApproved: true,
  controllerApproved: true,
  approvedWorkspaceIds: ["board-b", "board-a"],
  futureBoards: true,
  baselineWorkspaceIds: ["board-a", "board-b", "board-c"],
}

describe("owner-origin admission status", () => {
  it("accepts signed approval only for exact owner, device, scopes and policy", () => {
    expect(() => assertOwnerOriginAdmission(approvedStatus, pairing, "owner-person", "owner-device")).not.toThrow()
  })

  it.each([
    ["foreign origin", { controllerOrigin: "https://foreign.example" }],
    ["legacy operator approval", { admissionSource: "operator" }],
    ["another owner", { controllerPersonId: "other-person" }],
    ["another device", { controllerDeviceId: "other-device" }],
    ["missing controller approval", { controllerApproved: false }],
    ["missing service approval", { operatorApproved: false }],
    ["missing a requested board", { approvedWorkspaceIds: ["board-a"] }],
    ["adding an unrequested board", { approvedWorkspaceIds: ["board-a", "board-b", "board-c"] }],
    ["changed future policy", { futureBoards: false }],
    ["changed future baseline", { baselineWorkspaceIds: ["board-a", "board-b"] }],
  ])("rejects %s", (_reason, change) => {
    expect(() => assertOwnerOriginAdmission({ ...approvedStatus, ...change }, pairing, "owner-person", "owner-device"))
      .toThrow("Rusty did not confirm owner-origin approval")
  })

  it("leaves saved legacy pairings without a signed origin on their manual path", () => {
    const legacy = { ...pairing, controllerOrigin: undefined }
    expect(() => assertOwnerOriginAdmission({ status: "approved" }, legacy, "owner-person", "owner-device")).not.toThrow()
  })

  it("does not enable origin admission for old descriptors", () => {
    const discovery = { capabilities: { pairing: true } } as KeeperPairing["discovery"]
    expect(ownerOriginForDiscovery(discovery)).toBeUndefined()
  })
})
