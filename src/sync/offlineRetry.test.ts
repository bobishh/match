import { describe, expect, it } from "vitest"
import { offlineRetryDelay } from "./offlineRetry"

describe("offline retry cadence", () => {
  it("uses 1s, 2s, 5s, then stays at 10s", () => {
    expect([1, 2, 3, 4, 5].map(offlineRetryDelay)).toEqual([1_000, 2_000, 5_000, 10_000, 10_000])
  })
})
