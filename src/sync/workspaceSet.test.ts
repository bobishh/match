import { describe, expect, it, vi } from "vitest"
import { encodePairingFrame, inspectPairingFrame } from "./protocol"
import type { SyncConnection } from "./transport"
import { liveWorkspaceSetSync, startMeshHeartbeat, workspaceSet } from "./workspaceSet"

describe("workspace invitation scope", () => {
  it.each([
    [{ id: "a", bytes: "AA" }, { id: "private", bytes: "AA" }],
    [{ id: "a", bytes: "AA" }, { id: "a", bytes: "AA" }],
    [{ id: "a", bytes: "AA" }],
  ].map(entries => ({ entries })))("rejects a mismatched or incomplete set before any document is saved: %j", async ({ entries }) => {
    const merge = vi.fn()
    const replica = workspaceSet({ read: vi.fn(), merge, activate: vi.fn() }, ["a", "b"])
    await expect(replica.receive(new TextEncoder().encode(JSON.stringify(entries)))).rejects.toThrow(/different set/)
    expect(merge).not.toHaveBeenCalled()
  })

  it("Given a failing sync section, when a snapshot is received, then diagnostics identify its stage", async () => {
    const replica = workspaceSet({
      read: vi.fn(), merge: vi.fn(), activate: vi.fn(),
      mergeChat: vi.fn().mockRejectedValue(new Error("Invalid workspace grant")),
    }, ["workspace"])
    const bytes = new TextEncoder().encode(JSON.stringify([{ id: "workspace", bytes: "AA", chat: {} }]))

    await expect(replica.receive(bytes)).rejects.toThrow("Chat workspace: Invalid workspace grant")
  })
})

describe("live mesh heartbeat", () => {
  it("requires an authenticated acknowledgement from the remote peer", async () => {
    const sent: Uint8Array[] = []
    const connection: SyncConnection = {
      openStream: async () => ({
        send: async bytes => { sent.push(bytes) },
        closeSend: async () => {},
        read: async () => encodePairingFrame("sync-heartbeat-ack", "mesh-secret", new Uint8Array()),
      }),
      acceptStream: () => new Promise(() => {}),
      close: async () => {},
    }
    const replica = workspaceSet({ read: vi.fn(), merge: vi.fn(), activate: vi.fn() }, ["workspace"])
    const session = liveWorkspaceSetSync(connection, "mesh-secret", replica)

    await session.heartbeat?.()

    expect(sent).toHaveLength(1)
    expect(inspectPairingFrame(sent[0]!)).toEqual({ type: "sync-heartbeat", secret: "mesh-secret" })
    await session.close()
  })

  it("Given one heartbeat is pending, when another interval passes, then the scheduler does not stack probes", async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const heartbeat = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const stop = startMeshHeartbeat({ heartbeat }, vi.fn(), () => 0.5)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(heartbeat).toHaveBeenCalledOnce()
    finish()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(heartbeat).toHaveBeenCalledTimes(2)

    stop()
    vi.useRealTimers()
  })

  it("Given a joined peer requests durable handoff, when live sync receives it, then control reaches the host without parsing it as data", async () => {
    let delivered = false
    const stream = {
      send: vi.fn(), closeSend: vi.fn(),
      read: vi.fn(async () => encodePairingFrame("mesh-handoff-request", "mesh-secret", new Uint8Array())),
    }
    let accepted = false
    const connection: SyncConnection = {
      openStream: vi.fn(),
      acceptStream: vi.fn(async () => {
        if (!accepted) { accepted = true; return stream }
        return new Promise<never>(() => {})
      }),
      close: vi.fn(async () => {}),
    }
    const replica = workspaceSet({ read: vi.fn(), merge: vi.fn(), activate: vi.fn() }, ["workspace"])
    const session = liveWorkspaceSetSync(connection, "mesh-secret", replica, {
      onHandoffRequest: async () => { delivered = true },
    })

    await vi.waitFor(() => expect(delivered).toBe(true))
    await session.close()
  })
})
