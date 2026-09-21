import { WorkspaceChangeRejected } from "./changeAuthorization"
import { fromBase64Url, toBase64Url, sha256Base64Url } from "../domain/identity"
import * as Automerge from "@automerge/automerge/slim"
import { AutomergeAntiEntropy, type AutomergeDocumentAdapter, type AutomergeSyncFrame } from "@meta-uber/mesh-replication/automerge"
import { MeshNetworkError as SyncNetworkError } from "@meta-uber/mesh-transport"
import { decodePairingFrame, encodePairingFrame, inspectPairingFrame } from "@meta-uber/mesh-pairing"
import type { DuplexStream, SyncConnection } from "./transport"

export type WorkspaceReplica = {
  subscribe?: (listener: () => void) => () => void
}

export type LiveWorkspaceSync = {
  publish: () => Promise<void>
  heartbeat?: () => Promise<void>
  close: () => Promise<void>
  done: Promise<void>
}

export const MESH_HEARTBEAT_TIMEOUT_MS = 12_000
const MAX_CONTROL_FRAME_BYTES = 256 * 1024
const MAX_OWNER_WORKSPACE_OFFER_BYTES = 24 * 1024 * 1024
const MAX_GOSSIP_PACKET_BYTES = 256 * 1024

export type WorkspaceSetStore = {
  read: (id: string) => Promise<Uint8Array>
  merge: (id: string, bytes: Uint8Array, authorization?: unknown) => Promise<void>
  activate: (id: string) => Promise<void>
  readAuthorization?: (bytes: Uint8Array) => Promise<unknown>
  readChat?: (id: string, known?: Set<string>) => Promise<unknown>
  mergeChat?: (id: string, value: unknown, history: boolean) => Promise<void>
  readMesh?: (id: string) => Promise<unknown>
  mergeMesh?: (id: string, value: unknown) => Promise<void>
}

export function workspaceSet(store: WorkspaceSetStore, workspaceIds: string[]) {
  const ids = [...new Set(workspaceIds)].sort()
  const receiveStage = async (stage: string, id: string, action: () => Promise<void>) => {
    try { await action() } catch (error) {
      throw new Error(`${stage} ${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }
  return {
    async snapshot(knownChat?: Map<string, Set<string>>) {
      const entries = await Promise.all(ids.map(async id => { const bytes = await store.read(id); return { id, bytes: toBase64Url(bytes),
        ...(store.readAuthorization ? { authorization: await store.readAuthorization(bytes) } : {}),
        ...(store.readChat ? { chat: await store.readChat(id, knownChat ? (() => {
          const known = knownChat.get(id) ?? new Set<string>()
          knownChat.set(id, known)
          return known
        })() : undefined) } : {}),
        ...(store.readMesh ? { mesh: await store.readMesh(id) } : {}),
      }}))
      return new TextEncoder().encode(JSON.stringify(entries))
    },
    async receive(bytes: Uint8Array, history = true) {
      const entries = JSON.parse(new TextDecoder().decode(bytes))
      if (!Array.isArray(entries) || entries.length !== ids.length ||
        new Set(entries.map(e => e?.id)).size !== ids.length ||
        entries.some(e => !ids.includes(e?.id) || typeof e?.bytes !== "string")) {
        throw new Error("The peer sent a different set of workspaces than the invitation allows.")
      }
      for (const entry of entries) {
        await receiveStage("Workspace", entry.id, () => store.merge(entry.id, fromBase64Url(entry.bytes), entry.authorization))
        if (entry.chat !== undefined && store.mergeChat) await receiveStage("Chat", entry.id, () => store.mergeChat!(entry.id, entry.chat, history))
        if (entry.mesh !== undefined && store.mergeMesh) await receiveStage("Mesh", entry.id, () => store.mergeMesh!(entry.id, entry.mesh))
      }
    },
  }
}

// Receipt is bound to the exact document, proofs and ownership catalog on this
// authenticated peer stream. A timeout is an unknown outcome, never a rollback.
export async function publishConfirmedWorkspace(connection: SyncConnection, secret: string, bytes: Uint8Array): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        const stream = await connection.openStream()
        await stream.send(encodePairingFrame("mesh-durable-batch", secret, bytes))
        await stream.closeSend()
        const receipt = decodePairingFrame(await stream.read(), "mesh-durable-ack", secret)
        if (new TextDecoder().decode(receipt) !== await sha256Base64Url(bytes)) throw new Error("Ownership receipt does not match the saved data")
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Ownership delivery is unconfirmed. Reconnect and retry the same transfer.")), MESH_HEARTBEAT_TIMEOUT_MS)
      }),
    ])
  } finally { clearTimeout(timer) }
}

export async function publishOwnerWorkspaceOffer(connection: SyncConnection, secret: string, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > MAX_OWNER_WORKSPACE_OFFER_BYTES) throw new Error("Owner workspace offer exceeds size limit")
  const stream = await connection.openStream()
  await stream.send(encodePairingFrame("mesh-gossip", secret, bytes))
  await stream.closeSend()
  const receipt = decodePairingFrame(await stream.read(), "mesh-durable-ack", secret)
  if (new TextDecoder().decode(receipt) !== await sha256Base64Url(bytes)) throw new Error("Owner workspace receipt does not match")
}

export async function publishGossipPacket(connection: SyncConnection, secret: string, packet: Uint8Array): Promise<void> {
  if (packet.byteLength > MAX_GOSSIP_PACKET_BYTES) throw new Error("Gossip packet exceeds size limit")
  const stream = await connection.openStream()
  await stream.send(encodePairingFrame("mesh-iroh-gossip", secret, packet))
  await stream.closeSend()
}

async function receiveConfirmedWorkspace(stream: DuplexStream, frame: Uint8Array, secret: string, replica: ReturnType<typeof workspaceSet>) {
  const bytes = decodePairingFrame(frame, "mesh-durable-batch", secret)
  await replica.receive(bytes, false)
  await stream.send(encodePairingFrame("mesh-durable-ack", secret, new TextEncoder().encode(await sha256Base64Url(bytes))))
  await stream.closeSend()
}

export function liveWorkspaceSetSync(
  connection: SyncConnection,
  secret: string,
  replica: ReturnType<typeof workspaceSet>,
  options: {
    onHandoffRequest?: (stream: DuplexStream) => Promise<void>
    onGossipPacket?: (packet: Uint8Array) => Promise<void>
  } = {},
): LiveWorkspaceSync {
  let stopped = false
  let lastSent = ""
  let queue = Promise.resolve()
  let heartbeatQueue = Promise.resolve()
  const knownChat = new Map<string, Set<string>>()
  const done = (async () => {
    while (!stopped) {
      const stream = await connection.acceptStream()
      if (stopped) return
      const frame = await stream.read()
      const type = inspectPairingFrame(frame).type
      if (type === "mesh-durable-batch") {
        await receiveConfirmedWorkspace(stream, frame, secret, replica)
        continue
      }
      if (type === "sync-heartbeat") {
        decodePairingFrame(frame, "sync-heartbeat", secret)
        await stream.send(encodePairingFrame("sync-heartbeat-ack", secret, new Uint8Array()))
        await stream.closeSend()
        continue
      }
      if (type === "mesh-handoff-request" && options.onHandoffRequest) {
        decodePairingFrame(frame, "mesh-handoff-request", secret)
        await options.onHandoffRequest(stream)
        continue
      }
      if (type === "mesh-iroh-gossip" && options.onGossipPacket) {
        const packet = decodePairingFrame(frame, "mesh-iroh-gossip", secret)
        if (packet.byteLength > MAX_GOSSIP_PACKET_BYTES) throw new Error("Gossip packet exceeds size limit")
        await options.onGossipPacket(packet)
        await stream.closeSend()
        continue
      }
      await replica.receive(decodePairingFrame(frame, "sync-update", secret), false)
      await stream.closeSend()
    }
  })().catch(error => { if (!stopped) throw error })
  return {
    done,
    publish() {
      queue = queue.then(async () => {
        if (stopped) return
        const bytes = await replica.snapshot(knownChat)
        const content = toBase64Url(bytes)
        if (stopped || content === lastSent) return
        const stream = await connection.openStream()
        await stream.send(encodePairingFrame("sync-update", secret, bytes))
        await stream.closeSend()
        lastSent = content
      })
      return queue
    },
    heartbeat() {
      heartbeatQueue = heartbeatQueue.then(async () => {
        if (stopped) return
        const stream = await connection.openStream()
        await stream.send(encodePairingFrame("sync-heartbeat", secret, new Uint8Array()))
        await stream.closeSend()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const frame = await Promise.race([
            stream.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new SyncNetworkError("Mesh heartbeat timed out")), MESH_HEARTBEAT_TIMEOUT_MS)
            }),
          ])
          decodePairingFrame(frame, "sync-heartbeat-ack", secret)
        } finally {
          clearTimeout(timer)
        }
      })
      return heartbeatQueue
    },
    async close() {
      stopped = true
      await connection.close()
    },
  }
}

export function liveAutomergeWorkspaceSync(
  connection: SyncConnection,
  secret: string,
  store: WorkspaceSetStore,
  workspaceId: string,
  localDeviceId: string,
  remoteDeviceId: string,
  sharedEngine?: AutomergeAntiEntropy,
  onDocumentRejected?: (error: WorkspaceChangeRejected | null) => void,
  options: {
    onOwnerWorkspaceOffer?: (bytes: Uint8Array) => Promise<void>
    onGossipPacket?: (packet: Uint8Array) => Promise<void>
  } = {},
): LiveWorkspaceSync {
  let stopped = false
  let lastRejection: string | undefined
  let syncQueue = Promise.resolve()
  let heartbeatQueue = Promise.resolve()
  let lastControlSent = ""
  const knownChat = new Set<string>()
  const engine = sharedEngine ?? new AutomergeAntiEntropy(localDeviceId, Automerge, {
    proof: async () => store.readAuthorization?.(await store.read(workspaceId)),
  })
  const adapter: AutomergeDocumentAdapter<Record<string, unknown>> = {
    scopeId: workspaceId,
    documentId: workspaceId,
    async current() { return Automerge.load<Record<string, unknown>>(await store.read(workspaceId)) },
    async authorize(deviceId) { return deviceId === remoteDeviceId },
    async validateCandidate({ candidate }) {
      if ((candidate as { id?: unknown }).id !== workspaceId) throw new Error("Wrong workspace document")
    },
    async commit({ candidate, proof }) { await store.merge(workspaceId, Automerge.save(candidate), proof) },
  }
  const encodeFrame = (frame: AutomergeSyncFrame) => encodePairingFrame("mesh-automerge-sync", secret,
    new TextEncoder().encode(JSON.stringify({ ...frame, message: toBase64Url(frame.message) })))
  const decodeFrame = (bytes: Uint8Array): AutomergeSyncFrame => {
    const value = JSON.parse(new TextDecoder().decode(decodePairingFrame(bytes, "mesh-automerge-sync", secret)))
    return { ...value, message: fromBase64Url(value.message) }
  }
  const sendFrame = async (frame: AutomergeSyncFrame) => {
    if (stopped) return
    const stream = await connection.openStream()
    await stream.send(encodeFrame(frame))
    await stream.closeSend()
  }
  const controlSnapshot = async () => new TextEncoder().encode(JSON.stringify({
    version: 1,
    workspaceId,
    ...(store.readChat ? { chat: await store.readChat(workspaceId, knownChat) } : {}),
    ...(store.readMesh ? { mesh: await store.readMesh(workspaceId) } : {}),
  }))
  const receiveControl = async (bytes: Uint8Array) => {
    if (bytes.byteLength > MAX_CONTROL_FRAME_BYTES) throw new Error("Mesh control frame exceeds size limit")
    const value = JSON.parse(new TextDecoder().decode(bytes)) as {
      version?: unknown; workspaceId?: unknown; chat?: unknown; mesh?: unknown
    }
    if (value.version !== 1 || value.workspaceId !== workspaceId) throw new Error("Invalid mesh control frame")
    if (value.chat !== undefined && store.mergeChat) await store.mergeChat(workspaceId, value.chat, false)
    if (value.mesh !== undefined && store.mergeMesh) await store.mergeMesh(workspaceId, value.mesh)
  }
  const enqueue = (run: () => Promise<void>) => {
    syncQueue = syncQueue.then(run, run)
    return syncQueue
  }
  const done = (async () => {
    while (!stopped) {
      const stream = await connection.acceptStream()
      if (stopped) return
      const frame = await stream.read()
      const type = inspectPairingFrame(frame).type
      if (type === "mesh-durable-batch") {
        await receiveConfirmedWorkspace(stream, frame, secret, workspaceSet(store, [workspaceId]))
        continue
      }
      if (type === "sync-heartbeat") {
        decodePairingFrame(frame, "sync-heartbeat", secret)
        await stream.send(encodePairingFrame("sync-heartbeat-ack", secret, new Uint8Array()))
        await stream.closeSend()
        continue
      }
      if (type === "mesh-control-sync") {
        await receiveControl(decodePairingFrame(frame, "mesh-control-sync", secret))
        await stream.closeSend()
        continue
      }
      if (type === "mesh-gossip" && options.onOwnerWorkspaceOffer) {
        const bytes = decodePairingFrame(frame, "mesh-gossip", secret)
        if (bytes.byteLength > MAX_OWNER_WORKSPACE_OFFER_BYTES) throw new Error("Owner workspace offer exceeds size limit")
        await options.onOwnerWorkspaceOffer(bytes)
        await stream.send(encodePairingFrame("mesh-durable-ack", secret,
          new TextEncoder().encode(await sha256Base64Url(bytes))))
        await stream.closeSend()
        continue
      }
      if (type === "mesh-iroh-gossip" && options.onGossipPacket) {
        const packet = decodePairingFrame(frame, "mesh-iroh-gossip", secret)
        if (packet.byteLength > MAX_GOSSIP_PACKET_BYTES) throw new Error("Gossip packet exceeds size limit")
        await options.onGossipPacket(packet)
        await stream.closeSend()
        continue
      }
      if (type !== "mesh-automerge-sync") throw new Error(`Unsupported live workspace frame: ${type}`)
      try {
        await enqueue(async () => {
          const decoded = decodeFrame(frame)
          const result = await engine.receive(adapter, remoteDeviceId, decoded)
          if (result.acceptedChanges === 0 && store.readAuthorization && decoded.proof !== undefined) {
            await store.merge(workspaceId, await store.read(workspaceId), decoded.proof)
          }
          if (result.response) await sendFrame(result.response)
          if (lastRejection && result.acceptedChanges > 0) {
            lastRejection = undefined
            onDocumentRejected?.(null)
          }
        })
      } catch (error) {
        if (!(error instanceof WorkspaceChangeRejected)) throw error
        // Reject the document, not its authenticated transport. No response or
        // receipt acknowledges the rejected changes; heartbeat/control stay live.
        if (lastRejection !== error.message) onDocumentRejected?.(error)
        lastRejection = error.message
      }
      await stream.closeSend()
    }
  })().catch(error => { if (!stopped) throw error })
  return {
    done,
    publish() {
      return enqueue(async () => {
        const frame = await engine.generate(adapter, remoteDeviceId)
        if (frame) await sendFrame(frame)
        const control = await controlSnapshot()
        const content = toBase64Url(control)
        if (content !== lastControlSent) {
          if (control.byteLength > MAX_CONTROL_FRAME_BYTES) throw new Error("Mesh control frame exceeds size limit")
          const stream = await connection.openStream()
          await stream.send(encodePairingFrame("mesh-control-sync", secret, control))
          await stream.closeSend()
          lastControlSent = content
        }
      })
    },
    heartbeat() {
      heartbeatQueue = heartbeatQueue.then(async () => {
        if (stopped) return
        const stream = await connection.openStream()
        await stream.send(encodePairingFrame("sync-heartbeat", secret, new Uint8Array()))
        await stream.closeSend()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const frame = await Promise.race([
            stream.read(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SyncNetworkError("Mesh heartbeat timed out")), MESH_HEARTBEAT_TIMEOUT_MS) }),
          ])
          decodePairingFrame(frame, "sync-heartbeat-ack", secret)
        } finally { clearTimeout(timer) }
      })
      return heartbeatQueue
    },
    async close() { stopped = true; await connection.close() },
  }
}
