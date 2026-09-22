import { describe, expect, it, vi } from "vitest"
import { decodePairingFrame, encodePairingFrame, inspectPairingFrame } from "@meta-uber/mesh-pairing"
import type { SyncConnection } from "./transport"
import { liveAutomergeWorkspaceSync, liveWorkspaceSetSync, workspaceSet, publishConfirmedWorkspace, publishOwnerWorkspaceOffer } from "./workspaceSet"
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
  it("keeps the failure reason visible when the board has a long title", async () => {
    const replica = workspaceSet({
      read: async () => { throw new Error("Workspace storage is unavailable") },
      merge: vi.fn(), activate: vi.fn(),
    }, [{ id: "default", title: "Long board title ".repeat(100) }])
    const error = await replica.snapshot().catch(error => error) as Error
    expect(error.message.length).toBeLessThan(512)
    expect(error.message).toContain("Workspace storage is unavailable")
  })

  it("identifies the exact workspace when a multi-workspace snapshot member fails", async () => {
    const failure = new Error("Workspace storage is unavailable")
    const read = vi.fn(async (id: string) => {
      if (id === "second-board") throw failure
      return new Uint8Array([1])
    })
    const replica = workspaceSet({ read, merge: vi.fn(), activate: vi.fn() }, [
      { id: "first-board", title: "Job search" },
      { id: "second-board", title: "Job search" },
    ])

    await expect(replica.snapshot()).rejects.toMatchObject({
      message: expect.stringContaining("Workspace second-board (Job search) snapshot failed: Workspace storage is unavailable"),
      cause: failure,
    })
    expect(read).toHaveBeenCalledWith("first-board")
    expect(read).toHaveBeenCalledWith("second-board")
  })

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

  it("Given workspace validation rejects a snapshot, when the join reports the failure, then its safe schema path is retained", async () => {
    const rejected = new Error("Invalid workspace received.", {
      cause: { code: "invalid_input", field: "entities.card_1.kind" },
    })
    const replica = workspaceSet({
      read: vi.fn(), merge: vi.fn().mockRejectedValue(rejected), activate: vi.fn(),
    }, ["workspace"])
    const bytes = new TextEncoder().encode(JSON.stringify([{ id: "workspace", bytes: "AA" }]))

    await expect(replica.receive(bytes)).rejects.toThrow(
      "Workspace workspace: Invalid workspace received. [invalid_input at entities.card_1.kind]",
    )
  })

  it("validates every invited workspace before persisting any of them", async () => {
    const validate = vi.fn(async (id: string) => {
      if (id === "second") throw new Error("Invalid workspace grant")
    })
    const merge = vi.fn()
    const replica = workspaceSet({ read: vi.fn(), validate, merge, activate: vi.fn() }, ["first", "second"])
    const bytes = new TextEncoder().encode(JSON.stringify([
      { id: "first", bytes: "AA" },
      { id: "second", bytes: "AA" },
    ]))

    await expect(replica.receive(bytes)).rejects.toThrow("Workspace second: Invalid workspace grant")
    expect(validate).toHaveBeenCalledTimes(2)
    expect(merge).not.toHaveBeenCalled()
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
  it("Given control history exceeds 256 KiB, when published, then bounded frames deliver the complete state once", async () => {
    const sent: Uint8Array[] = []
    const authorization = [{ hash: "history", signature: "s".repeat(300_000) }]
    const bytes = new Uint8Array([1])
    const sender = liveAutomergeWorkspaceSync({
      openStream: async () => ({ send: async frame => { sent.push(frame) }, closeSend: async () => {}, read: vi.fn() }),
      acceptStream: () => new Promise(() => {}), close: vi.fn(),
    }, "secret", { read: async () => bytes, merge: vi.fn(), activate: vi.fn(), readAuthorization: async () => authorization },
    "workspace", "a", "b", { generate: async () => null } as never)
    await expect(sender.publish()).resolves.toBeUndefined()
    expect(sent.length).toBeGreaterThan(1)
    for (const frame of sent) expect(decodePairingFrame(frame, "mesh-control-sync", "secret").length).toBeLessThanOrEqual(256 * 1024)
    const count = sent.length
    await sender.publish()
    expect(sent).toHaveLength(count)
    const merge = vi.fn()
    let index = 0
    const receiver = liveAutomergeWorkspaceSync({
      openStream: vi.fn(), close: vi.fn(),
      acceptStream: async () => index < sent.length
        ? { read: async () => sent[index++]!, send: vi.fn(), closeSend: vi.fn() }
        : new Promise(() => {}),
    }, "secret", { read: async () => bytes, merge, activate: vi.fn() },
    "workspace", "b", "a", { reset: vi.fn() } as never)
    await vi.waitFor(() => expect(merge).toHaveBeenCalledExactlyOnceWith("workspace", bytes, authorization))
    await sender.close()
    await receiver.close()
  })

  it("Given an authorization-only update, when a control frame arrives, then it merges the proof without a document change", async () => {
    const merge = vi.fn(async () => {})
    const authorization = [{ hash: "cleanup", signature: "signed" }]
    let accepted = false
    const stream = {
      send: vi.fn(), closeSend: vi.fn(async () => {}),
      read: vi.fn(async () => encodePairingFrame("mesh-control-sync", "mesh-secret",
        new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: "workspace", authorization })))),
    }
    const connection: SyncConnection = {
      openStream: vi.fn(),
      acceptStream: vi.fn(async () => {
        if (!accepted) { accepted = true; return stream }
        return new Promise<never>(() => {})
      }),
      close: vi.fn(async () => {}),
    }
    const bytes = new Uint8Array([1, 2, 3])
    const engine = { generate: vi.fn(async () => null), reset: vi.fn() }
    const session = liveAutomergeWorkspaceSync(connection, "mesh-secret", {
      read: async () => bytes, merge, activate: vi.fn(),
    }, "workspace", "local", "remote", engine as never)

    await vi.waitFor(() => expect(merge).toHaveBeenCalledWith("workspace", bytes, authorization))
    expect(engine.reset).toHaveBeenCalledWith("workspace", "remote")
    await session.close()
  })

  it("Given an authorization-only update, when the session publishes, then it sends the proof in a control frame", async () => {
    const sent: Uint8Array[] = []
    const bytes = new Uint8Array([1, 2, 3])
    const authorization = [{ hash: "cleanup", signature: "signed" }]
    const connection: SyncConnection = {
      openStream: vi.fn(async () => ({ send: async (frame: Uint8Array) => { sent.push(frame) }, closeSend: async () => {}, read: async () => new Uint8Array() })),
      acceptStream: () => new Promise(() => {}), close: vi.fn(async () => {}),
    }
    const engine = { generate: vi.fn(async () => null) }
    const session = liveAutomergeWorkspaceSync(connection, "mesh-secret", {
      read: async () => bytes, merge: vi.fn(), activate: vi.fn(), readAuthorization: async () => authorization,
    }, "workspace", "local", "remote", engine as never)

    await session.publish()

    const control = sent.find(frame => inspectPairingFrame(frame).type === "mesh-control-sync")!
    const payload = JSON.parse(new TextDecoder().decode(
      decodePairingFrame(control, "mesh-control-sync", "mesh-secret"),
    ))
    expect(payload.authorization).toEqual(authorization)
    await session.close()
  })

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

  it("Given two owner devices, when a workspace offer arrives, then it is persisted before acknowledgement", async () => {
    const offer = new TextEncoder().encode('{"version":1,"workspaceId":"future"}')
    const accepted = vi.fn(async () => {})
    let delivered = false
    const inbound = {
      send: vi.fn(), closeSend: vi.fn(async () => {}),
      read: vi.fn(async () => encodePairingFrame("mesh-owner-workspace-offer", "mesh-secret", offer)),
    }
    const connection: SyncConnection = {
      openStream: vi.fn(),
      acceptStream: vi.fn(async () => {
        if (!delivered) { delivered = true; return inbound }
        return new Promise<never>(() => {})
      }),
      close: vi.fn(async () => {}),
    }
    const session = liveAutomergeWorkspaceSync(connection, "mesh-secret", {
      read: async () => new Uint8Array(), merge: vi.fn(), activate: vi.fn(),
    }, "workspace", "local", "remote", undefined, undefined, {
      ownerWorkspaceOfferFrame: "mesh-owner-workspace-offer",
      onOwnerWorkspaceOffer: accepted,
    })

    await vi.waitFor(() => expect(accepted).toHaveBeenCalledWith(offer))
    expect(inspectPairingFrame(inbound.send.mock.calls[0]![0]).type).toBe("mesh-durable-ack")
    await session.close()
  })

  it("requires a matching receipt when publishing an owner workspace", async () => {
    const offer = new Uint8Array([1, 2, 3])
    const stream = { send: vi.fn(), closeSend: vi.fn(),
      read: async () => encodePairingFrame("mesh-durable-ack", "secret",
        new TextEncoder().encode(await sha256Base64Url(offer))) }
    const connection = { openStream: async () => stream } as never
    await expect(publishOwnerWorkspaceOffer(connection, "secret", offer, "mesh-owner-workspace-offer")).resolves.toBeUndefined()
    expect(inspectPairingFrame(stream.send.mock.calls[0]![0]).type).toBe("mesh-owner-workspace-offer")
  })
})


describe("rejected document isolation", () => {
  it("keeps heartbeat and control alive after a rejected document and can accept a later corrected frame", async () => {
    const error = new WorkspaceChangeRejected("Unsigned workspace change rejected")
    const receive = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ response: null, acceptedChanges: 1 })
    const engine = { receive, generate: vi.fn(async () => null), reset: vi.fn() }
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
    expect(engine.reset).toHaveBeenCalledWith("workspace", "remote")
    expect(ended).toBe(false)
    expect(connection.close).not.toHaveBeenCalled()
    expect(inspectPairingFrame(streams[1]!.send.mock.calls[0]![0]).type).toBe("sync-heartbeat-ack")
    expect(mergeMesh).toHaveBeenCalledWith("workspace",{epoch:2})
    await expect(session.publish()).resolves.toBeUndefined()
    await session.close()
  })
})
