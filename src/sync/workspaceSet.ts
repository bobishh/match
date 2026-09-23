import { BrowserMeshScopeSync, createLiveWorkspaceSession, type RustLiveWorkspaceSession } from "@meta-uber/mesh-runtime"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { WorkspaceChangeRejected } from "./changeAuthorization"
import { fromBase64Url, toBase64Url } from "../domain/identity"
import * as Automerge from "@automerge/automerge/slim"
import { MeshNetworkError as SyncNetworkError } from "@meta-uber/mesh-transport"
import { meshTrace } from "./meshTrace"
import type { BlobDescriptor } from "@meta-uber/mesh-blob"
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

const MESH_HEARTBEAT_TIMEOUT_MS = 12_000
export type OwnerWorkspaceOfferFrame = "mesh-owner-workspace-offer"

export type WorkspaceSetStore = {
  read: (id: string) => Promise<Uint8Array>
  validate?: (id: string, bytes: Uint8Array, authorization?: unknown) => Promise<void>
  merge: (id: string, bytes: Uint8Array, authorization?: unknown) => Promise<void>
  activate: (id: string) => Promise<void>
  readAuthorization?: (bytes: Uint8Array) => Promise<unknown>
  readChat?: (id: string, known?: Set<string>) => Promise<unknown>
  mergeChat?: (id: string, value: unknown, history: boolean) => Promise<void>
  readMesh?: (id: string) => Promise<unknown>
  mergeMesh?: (id: string, value: unknown) => Promise<void>
  blob?: {
    resolve: (workspaceId: string, blobId: string) => Promise<BlobDescriptor | undefined>
    read: (descriptor: BlobDescriptor) => Promise<Uint8Array | undefined>
    write: (descriptor: BlobDescriptor, bytes: Uint8Array) => Promise<void>
  }
}

type LiveWorkspaceOptions = {
  onHandoffRequest?: (stream: DuplexStream, frame: Uint8Array) => Promise<void>
  ownerWorkspaceOfferFrame?: OwnerWorkspaceOfferFrame
  onOwnerWorkspaceOffer?: (bytes: Uint8Array) => Promise<void>
  onGossipPacket?: (packet: Uint8Array) => Promise<void>
  onBlobRequest?: (stream: DuplexStream, frame: Uint8Array) => Promise<void>
}

export type WorkspaceSetWorkspace = string | { id: string; title?: string }

export function workspaceSet(store: WorkspaceSetStore, workspaceEntries: WorkspaceSetWorkspace[]) {
  const titles = new Map(workspaceEntries.flatMap(entry => typeof entry === "string" || !entry.title ? [] : [[entry.id, entry.title] as const]))
  const ids = [...new Set(workspaceEntries.map(entry => typeof entry === "string" ? entry : entry.id))].sort()
  const label = (id: string) => {
    const title = titles.get(id)
    return title ? `${id} (${title.length > 80 ? `${title.slice(0, 80)}…` : title})` : id
  }
  const receiveStage = async (stage: string, id: string, action: () => Promise<void>) => {
    try { await action() } catch (error) {
      throw new Error(`${stage} ${label(id)}: ${error instanceof Error ? error.message : String(error)}${safeDiagnostic(error)}`, { cause: error })
    }
  }
  return {
    async snapshot(knownChat?: Map<string, Set<string>>) {
      const entries = await Promise.all(ids.map(async id => {
        try {
          const bytes = await store.read(id)
          return { id, bytes: toBase64Url(bytes),
            ...(store.readAuthorization ? { authorization: await store.readAuthorization(bytes) } : {}),
            ...(store.readChat ? { chat: await store.readChat(id, knownChat ? (() => {
              const known = knownChat.get(id) ?? new Set<string>()
              knownChat.set(id, known)
              return known
            })() : undefined) } : {}),
            ...(store.readMesh ? { mesh: await store.readMesh(id) } : {}),
          }
        } catch (error) {
          throw new Error(`Workspace ${label(id)} snapshot failed: ${error instanceof Error ? error.message : String(error)}${safeDiagnostic(error)}`, { cause: error })
        }
      }))
      return meshRustRuntime().state.encodeWorkspaceSet(entries)
    },
    async validate(bytes: Uint8Array) {
      const entries = parseEntries(bytes, ids)
      for (const entry of entries) {
        if (store.validate) await receiveStage("Workspace", entry.id, () =>
          store.validate!(entry.id, fromBase64Url(entry.bytes), entry.authorization))
      }
    },
    async receive(bytes: Uint8Array, history = true) {
      const entries = parseEntries(bytes, ids)
      // Validate the complete batch before writing the first workspace. This
      // keeps a bad second board from stranding the first as an orphaned local
      // document during enrollment or an invitation.
      for (const entry of entries) {
        if (store.validate) await receiveStage("Workspace", entry.id, () =>
          store.validate!(entry.id, fromBase64Url(entry.bytes), entry.authorization))
      }
      for (const entry of entries) {
        await receiveStage("Workspace", entry.id, () => store.merge(entry.id, fromBase64Url(entry.bytes), entry.authorization))
        if (entry.chat !== undefined && store.mergeChat) await receiveStage("Chat", entry.id, () => store.mergeChat!(entry.id, entry.chat, history))
        if (entry.mesh !== undefined && store.mergeMesh) await receiveStage("Mesh", entry.id, () => store.mergeMesh!(entry.id, entry.mesh))
      }
    },
  }
}

function parseEntries(bytes: Uint8Array, ids: string[]) {
  return meshRustRuntime().state.decodeWorkspaceSet(bytes, ids)
}

function safeDiagnostic(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined
  if (!cause || typeof cause !== "object") return ""
  const diagnostic = cause as { code?: unknown; field?: unknown }
  if (typeof diagnostic.code !== "string") return ""
  const field = typeof diagnostic.field === "string" ? ` at ${diagnostic.field}` : ""
  return ` [${diagnostic.code}${field}]`
}

// Receipt is bound to the exact document, proofs and ownership catalog on this
// authenticated peer stream. A timeout is an unknown outcome, never a rollback.
export async function publishConfirmedWorkspace(connection: SyncConnection, secret: string, bytes: Uint8Array): Promise<void> {
  const protocol = createLiveWorkspaceSession("confirmed-delivery", secret)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        const stream = await connection.openStream()
        await stream.send(protocol.encode("mesh-durable-batch", bytes))
        await stream.closeSend()
        protocol.verifySavedReceipt(await stream.read(), bytes)
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Ownership delivery is unconfirmed. Reconnect and retry the same transfer.")), MESH_HEARTBEAT_TIMEOUT_MS)
      }),
    ])
  } finally { clearTimeout(timer); protocol.free?.() }
}

export async function publishOwnerWorkspaceOffer(connection: SyncConnection, secret: string, bytes: Uint8Array,
  frame: OwnerWorkspaceOfferFrame): Promise<void> {
  const protocol = createLiveWorkspaceSession("owner-offer", secret)
  try {
    const encoded = protocol.encode(frame, bytes)
    const stream = await connection.openStream()
    await stream.send(encoded)
    await stream.closeSend()
    protocol.verifySavedReceipt(await stream.read(), bytes)
  } finally { protocol.free?.() }
}

export async function publishGossipPacket(connection: SyncConnection, secret: string, packet: Uint8Array): Promise<void> {
  const protocol = createLiveWorkspaceSession("gossip", secret)
  try {
    const frame = protocol.encode("mesh-iroh-gossip", packet)
    const stream = await connection.openStream()
    await stream.send(frame)
    await stream.closeSend()
  } finally { protocol.free?.() }
}

async function confirmHeartbeat(connection: SyncConnection, secret: string): Promise<void> {
  const protocol = createLiveWorkspaceSession("heartbeat", secret)
  const stream = await connection.openStream()
  await stream.send(protocol.encode("sync-heartbeat", new Uint8Array()))
  await stream.closeSend()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const frame = await Promise.race([
      stream.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SyncNetworkError("Mesh heartbeat timed out")),
          MESH_HEARTBEAT_TIMEOUT_MS,
        )
      }),
    ])
    protocol.verifyHeartbeatAck(frame)
  } finally {
    clearTimeout(timer)
    protocol.free?.()
  }
}

function enqueueHeartbeat(
  queue: Promise<void>,
  isStopped: () => boolean,
  connection: SyncConnection,
  secret: string,
): Promise<void> {
  return queue.then(async () => {
    if (!isStopped()) await confirmHeartbeat(connection, secret)
  })
}

export function liveWorkspaceSetSync(
  connection: SyncConnection,
  secret: string,
  replica: ReturnType<typeof workspaceSet>,
  options: LiveWorkspaceOptions = {},
): LiveWorkspaceSync {
  const protocol = createLiveWorkspaceSession("workspace-set", secret)
  let stopped = false
  let queue = Promise.resolve()
  let heartbeatQueue = Promise.resolve()
  let knownChat = new Map<string, Set<string>>()
  const done = (async () => {
    while (!stopped) {
      const stream = await connection.acceptStream()
      if (stopped) return
      const frame = await stream.read()
      const operation = protocol.receiveWithPlan(frame)
      if (!operation) { await stream.closeSend(); continue }
      await applyWorkspaceSetReceivePlan(protocol, operation, stream, frame, bytes => replica.receive(bytes, false), options)
    }
  })().catch(error => { if (!stopped) throw error })
  return {
    done,
    publish() {
      queue = queue.then(async () => {
        if (stopped) return
        const nextKnownChat = new Map([...knownChat].map(([id, known]) => [id, new Set(known)]))
        const bytes = await replica.snapshot(nextKnownChat)
        if (stopped) return
        const plan = protocol.prepareSnapshotPublish(bytes)
        if (!plan.frame) { knownChat = nextKnownChat; return }
        try {
          const stream = await connection.openStream()
          await stream.send(new Uint8Array(plan.frame))
          await stream.closeSend()
          protocol.finishPublish(new Uint8Array(plan.snapshot), true)
        } catch (error) {
          protocol.finishPublish(new Uint8Array(plan.snapshot), false)
          throw error
        }
        knownChat = nextKnownChat
      })
      return queue
    },
    heartbeat() {
      heartbeatQueue = enqueueHeartbeat(heartbeatQueue, () => stopped, connection, secret)
      return heartbeatQueue
    },
    async close() {
      stopped = true
      await connection.close()
      protocol.free?.()
    },
  }
}

function requiredHandler<T>(handler: T | undefined, message: string): T {
  if (!handler) throw new Error(message)
  return handler
}

async function applyWorkspaceSetReceivePlan(
  protocol: RustLiveWorkspaceSession,
  operation: NonNullable<ReturnType<RustLiveWorkspaceSession["receiveWithPlan"]>>,
  stream: DuplexStream,
  frame: Uint8Array,
  merge: (bytes: Uint8Array) => Promise<void>,
  options: LiveWorkspaceOptions,
): Promise<void> {
  const bytes = Uint8Array.from(operation.action.payload ?? [])
  const effects: Record<string, () => Promise<void>> = {
    mergeDurableBatch: () => merge(bytes),
    mergeWorkspaceSnapshot: () => merge(bytes),
    sendSavedAcknowledgement: async () => { await stream.send(protocol.acknowledgeSaved(bytes)) },
    sendHeartbeatAcknowledgement: async () => { await stream.send(protocol.encode("sync-heartbeat-ack", new Uint8Array())) },
    handleOwnerWorkspaceOffer: async () => {
      await requiredHandler(options.ownerWorkspaceOfferFrame === "mesh-owner-workspace-offer"
        ? options.onOwnerWorkspaceOffer : undefined, "Unsupported owner workspace offer")(bytes)
    },
    handleGossip: async () => {
      await requiredHandler(options.onGossipPacket, "Unsupported gossip packet")(bytes)
    },
    handleBlobRequest: async () => {
      await requiredHandler(options.onBlobRequest, "Unsupported blob request")(stream, frame)
    },
    handleHandoffRequest: async () => {
      await requiredHandler(options.onHandoffRequest, "Unsupported handoff request")(stream, frame)
    },
    closeSend: async () => { await stream.closeSend() },
    unsupportedControl: async () => { throw new Error("Unsupported live workspace action: control") },
    unsupportedSnapshot: async () => { throw new Error("Unsupported live workspace action: snapshot") },
  }
  for (const effect of operation.plan.effects) {
    const runEffect = effects[effect]
    if (!runEffect) throw new Error(`Unsupported live workspace effect: ${effect}`)
    await runEffect()
  }
}

export function liveAutomergeWorkspaceSync(
  connection: SyncConnection,
  secret: string,
  store: WorkspaceSetStore,
  workspaceId: string,
  localDeviceId: string,
  remoteDeviceId: string,
  onDocumentRejected?: (error: WorkspaceChangeRejected | null) => void,
  options: LiveWorkspaceOptions = {},
): LiveWorkspaceSync {
  let stopped = false
  let lastRejection: string | undefined
  let heartbeatQueue = Promise.resolve()
  const scope = BrowserMeshScopeSync.create(workspaceId, secret, {
    readDocument: () => store.read(workspaceId),
    readAuthorization: store.readAuthorization ? bytes => store.readAuthorization!(bytes) : undefined,
    readChat: store.readChat ? known => store.readChat!(workspaceId, known) : undefined,
    readMesh: store.readMesh ? () => store.readMesh!(workspaceId) : undefined,
    persistDocument: async (candidate, proof) => {
      const document = Automerge.load<{ id?: unknown }>(candidate)
      try { if (document.id !== workspaceId) throw new Error("Wrong workspace document") }
      finally { Automerge.free(document) }
      await store.merge(workspaceId, candidate, proof)
    },
    onDocumentAccepted: count => {
      if (count > 0 && lastRejection) { lastRejection = undefined; onDocumentRejected?.(null) }
    },
    mergeDurableBatch: bytes => workspaceSet(store, [workspaceId]).receive(bytes, false),
    mergeAuthorization: async authorization => {
      await store.merge(workspaceId, await store.read(workspaceId), authorization)
    },
    mergeChat: store.mergeChat ? chat => store.mergeChat!(workspaceId, chat, false) : undefined,
    mergeMesh: store.mergeMesh ? mesh => store.mergeMesh!(workspaceId, mesh) : undefined,
    onOwnerWorkspaceOffer: options.ownerWorkspaceOfferFrame === "mesh-owner-workspace-offer"
      ? options.onOwnerWorkspaceOffer : undefined,
    onGossip: options.onGossipPacket,
    onBlobRequest: options.onBlobRequest,
    onHandoffRequest: options.onHandoffRequest,
  })
  scope.startDocumentSync(localDeviceId, remoteDeviceId)
  const responseStream: DuplexStream = {
    async send(frame) {
      if (stopped) return
      const stream = await connection.openStream()
      await stream.send(frame)
      await stream.closeSend()
      void consumeResponse(stream)
    },
    async read() { throw new Error("Response stream cannot be read directly") },
    async closeSend() {},
  }
  const consumeResponse = async (stream: DuplexStream): Promise<void> => {
    try {
      const frame = await stream.read()
      if (!stopped && frame.length > 0) await receive(responseStream, frame)
    } catch (error) {
      if (!stopped) meshTrace("document.response.failed", {
        workspaceId: workspaceId.slice(0, 8), peerId: remoteDeviceId.slice(0, 8),
        reason: error instanceof Error ? error.message : String(error),
      }, "warn")
    }
  }
  const sendFrame = async (frame: Uint8Array, kind: "document" | "control"): Promise<boolean> => {
    if (stopped) return false
    const stream = await connection.openStream()
    await stream.send(frame)
    await stream.closeSend()
    if (kind === "document") void consumeResponse(stream)
    return true
  }
  const receive = async (stream: DuplexStream, frame: Uint8Array): Promise<void> => {
    try { await scope.receive(stream, frame) }
    catch (error) {
      if (!(error instanceof WorkspaceChangeRejected)) throw error
      if (lastRejection !== error.message) onDocumentRejected?.(error)
      lastRejection = error.message
    }
  }
  const done = (async () => {
    try {
      while (!stopped) {
        const stream = await connection.acceptStream()
        if (stopped) return
        await receive(stream, await stream.read())
      }
    } catch (error) { if (!stopped) throw error }
  })()
  return {
    done,
    async publish() {
      if (stopped) return
      await scope.publish(sendFrame)
    },
    heartbeat() {
      heartbeatQueue = enqueueHeartbeat(heartbeatQueue, () => stopped, connection, secret)
      return heartbeatQueue
    },
    async close() { stopped = true; await connection.close(); scope.free() },
  }
}
