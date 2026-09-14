import { describe, expect, it, vi } from "vitest"
import { encodePairingFrame, inspectPairingFrame } from "./protocol"
import type { SyncConnection } from "./transport"
import { liveWorkspaceSetSync, workspaceSet } from "./workspaceSet"

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
})
