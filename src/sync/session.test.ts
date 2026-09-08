import { describe, expect, it, vi } from "vitest"
import { createPairingInvite } from "./protocol"
import { acceptWorkspaceSync, joinWorkspaceSync, type WorkspaceReplica } from "./session"
import type { DuplexStream, SyncAcceptor, SyncConnection, SyncNode } from "./transport"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

class MemoryStream implements DuplexStream {
  private readonly closed = deferred<void>()
  private bytes: Uint8Array | undefined
  private peer: MemoryStream | undefined

  connect(peer: MemoryStream) {
    this.peer = peer
  }

  async send(bytes: Uint8Array) {
    if (this.peer?.bytes) throw new Error("stream already written")
    this.peer!.bytes = bytes
  }

  async closeSend() {
    this.peer!.closed.resolve()
  }

  async read() {
    await this.closed.promise
    return this.bytes ?? new Uint8Array()
  }
}

function streamPair(): [MemoryStream, MemoryStream] {
  const left = new MemoryStream()
  const right = new MemoryStream()
  left.connect(right)
  right.connect(left)
  return [left, right]
}

class MemoryConnection implements SyncConnection {
  private peer: MemoryConnection | undefined
  private readonly streams: MemoryStream[] = []
  private waiting: ((stream: MemoryStream) => void) | undefined

  connect(peer: MemoryConnection) {
    this.peer = peer
  }

  async openStream() {
    const [local, remote] = streamPair()
    this.peer!.receive(remote)
    return local
  }

  async acceptStream() {
    const next = this.streams.shift()
    if (next) return next
    return new Promise<MemoryStream>((resolve) => { this.waiting = resolve })
  }

  async close() {}

  private receive(stream: MemoryStream) {
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = undefined
      resolve(stream)
      return
    }
    this.streams.push(stream)
  }
}

function connectedNodes(): { host: SyncNode; peer: SyncNode } {
  const hostConnection = new MemoryConnection()
  const peerConnection = new MemoryConnection()
  hostConnection.connect(peerConnection)
  peerConnection.connect(hostConnection)
  const incoming = deferred<SyncConnection | undefined>()

  const acceptor: SyncAcceptor = { accept: () => incoming.promise, close: async () => {} }
  return {
    host: {
      endpointId: "host",
      accept: async () => acceptor,
      dial: async () => { throw new Error("host does not dial") },
      close: async () => {},
    },
    peer: {
      endpointId: "peer",
      accept: async () => { throw new Error("peer does not accept") },
      dial: async () => {
        incoming.resolve(hostConnection)
        return peerConnection
      },
      close: async () => {},
    },
  }
}

function replica(initial: number[]) {
  let bytes = new Uint8Array(initial)
  const mergeBytes = vi.fn(async (remote: Uint8Array) => {
    bytes = new Uint8Array([...bytes, ...remote])
  })
  return { workspace: { getBytes: () => bytes, mergeBytes } satisfies WorkspaceReplica, mergeBytes, bytes: () => bytes, set: (next: number[]) => { bytes = new Uint8Array(next) } }
}

describe("workspace sync session", () => {
  it("Given two peers, when one joins a host QR, then both merge and acknowledge", async () => {
    const { host, peer } = connectedNodes()
    const hostWorkspace = replica([1])
    const peerWorkspace = replica([2])

    const accepting = acceptWorkspaceSync(host, "host-secret", hostWorkspace.workspace)
    await joinWorkspaceSync(peer, createPairingInvite("host", "host-secret"), peerWorkspace.workspace)
    await accepting

    expect(hostWorkspace.mergeBytes).toHaveBeenCalledWith(new Uint8Array([2]))
    expect(peerWorkspace.mergeBytes).toHaveBeenCalledWith(new Uint8Array([1, 2]))
  })

  it("Given a host still publishing its address, when the QR is opened, then the peer retries without a second action", async () => {
    const { host, peer } = connectedNodes()
    const hostWorkspace = replica([1])
    const peerWorkspace = replica([2])
    const dial = vi.spyOn(peer, "dial")
    dial.mockRejectedValueOnce(new Error("failed to open WebRTC bootstrap connection"))

    const accepting = acceptWorkspaceSync(host, "host-secret", hostWorkspace.workspace)
    await joinWorkspaceSync(peer, createPairingInvite("host", "host-secret"), peerWorkspace.workspace, {
      attempts: 2,
      sleep: async () => {},
    })
    await accepting

    expect(dial).toHaveBeenCalledTimes(2)
    expect(peerWorkspace.mergeBytes).toHaveBeenCalledWith(new Uint8Array([1, 2]))
  })

  it("Given paired peers, when one peer publishes a later change, then the other merges it on the same connection", async () => {
    const { host, peer } = connectedNodes()
    const hostWorkspace = replica([1])
    const peerWorkspace = replica([2])

    const accepting = acceptWorkspaceSync(host, "host-secret", hostWorkspace.workspace)
    const peerSession = await joinWorkspaceSync(peer, createPairingInvite("host", "host-secret"), peerWorkspace.workspace)
    await accepting

    peerWorkspace.set([2, 1, 3])
    await peerSession.publish()

    await vi.waitFor(() => {
      expect(hostWorkspace.mergeBytes).toHaveBeenLastCalledWith(new Uint8Array([2, 1, 3]))
    })
  })
})
