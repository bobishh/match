import { describe, expect, it, vi } from "vitest"
import type { DeviceEnrollmentInvitation } from "@meta-uber/mesh-pairing"
import { dialEnrollmentPeer } from "./deviceSyncEnrollment"
import type { SyncConnection, SyncNode } from "./transport"

const connection = (): SyncConnection => ({
  openStream: vi.fn(),
  acceptStream: vi.fn(),
  close: vi.fn(async () => undefined),
})

const invitation = {
  issuerEndpoint: "owner-endpoint",
} as DeviceEnrollmentInvitation

describe("device enrollment dialing", () => {
  it("tries the direct route before falling back to relay", async () => {
    const directConnection = connection()
    const relayConnection = connection()
    const node = {
      dial: vi.fn(async () => directConnection),
      dialRelay: vi.fn(async () => relayConnection),
    } as unknown as SyncNode
    const context = {
      currentRun: () => 7,
      waitToReconnect: vi.fn(async () => undefined),
    }

    const result = await dialEnrollmentPeer(context as never, 7, node, invitation)

    expect(result).toBe(directConnection)
    expect(node.dial).toHaveBeenCalledWith("owner-endpoint")
    expect(node.dialRelay).not.toHaveBeenCalled()
  })

  it("falls back to relay when the direct route cannot connect", async () => {
    const relayConnection = connection()
    const node = {
      dial: vi.fn(async () => { throw new Error("direct route unavailable") }),
      dialRelay: vi.fn(async () => relayConnection),
    } as unknown as SyncNode
    const context = {
      currentRun: () => 3,
      waitToReconnect: vi.fn(async () => undefined),
    }

    const result = await dialEnrollmentPeer(context as never, 3, node, invitation)

    expect(result).toBe(relayConnection)
    expect(node.dial).toHaveBeenCalledWith("owner-endpoint")
    expect(node.dialRelay).toHaveBeenCalledWith("owner-endpoint")
  })
})
