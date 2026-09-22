import { afterEach, describe, expect, it, vi } from "vitest"
import type { DeviceEnrollmentInvitation } from "@meta-uber/mesh-pairing"
import { dialEnrollmentPeer } from "./deviceSyncEnrollment"
import type { SyncConnection, SyncNode } from "./transport"
import { meshTraceSnapshot } from "./meshTrace"

const connection = (): SyncConnection => ({
  openStream: vi.fn(),
  acceptStream: vi.fn(),
  close: vi.fn(async () => undefined),
})

const invitation = {
  issuerEndpoint: "owner-endpoint",
} as DeviceEnrollmentInvitation

describe("device enrollment dialing", () => {
  afterEach(() => vi.useRealTimers())

  it("closes a late losing direct connection without closing the relay winner", async () => {
    vi.useFakeTimers()
    const directConnection = connection()
    const relayConnection = connection()
    let finishDirect!: (value: SyncConnection) => void
    const node = {
      dial: vi.fn(() => new Promise<SyncConnection>(resolve => { finishDirect = resolve })),
      dialRelay: vi.fn(async () => relayConnection),
    } as unknown as SyncNode
    const pending = dialEnrollmentPeer({ currentRun: () => 1 } as never, 1, node, invitation)

    await vi.advanceTimersByTimeAsync(1_500)
    expect(await pending).toBe(relayConnection)
    finishDirect(directConnection)
    await vi.advanceTimersByTimeAsync(0)

    expect(directConnection.close).toHaveBeenCalledOnce()
    expect(relayConnection.close).not.toHaveBeenCalled()
  })

  it("retries direct after discovery recovers even when relay stays unavailable", async () => {
    const winner = connection()
    const node = {
      dial: vi.fn().mockRejectedValueOnce(new Error("No addressing information available"))
        .mockResolvedValue(winner),
      dialRelay: vi.fn(async () => { throw new Error("relay unavailable") }),
    } as unknown as SyncNode
    const context = { currentRun: () => 8, waitToReconnect: vi.fn(async () => undefined) }

    expect(await dialEnrollmentPeer(context as never, 8, node, invitation)).toBe(winner)
    expect(node.dial).toHaveBeenCalledTimes(2)
    expect(context.waitToReconnect).toHaveBeenCalledTimes(1)
    const failure = meshTraceSnapshot().findLast(event => event.event === "enrollment.guest.dial.failed")
    expect(failure?.reason).toContain("No addressing information available")
    expect(failure?.reason).toContain("relay unavailable")
  })

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
