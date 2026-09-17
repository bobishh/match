import { describe, expect, it, vi } from "vitest"
import { encodePairingFrame, inspectPairingFrame } from "@meta-uber/mesh-pairing"
import type { SyncConnection } from "./transport"
import { liveAutomergeWorkspaceSync, liveWorkspaceSetSync, workspaceSet, publishConfirmedWorkspace } from "./workspaceSet"
import { WorkspaceChangeRejected } from "./changeAuthorization"
import { sha256Base64Url } from "../domain/identity"

describe("Confirmed ownership delivery", () => {
  it("waits for a matching receipt instead of treating a sent frame as a durable save", async () => {
    const bytes = new Uint8Array([1, 2, 3])
    let acknowledge!: (bytes: Uint8Array) => void
    const read = new Promise<Uint8Array>(resolve => { acknowledge = resolve })
    const connection = { openStream: async () => ({ send: vi.fn(), closeSend: vi.fn(), read: () => read }) } as never
    let finished = false
    const delivery = publishConfirmedWorkspace(connection, "secret", bytes).then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    acknowledge(encodePairingFrame("mesh-durable-ack", "secret", new TextEncoder().encode(await sha256Base64Url(bytes))))
    await delivery
    expect(finished).toBe(true)
  })

  it("rejects a receipt for different contents", async () => {
    const connection = { openStream: async () => ({ send: vi.fn(), closeSend: vi.fn(),
      read: async () => encodePairingFrame("mesh-durable-ack", "secret", new TextEncoder().encode("wrong")) }) } as never
    await expect(publishConfirmedWorkspace(connection, "secret", new Uint8Array([1]))).rejects.toThrow(/receipt/i)
  })

  it("acknowledges only after the document and ownership metadata have been persisted", async () => {
    let save!: () => void
    const persisted = new Promise<void>(resolve => { save = resolve })
    const bytes = new TextEncoder().encode(JSON.stringify([{ id: "workspace", bytes: "AA", mesh: {} }]))
    const stream = { send: vi.fn(), closeSend: vi.fn(), read: async () => encodePairingFrame("mesh-durable-batch", "secret", bytes) }
    let accepted = false
    const connection = { acceptStream: async () => { if (!accepted) { accepted = true; return stream }; return new Promise<never>(() => {}) },
      close: vi.fn(), openStream: vi.fn() }
    const mergeMesh = vi.fn(() => persisted)
    const session = liveWorkspaceSetSync(connection, "secret", workspaceSet({ read: vi.fn(), merge: vi.fn(), activate: vi.fn(), mergeMesh }, ["workspace"]))
    await vi.waitFor(() => expect(mergeMesh).toHaveBeenCalled())
    expect(stream.send).not.toHaveBeenCalled()
    save()
    await vi.waitFor(() => expect(stream.send).toHaveBeenCalled())
    expect(inspectPairingFrame(stream.send.mock.calls[0]![0]).type).toBe("mesh-durable-ack")
    await session.close()
  })
})

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

describe("incremental workspace control plane", () => {
  it("Given ownership state changes, when a control frame arrives, then it merges without a full workspace document", async () => {
    const mergeMesh = vi.fn(async () => {})
    let accepted = false
    const stream = {
      send: vi.fn(), closeSend: vi.fn(async () => {}),
      read: vi.fn(async () => encodePairingFrame("mesh-control-sync", "mesh-secret",
        new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: "workspace", mesh: { epoch: 2 } })))),
    }
    const connection: SyncConnection = {
      openStream: vi.fn(),
      acceptStream: vi.fn(async () => {
        if (!accepted) { accepted = true; return stream }
        return new Promise<never>(() => {})
      }),
      close: vi.fn(async () => {}),
    }
    const session = liveAutomergeWorkspaceSync(connection, "mesh-secret", {
      read: async () => new Uint8Array(), merge: vi.fn(), activate: vi.fn(), mergeMesh,
    }, "workspace", "local", "remote")

    await vi.waitFor(() => expect(mergeMesh).toHaveBeenCalledWith("workspace", { epoch: 2 }))
    expect(stream.closeSend).toHaveBeenCalled()
    await session.close()
  })
})


describe("rejected document isolation", () => {
  it("keeps heartbeat and control alive after a rejected document and can accept a later corrected frame", async () => {
    const error = new WorkspaceChangeRejected("Unsigned workspace change rejected")
    const receive = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ response: null, acceptedChanges: 1 })
    const engine = { receive, generate: vi.fn(async () => null) }
    const reject = vi.fn()
    const mergeMesh = vi.fn()
    const sync = () => encodePairingFrame("mesh-automerge-sync", "secret", new TextEncoder().encode(JSON.stringify({message:"AA"})))
    const frames = [sync(), encodePairingFrame("sync-heartbeat", "secret", new Uint8Array()),
      encodePairingFrame("mesh-control-sync", "secret", new TextEncoder().encode(JSON.stringify({version:1,workspaceId:"workspace",mesh:{epoch:2}}))), sync()]
    const streams = frames.map(frame => ({ read: async () => frame, send: vi.fn(), closeSend: vi.fn() }))
    let index = 0
    const connection = { acceptStream: async () => streams[index++] ?? new Promise<never>(() => {}), close: vi.fn(), openStream: vi.fn(async () => ({send:vi.fn(), closeSend:vi.fn(), read:vi.fn(async () => new Uint8Array())})) }
    const session = liveAutomergeWorkspaceSync(connection, "secret", {read:vi.fn(),merge:vi.fn(),activate:vi.fn(),mergeMesh},
      "workspace","local","remote",engine as never,reject)
    let ended = false
    void session.done.then(() => { ended = true }, () => { ended = true })
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2))
    expect(reject).toHaveBeenCalledWith(error)
    expect(ended).toBe(false)
    expect(connection.close).not.toHaveBeenCalled()
    expect(inspectPairingFrame(streams[1]!.send.mock.calls[0]![0]).type).toBe("sync-heartbeat-ack")
    expect(mergeMesh).toHaveBeenCalledWith("workspace",{epoch:2})
    await expect(session.publish()).resolves.toBeUndefined()
    await session.close()
  })
})
