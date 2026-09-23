import { createLiveWorkspaceSession, type RustLiveWorkspaceSession } from "@meta-uber/mesh-runtime"
import { WorkspaceChangeRejected } from "./changeAuthorization"
import { fromBase64Url, toBase64Url } from "../domain/identity"
import * as Automerge from "@automerge/automerge/slim"
import { MeshNetworkError as SyncNetworkError } from "@meta-uber/mesh-transport"
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
      return new TextEncoder().encode(JSON.stringify(entries))
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
  const entries: Array<{ id: string; bytes: string; authorization?: unknown; chat?: unknown; mesh?: unknown }> = JSON.parse(new TextDecoder().decode(bytes))
  if (!Array.isArray(entries) || entries.length !== ids.length ||
    new Set(entries.map(e => e?.id)).size !== ids.length ||
    entries.some(e => !ids.includes(e?.id) || typeof e?.bytes !== "string")) {
    throw new Error("The peer sent a different set of workspaces than the invitation allows.")
  }
  return entries
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
  let lastSent = ""
  let queue = Promise.resolve()
  let heartbeatQueue = Promise.resolve()
  const knownChat = new Map<string, Set<string>>()
  const done = (async () => {
    while (!stopped) {
      const stream = await connection.acceptStream()
      if (stopped) return
      const frame = await stream.read()
      const action = protocol.receive(frame)
      if (!action) { await stream.closeSend(); continue }
      const bytes = Uint8Array.from(action.payload ?? [])
      if (action.kind === "durableBatch") {
        await replica.receive(bytes, false)
        await stream.send(protocol.acknowledgeSaved(bytes))
      } else if (action.kind === "heartbeat") {
        await stream.send(protocol.encode("sync-heartbeat-ack", new Uint8Array()))
      } else if (action.kind === "handoffRequest" && options.onHandoffRequest) {
        await options.onHandoffRequest(stream, frame)
        continue
      } else if (action.kind === "gossip" && options.onGossipPacket) {
        await options.onGossipPacket(bytes)
      } else if (action.kind === "blobRequest" && options.onBlobRequest) {
        await options.onBlobRequest(stream, frame)
        continue
      } else if (action.kind === "snapshot") {
        await replica.receive(bytes, false)
      } else {
        throw new Error(`Unsupported live workspace action: ${action.kind}`)
      }
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
        await stream.send(protocol.encode("sync-update", bytes))
        await stream.closeSend()
        lastSent = content
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

type AutomergeIncomingOptions = {
  connection: SyncConnection
  replica: ReturnType<typeof workspaceSet>
  options: LiveWorkspaceOptions
  isStopped: () => boolean
  receiveControl: (bytes: Uint8Array) => Promise<void>
  receiveSync: (frame: Uint8Array) => Promise<void>
  protocol: RustLiveWorkspaceSession
}

function requiredHandler<T>(handler: T | undefined, message: string): T {
  if (!handler) throw new Error(message)
  return handler
}

async function receiveAutomergeFrame(stream: DuplexStream, frame: Uint8Array, input: AutomergeIncomingOptions): Promise<void> {
  const action = input.protocol.receive(frame)
  if (!action) { await stream.closeSend(); return }
  const bytes = Uint8Array.from(action.payload ?? [])
  switch (action.kind) {
    case "durableBatch":
      await input.replica.receive(bytes, false)
      await stream.send(input.protocol.acknowledgeSaved(bytes))
      break
    case "heartbeat":
      await stream.send(input.protocol.encode("sync-heartbeat-ack", new Uint8Array()))
      break
    case "control":
      await input.receiveControl(bytes)
      break
    case "ownerWorkspaceOffer":
      await requiredHandler(input.options.ownerWorkspaceOfferFrame === "mesh-owner-workspace-offer"
        ? input.options.onOwnerWorkspaceOffer : undefined, "Unsupported owner workspace offer")(bytes)
      await stream.send(input.protocol.acknowledgeSaved(bytes))
      break
    case "gossip":
      await requiredHandler(input.options.onGossipPacket, "Unsupported gossip packet")(bytes)
      break
    case "blobRequest":
      await requiredHandler(input.options.onBlobRequest, "Unsupported blob request")(stream, frame)
      return
    case "handoffRequest":
      await requiredHandler(input.options.onHandoffRequest, "Unsupported handoff request")(stream, frame)
      return
    case "automergeSync":
      await input.receiveSync(bytes)
      break
    case "snapshot":
      throw new Error(`Unsupported live workspace action: ${action.kind}`)
  }
  await stream.closeSend()
}

async function runAutomergeReceiver(input: AutomergeIncomingOptions): Promise<void> {
  while (!input.isStopped()) {
    const stream = await input.connection.acceptStream()
    if (input.isStopped()) return
    await receiveAutomergeFrame(stream, await stream.read(), input)
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
  let syncQueue = Promise.resolve()
  let heartbeatQueue = Promise.resolve()
  const protocol = createLiveWorkspaceSession(workspaceId, secret)
  protocol.startDocumentSync(localDeviceId, remoteDeviceId)
  const knownChat = new Set<string>()
  const sendFrame = async (frame: Uint8Array) => {
    if (stopped) return
    const stream = await connection.openStream()
    await stream.send(frame)
    await stream.closeSend()
  }
  const controlSnapshot = async () => new TextEncoder().encode(JSON.stringify({
    version: 1,
    workspaceId,
    ...(store.readAuthorization ? { authorization: await store.readAuthorization(await store.read(workspaceId)) } : {}),
    ...(store.readChat ? { chat: await store.readChat(workspaceId, knownChat) } : {}),
    ...(store.readMesh ? { mesh: await store.readMesh(workspaceId) } : {}),
  }))
  const receiveControl = async (bytes: Uint8Array) => {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as {
      version?: unknown; workspaceId?: unknown; authorization?: unknown; chat?: unknown; mesh?: unknown
    }
    if (value.version !== 1 || value.workspaceId !== workspaceId) throw new Error("Invalid mesh control frame")
    if (value.authorization !== undefined) {
      await store.merge(workspaceId, await store.read(workspaceId), value.authorization)
      // Authorization changes the admission result for already exchanged
      // Automerge heads. Re-negotiate instead of retaining a state that only
      // remembers the pre-proof rejection.
      protocol.resetDocument()
    }
    if (value.chat !== undefined && store.mergeChat) await store.mergeChat(workspaceId, value.chat, false)
    if (value.mesh !== undefined && store.mergeMesh) await store.mergeMesh(workspaceId, value.mesh)
  }
  const enqueue = (run: () => Promise<void>) => {
    syncQueue = syncQueue.then(run, run)
    return syncQueue
  }
  const receiveSync = async (frame: Uint8Array) => {
    try {
      await enqueue(async () => {
        const current = await store.read(workspaceId)
        const responseProof = await store.readAuthorization?.(current)
        const result = protocol.prepareDocument(frame, current, responseProof)
        try {
          if (result.acceptedChanges > 0) {
            const candidate = new Uint8Array(result.document)
            const document = Automerge.load<{ id?: unknown }>(candidate)
            if (document.id !== workspaceId) throw new Error("Wrong workspace document")
            await store.merge(workspaceId, candidate, result.proof)
          } else if (store.readAuthorization && result.proof !== undefined) {
            await store.merge(workspaceId, current, result.proof)
          }
          protocol.commitDocument()
        } catch (error) {
          protocol.abortDocument()
          throw error
        }
        if (result.response) await sendFrame(new Uint8Array(result.response))
        if (lastRejection && result.acceptedChanges > 0) { lastRejection = undefined; onDocumentRejected?.(null) }
      })
    } catch (error) {
      if (!(error instanceof WorkspaceChangeRejected)) throw error
      protocol.resetDocument()
      if (lastRejection !== error.message) onDocumentRejected?.(error)
      lastRejection = error.message
    }
  }
  const done = runAutomergeReceiver({ connection, replica: workspaceSet(store, [workspaceId]),
    options, isStopped: () => stopped, receiveControl, receiveSync, protocol }).catch(error => { if (!stopped) throw error })
  return {
    done,
    publish() {
      return enqueue(async () => {
        const current = await store.read(workspaceId)
        const frame = protocol.generateDocument(current, await store.readAuthorization?.(current))
        if (frame) await sendFrame(frame)
        const control = await controlSnapshot()
        if (protocol.controlChanged(control)) {
          for (const part of protocol.controlFrames(control)) {
            const stream = await connection.openStream()
            await stream.send(part)
            await stream.closeSend()
          }
          protocol.markControlSent(control)
        }
      })
    },
    heartbeat() {
      heartbeatQueue = enqueueHeartbeat(heartbeatQueue, () => stopped, connection, secret)
      return heartbeatQueue
    },
    async close() { stopped = true; await connection.close(); protocol.free?.() },
  }
}
