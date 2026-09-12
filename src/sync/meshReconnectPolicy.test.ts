import { describe, expect, it, vi } from "vitest"
import type { SyncNode } from "./transport"
import { SyncNetworkError } from "./workspaceSet"
import { MeshReconnectPolicy } from "./meshReconnectPolicy"

describe("MeshReconnectPolicy", () => {
  it("Given direct transport lost an established stream, when the peer reconnects, then it falls back to relay", async () => {
    const dial = vi.fn(async () => ({ mode: "direct" }))
    const dialRelay = vi.fn(async () => ({ mode: "relay" }))
    const node = { dial, dialRelay } as unknown as SyncNode
    const policy = new MeshReconnectPolicy()

    await policy.dial(node, "workspace:phone", "phone-endpoint")
    policy.recordFailure("workspace:phone", new SyncNetworkError("connection lost"))
    const connection = await policy.dial(node, "workspace:phone", "phone-endpoint")

    expect(dial).toHaveBeenCalledTimes(1)
    expect(dialRelay).toHaveBeenCalledTimes(1)
    expect(connection).toEqual({ mode: "relay" })
  })

  it("Given relay dialing is unavailable, when direct transport fails, then reconnect still uses direct dialing", async () => {
    const dial = vi.fn(async () => ({ mode: "direct" }))
    const node = { dial } as unknown as SyncNode
    const policy = new MeshReconnectPolicy()

    policy.recordFailure("workspace:phone", new SyncNetworkError("connection lost"))
    await policy.dial(node, "workspace:phone", "phone-endpoint")

    expect(dial).toHaveBeenCalledTimes(1)
  })
})
