import { BrowserMeshScopeSync, createLiveWorkspaceSession, type RustLiveWorkspaceSession } from "@meta-uber/mesh-runtime"
import { inspectPairingFrame } from "@meta-uber/mesh-pairing"
import { HandoffConfirmationInbox } from "./handoffConfirmation"
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
  /** Scope-aware updates for durable per-workspace sessions. */
  subscribeWorkspace?: (listener: (workspaceId?: string) => void) => () => void
}

export type LiveWorkspaceSync = {
  publish: () => Promise<void>
  reconcile?: () => Promise<void>
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
  readAuthorization?: (bytes: Uint8Array, workspaceId?: string) => Promise<unknown>
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
  onHandoffRequest?: (stream: DuplexStream, frame: Uint8Array, acceptConfirmation: SyncConnection["acceptStream"]) => Promise<void>
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
            ...(store.readAuthorization ? { authorization: await store.readAuthorization(bytes, id) } : {}),
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

async function measureScopePhase<T>(phase: string, workspaceId: string, peerId: string,
  operation: () => Promise<T>, byteLength?: number): Promise<T> {
  const started = performance.now()
  try { return await operation() }
  finally {
    const elapsedMs = Math.round(performance.now() - started)
    if (elapsedMs >= 250) meshTrace("workspace.scope.phase", {
      phase, workspaceId: workspaceId.slice(0, 8), peerId: peerId.slice(0, 8), elapsedMs,
      ...(byteLength === undefined ? {} : { byteLength }),
    }, "warn")
  }
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
  const handoffConfirmations = new HandoffConfirmationInbox()
  const done = (async () => {
    while (!stopped) {
      const stream = await connection.acceptStream()
      if (stopped) return
      const frame = await stream.read()
      try {
        if (inspectPairingFrame(frame).type === "mesh-handoff-confirmed") {
          handoffConfirmations.push(stream, frame)
          continue
        }
      } catch { /* Not a pairing frame; decode as workspace-set protocol below. */ }
      const operation = protocol.receiveWithPlan(frame)
      if (!operation) { await stream.closeSend(); continue }
      await applyWorkspaceSetReceivePlan(protocol, operation, stream, frame, bytes => replica.receive(bytes, false), options, handoffConfirmations)
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
  handoffConfirmations?: HandoffConfirmationInbox,
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
      await requiredHandler(options.onHandoffRequest, "Unsupported handoff request")(stream, frame,
        handoffConfirmations?.acceptStream ?? (async () => { throw new Error("No handoff confirmation reader") }))
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

// eslint-disable-next-line max-lines-per-function
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
  const liveness = createLiveWorkspaceSession(workspaceId, secret)
  const frameHandlers = new Set<Promise<void>>()
  const scope = BrowserMeshScopeSync.create(workspaceId, secret, {
    readDocument: () => measureScopePhase("store.read-document", workspaceId, remoteDeviceId,
      () => store.read(workspaceId)),
    readAuthorization: store.readAuthorization ? bytes => measureScopePhase("store.read-authorization", workspaceId,
      remoteDeviceId, () => store.readAuthorization!(bytes, workspaceId), bytes.byteLength) : undefined,
    readChat: store.readChat ? known => measureScopePhase("store.read-chat", workspaceId, remoteDeviceId,
      () => store.readChat!(workspaceId, known)) : undefined,
    readMesh: store.readMesh ? () => measureScopePhase("store.read-mesh", workspaceId, remoteDeviceId,
      () => store.readMesh!(workspaceId)) : undefined,
    persistDocument: async (candidate, proof) => {
      const document = Automerge.load<{ id?: unknown }>(candidate)
      try { if (document.id !== workspaceId) throw new Error("Wrong workspace document") }
      finally { Automerge.free(document) }
      await measureScopePhase("store.persist-document", workspaceId, remoteDeviceId,
        () => store.merge(workspaceId, candidate, proof), candidate.byteLength)
    },
    onDocumentAccepted: count => {
      if (count > 0 && lastRejection) { lastRejection = undefined; onDocumentRejected?.(null) }
    },
    mergeDurableBatch: bytes => measureScopePhase("store.merge-durable-batch", workspaceId, remoteDeviceId,
      () => workspaceSet(store, [workspaceId]).receive(bytes, false), bytes.byteLength),
    mergeAuthorization: async authorization => {
      const bytes = await store.read(workspaceId)
      await measureScopePhase("store.merge-authorization", workspaceId, remoteDeviceId,
        () => store.merge(workspaceId, bytes, authorization), bytes.byteLength)
    },
    mergeChat: store.mergeChat ? chat => measureScopePhase("store.merge-chat", workspaceId, remoteDeviceId,
      () => store.mergeChat!(workspaceId, chat, false)) : undefined,
    mergeMesh: store.mergeMesh ? mesh => measureScopePhase("store.merge-mesh", workspaceId, remoteDeviceId,
      () => store.mergeMesh!(workspaceId, mesh)) : undefined,
    onTiming: timing => {
      const elapsedMs = Math.round(timing.elapsedMs)
      if (elapsedMs >= 250) meshTrace("workspace.scope.queue", {
        operation: timing.operation, operationId: timing.operationId, phase: timing.phase,
        workspaceId: workspaceId.slice(0, 8), peerId: remoteDeviceId.slice(0, 8), elapsedMs,
        ...(timing.frameBytes === undefined ? {} : { frameBytes: timing.frameBytes }),
      }, "warn")
    },
    onOwnerWorkspaceOffer: options.ownerWorkspaceOfferFrame === "mesh-owner-workspace-offer" && options.onOwnerWorkspaceOffer
      ? bytes => measureScopePhase("callback.owner-workspace-offer", workspaceId, remoteDeviceId,
        () => options.onOwnerWorkspaceOffer!(bytes), bytes.byteLength) : undefined,
    onGossip: options.onGossipPacket
      ? bytes => measureScopePhase("callback.gossip", workspaceId, remoteDeviceId,
        () => options.onGossipPacket!(bytes), bytes.byteLength) : undefined,
    onBlobRequest: options.onBlobRequest
      ? (stream, frame) => measureScopePhase("callback.blob-request", workspaceId, remoteDeviceId,
        () => options.onBlobRequest!(stream, frame), frame.byteLength) : undefined,
    onHandoffRequest: options.onHandoffRequest
      ? (stream, frame) => measureScopePhase("callback.handoff-request", workspaceId, remoteDeviceId,
        () => options.onHandoffRequest!(stream, frame, connection.acceptStream), frame.byteLength) : undefined,
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
      const frame = await measureScopePhase("transport.response-read", workspaceId, remoteDeviceId,
        () => stream.read())
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
    const stream = await measureScopePhase(`transport.${kind}.open`, workspaceId, remoteDeviceId,
      () => connection.openStream(), frame.byteLength)
    await measureScopePhase(`transport.${kind}.send`, workspaceId, remoteDeviceId,
      () => stream.send(frame), frame.byteLength)
    await measureScopePhase(`transport.${kind}.close-send`, workspaceId, remoteDeviceId,
      () => stream.closeSend(), frame.byteLength)
    if (kind === "document") void consumeResponse(stream)
    return true
  }
  const receive = async (stream: DuplexStream, frame: Uint8Array): Promise<void> => {
    try {
      await measureScopePhase("scope.receive", workspaceId, remoteDeviceId,
        () => scope.receive(stream, frame), frame.byteLength)
    }
    catch (error) {
      if (!(error instanceof WorkspaceChangeRejected)) throw error
      if (lastRejection !== error.message) onDocumentRejected?.(error)
      lastRejection = error.message
    }
  }
  const incomingContext = { isStopped: () => stopped, liveness, receive, workspaceId, remoteDeviceId }
  const done = (async () => {
    try {
      while (!stopped) {
        const stream = await connection.acceptStream()
        if (stopped) return
        // Keep accepting independent QUIC streams while application storage
        // waits. Scope runtime still serializes document/control mutations.
        const task = handleLiveWorkspaceStream(stream, incomingContext)
        frameHandlers.add(task)
        void task.finally(() => frameHandlers.delete(task))
        if (frameHandlers.size >= 32) await Promise.race(frameHandlers)
      }
    } catch (error) { if (!stopped) throw error }
  })()
  return {
    done,
    async reconcile() {
      if (stopped) return
      try { await measureScopePhase("scope.reconcile-total", workspaceId, remoteDeviceId,
        () => scope.reconcile(sendFrame)) }
      catch (error) { if (!stopped) throw error }
    },
    async publish() {
      if (stopped) return
      try { await measureScopePhase("scope.publish-total", workspaceId, remoteDeviceId,
        () => scope.publish(sendFrame)) }
      catch (error) { if (!stopped) throw error }
    },
    heartbeat() {
      heartbeatQueue = enqueueHeartbeat(heartbeatQueue, () => stopped, connection, secret)
      return heartbeatQueue
    },
    async close() {
      stopped = true
      try { await connection.close() }
      finally { liveness.free?.(); await scope.close() }
    },
  }
}

async function handleLiveWorkspaceStream(stream: DuplexStream, context: {
  isStopped: () => boolean
  liveness: RustLiveWorkspaceSession
  receive: (stream: DuplexStream, frame: Uint8Array) => Promise<void>
  workspaceId: string
  remoteDeviceId: string
}): Promise<void> {
  const { liveness, receive, workspaceId, remoteDeviceId } = context
    const started = performance.now()
    let kind = "unread"
    try {
      const frame = await stream.read()
      if (context.isStopped()) return
      kind = inspectPairingFrame(frame).type
      meshTrace("workspace.receive.started", {
        workspaceId: workspaceId.slice(0, 8), peerId: remoteDeviceId.slice(0, 8), kind,
      })
      if (kind === "sync-heartbeat") {
        // Rust authenticates and validates heartbeat independently of pending
        // document storage. A liveness ACK never acknowledges persisted data.
        const operation = liveness.receiveWithPlan(frame)
        if (!operation || operation.action.kind !== "heartbeat") throw new Error("Invalid mesh heartbeat")
        await applyWorkspaceSetReceivePlan(liveness, operation, stream, frame, async () => {}, {})
      } else await receive(stream, frame)
    } catch (error) {
      if (!context.isStopped()) meshTrace("workspace.frame.rejected", {
        workspaceId: workspaceId.slice(0, 8), peerId: remoteDeviceId.slice(0, 8),
        reason: error instanceof Error ? error.message : String(error),
      }, "warn")
      await stream.closeSend().catch(() => {})
    } finally {
      meshTrace("workspace.receive.completed", {
        workspaceId: workspaceId.slice(0, 8), peerId: remoteDeviceId.slice(0, 8), kind,
        elapsedMs: Math.round(performance.now() - started),
      })
    }
}
