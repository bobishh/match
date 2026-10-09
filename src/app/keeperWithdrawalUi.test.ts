import { describe, expect, it } from "vitest"
import { pairingStatusTransition } from "./keeperWithdrawalUi"

describe("keeper withdrawal status transition", () => {
  it("Given a saved cancellation intent, When status reports approved, Then retry stays pending and provisioning stays blocked", () => {
    expect(pairingStatusTransition({ status: "approved" }, true)).toEqual({
      status: "cancel_pending", provision: false, clearError: false,
    })
  })

  it("Given a saved cancellation intent, When signed status confirms cancellation, Then cancellation is terminal", () => {
    expect(pairingStatusTransition({ status: "cancelled", withdrawal: {
      operationId: "op-1", requestHash: "hash-1", status: "cancelled",
    } }, true)).toEqual({ status: "cancelled", provision: false, clearError: true })
  })
})
