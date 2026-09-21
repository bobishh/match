import { describe, expect, it, vi } from "vitest"
import { encodePairingFrame } from "@meta-uber/mesh-pairing"
import { startPeerSession } from "./deviceSyncHostController"

describe("workspace host handoff", () => {
  it("Given a confirmed mesh handoff, when the host adopts its node, then the guest retains the pairing transport until its own teardown", async () => {
    const request = {
      read: async () => encodePairingFrame("mesh-handoff-request", "secret", new Uint8Array()),
      send: vi.fn(), closeSend: vi.fn(async () => {}),
    }
    const confirmation = {
      read: async () => encodePairingFrame("mesh-handoff-confirmed", "secret", new Uint8Array()),
      send: vi.fn(), closeSend: vi.fn(async () => {}),
    }
    let accepted = 0
    const connection = {
      acceptStream: vi.fn(async () => {
        accepted += 1
        if (accepted === 1) return request
        if (accepted === 2) return confirmation
        return new Promise<never>(() => {})
      }),
      openStream: vi.fn(), close: vi.fn(async () => {}),
    }
    const handoff = vi.fn(async () => {})
    const runtime = {
      run: 1, stopped: () => false, handoff, peers: new Map(), invite: { secret: "secret" },
      context: {
        currentRun: () => 1,
        replaceDirectSession: () => undefined,
        state: { directLive: { value: false }, step: { value: "" } },
      },
    }

    const session = await startPeerSession(runtime as never, connection as never, "guest")

    await vi.waitFor(() => expect(handoff).toHaveBeenCalledOnce())
    expect(connection.close).not.toHaveBeenCalled()
    expect(request.closeSend).toHaveBeenCalledOnce()
    await session.close()
  })
})
