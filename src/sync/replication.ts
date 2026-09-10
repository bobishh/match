import * as Automerge from "@automerge/automerge/slim"
import type { ProofStore } from "../domain/proofs"

export const MAX_PHYSICAL_FRAME_SIZE = 1024 * 1024 // 1 MiB
export const MAX_REASSEMBLY_SIZE = 32 * 1024 * 1024 // 32 MiB
export const BLOB_CHUNK_SIZE = 256 * 1024 // 256 KiB

export type ReplicationScope =
  | { kind: "all" }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "workspaces"; workspaceIds: string[] }

export type BlobChunk = {
  messageId: string
  index: number
  count: number
  totalSize: number
  data: Uint8Array
}

export type BlobMetadata = {
  sha256: string
  totalSize: number
  chunksCount: number
  availableLocally: boolean
}

export type ReplicationProgress = {
  workspaceId: string
  documentsSynced: boolean
  filesPending: number
  filesTotal: number
  unavailableLocalPaths: string[]
  everythingSynced: boolean
}

export async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}

export class ReplicationService {
  public readonly peerId: string
  private proofStore: ProofStore

  // Peer management
  private peers = new Map<string, ReplicationScope>()
  // Peer -> DocumentId -> Automerge.SyncState
  private peerSyncStates = new Map<string, Map<string, Automerge.SyncState>>()

  // Local documents tracked
  private trackedDocs = new Map<string, Automerge.Doc<any>>()

  // Reassembly buffers for large payloads: messageId -> { totalSize, count, chunks: Map<number, Uint8Array> }
  private reassemblyBuffers = new Map<
    string,
    { totalSize: number; count: number; chunks: Map<number, Uint8Array> }
  >()

  // Blob storage: sha256 -> { bytes?: Uint8Array; chunks: Map<number, Uint8Array>; totalSize: number; chunksCount: number; complete: boolean }
  private blobs = new Map<
    string,
    {
      bytes?: Uint8Array
      chunks: Map<number, Uint8Array>
      totalSize: number
      chunksCount: number
      complete: boolean
    }
  >()

  // References: workspaceId -> Map<ref, { availableLocally: boolean; size: number }>
  private blobReferences = new Map<string, Map<string, { availableLocally: boolean; size: number }>>()
  // Track transferred blobs per peer: peerId -> Set<blobHash>
  private peerTransferredBlobs = new Map<string, Set<string>>()
  // Track document synchronization per peer: peerId -> Set<documentId>
  private peerSynchronizedDocs = new Map<string, Set<string>>()

  constructor(peerId: string, proofStore: ProofStore) {
    this.peerId = peerId
    this.proofStore = proofStore
  }

  registerPeer(peerId: string, scope: ReplicationScope) {
    this.peers.set(peerId, scope)
    if (!this.peerSyncStates.has(peerId)) {
      this.peerSyncStates.set(peerId, new Map())
    }
    if (!this.peerTransferredBlobs.has(peerId)) {
      this.peerTransferredBlobs.set(peerId, new Set())
    }
    if (!this.peerSynchronizedDocs.has(peerId)) {
      this.peerSynchronizedDocs.set(peerId, new Set())
    }
  }

  unregisterPeer(peerId: string) {
    this.peers.delete(peerId)
    this.peerSyncStates.delete(peerId)
    this.peerTransferredBlobs.delete(peerId)
    this.peerSynchronizedDocs.delete(peerId)
  }

  private checkDocumentAccess(peerId: string, documentId: string) {
    const scope = this.peers.get(peerId)
    if (!scope) {
      throw new Error(`Unauthorized: peer ${peerId} is not registered`)
    }
    if (scope.kind === "workspace" && scope.workspaceId !== documentId) {
      throw new Error(`Unauthorized document access: peer ${peerId} is scoped to ${scope.workspaceId}, requested ${documentId}`)
    }
    if (scope.kind === "workspaces" && !scope.workspaceIds.includes(documentId)) {
      throw new Error(`Unauthorized document access: peer ${peerId} is scoped to [${scope.workspaceIds.join(", ")}], requested ${documentId}`)
    }
  }

  trackDocument(documentId: string, doc: Automerge.Doc<any>) {
    this.trackedDocs.set(documentId, doc)
  }

  updateDocument(documentId: string, doc: Automerge.Doc<any>) {
    this.trackedDocs.set(documentId, doc)
    // Mark document as un-synchronized across peers until next round of messages completes
    for (const [peerId, set] of this.peerSynchronizedDocs.entries()) {
      set.delete(documentId)
    }
  }

  getDocument<T = any>(documentId: string): Automerge.Doc<T> | undefined {
    return this.trackedDocs.get(documentId)
  }

  getAdvertisedDocuments(peerId: string): string[] {
    const scope = this.peers.get(peerId)
    if (!scope) return []
    if (scope.kind === "workspace") {
      return this.trackedDocs.has(scope.workspaceId) ? [scope.workspaceId] : []
    }
    if (scope.kind === "workspaces") {
      return scope.workspaceIds.filter((id) => this.trackedDocs.has(id))
    }
    // "all" scope follows live catalog of tracked documents
    return Array.from(this.trackedDocs.keys())
  }

  private getOrCreateSyncState(peerId: string, documentId: string): Automerge.SyncState {
    let peerStates = this.peerSyncStates.get(peerId)
    if (!peerStates) {
      peerStates = new Map()
      this.peerSyncStates.set(peerId, peerStates)
    }
    let syncState = peerStates.get(documentId)
    if (!syncState) {
      syncState = Automerge.initSyncState()
      peerStates.set(documentId, syncState)
    }
    return syncState
  }

  generateSyncMessage(peerId: string, documentId: string): Uint8Array | null {
    this.checkDocumentAccess(peerId, documentId)
    const doc = this.trackedDocs.get(documentId)
    if (!doc) return null

    const syncState = this.getOrCreateSyncState(peerId, documentId)
    const [nextSyncState, message] = Automerge.generateSyncMessage(doc, syncState)
    this.peerSyncStates.get(peerId)!.set(documentId, nextSyncState)

    if (message === null) {
      this.peerSynchronizedDocs.get(peerId)?.add(documentId)
    }
    return message
  }

  receiveSyncMessage<T = any>(
    peerId: string,
    documentId: string,
    message: Uint8Array
  ): { doc: Automerge.Doc<T>; nextSyncState: Automerge.SyncState } {
    this.checkDocumentAccess(peerId, documentId)
    let doc = this.trackedDocs.get(documentId)
    if (!doc) {
      doc = Automerge.init()
    }

    const syncState = this.getOrCreateSyncState(peerId, documentId)
    const [nextDoc, nextSyncState] = Automerge.receiveSyncMessage(doc, syncState, message)

    this.trackedDocs.set(documentId, nextDoc)
    this.peerSyncStates.get(peerId)!.set(documentId, nextSyncState)

    return { doc: nextDoc as Automerge.Doc<T>, nextSyncState }
  }

  // 4.3 Framing & Chunking
  chunkPayload(messageId: string, payload: Uint8Array): BlobChunk[] {
    const totalSize = payload.length
    const count = Math.ceil(totalSize / MAX_PHYSICAL_FRAME_SIZE)
    const chunks: BlobChunk[] = []

    for (let index = 0; index < count; index++) {
      const start = index * MAX_PHYSICAL_FRAME_SIZE
      const end = Math.min(start + MAX_PHYSICAL_FRAME_SIZE, totalSize)
      const data = payload.slice(start, end)
      chunks.push({
        messageId,
        index,
        count,
        totalSize,
        data,
      })
    }
    return chunks
  }

  processChunk(peerId: string, chunk: BlobChunk): Uint8Array | null {
    if (chunk.totalSize > MAX_REASSEMBLY_SIZE) {
      throw new Error(`Oversized payload rejected: totalSize ${chunk.totalSize} exceeds maximum ${MAX_REASSEMBLY_SIZE}`)
    }
    if (chunk.data.length > MAX_PHYSICAL_FRAME_SIZE) {
      throw new Error(`Oversized frame rejected: chunk length ${chunk.data.length} exceeds physical limit ${MAX_PHYSICAL_FRAME_SIZE}`)
    }

    let buffer = this.reassemblyBuffers.get(chunk.messageId)
    if (!buffer) {
      buffer = {
        totalSize: chunk.totalSize,
        count: chunk.count,
        chunks: new Map(),
      }
      this.reassemblyBuffers.set(chunk.messageId, buffer)
    }

    buffer.chunks.set(chunk.index, chunk.data)

    if (buffer.chunks.size === buffer.count) {
      // Reassembly complete
      const fullPayload = new Uint8Array(buffer.totalSize)
      let offset = 0
      for (let i = 0; i < buffer.count; i++) {
        const slice = buffer.chunks.get(i)
        if (!slice) throw new Error(`Missing chunk index ${i} during reassembly`)
        fullPayload.set(slice, offset)
        offset += slice.length
      }
      this.reassemblyBuffers.delete(chunk.messageId)
      return fullPayload
    }

    return null
  }

  // 4.4 Content-addressed blob storage
  async storeBlob(
    _workspaceId: string,
    bytes: Uint8Array
  ): Promise<{ sha256: string; totalSize: number; chunksCount: number }> {
    const sha256 = await computeSha256Hex(bytes)
    const totalSize = bytes.length
    const chunksCount = Math.ceil(totalSize / BLOB_CHUNK_SIZE)
    const chunks = new Map<number, Uint8Array>()

    for (let i = 0; i < chunksCount; i++) {
      const start = i * BLOB_CHUNK_SIZE
      const end = Math.min(start + BLOB_CHUNK_SIZE, totalSize)
      chunks.set(i, bytes.slice(start, end))
    }

    this.blobs.set(sha256, {
      bytes,
      chunks,
      totalSize,
      chunksCount,
      complete: true,
    })

    return { sha256, totalSize, chunksCount }
  }

  getBlobChunk(sha256: string, index: number): Uint8Array | null {
    const blob = this.blobs.get(sha256)
    if (!blob) return null
    return blob.chunks.get(index) ?? null
  }

  async receiveBlobChunk(
    sha256: string,
    index: number,
    chunk: Uint8Array,
    totalSize: number,
    chunksCount: number
  ): Promise<void> {
    let blob = this.blobs.get(sha256)
    if (!blob) {
      blob = {
        chunks: new Map(),
        totalSize,
        chunksCount,
        complete: false,
      }
      this.blobs.set(sha256, blob)
    }

    blob.chunks.set(index, chunk)

    if (blob.chunks.size === blob.chunksCount) {
      // Assemble full bytes and verify sha256
      const full = new Uint8Array(blob.totalSize)
      let offset = 0
      for (let i = 0; i < blob.chunksCount; i++) {
        const slice = blob.chunks.get(i)
        if (!slice) return
        full.set(slice, offset)
        offset += slice.length
      }

      const verifiedSha256 = await computeSha256Hex(full)
      if (verifiedSha256 === sha256) {
        blob.bytes = full
        blob.complete = true
      } else {
        // Hash verification failed - reject corrupted blob
        blob.complete = false
      }
    }
  }

  isBlobComplete(sha256: string): boolean {
    return this.blobs.get(sha256)?.complete === true
  }

  getMissingBlobChunks(sha256: string): number[] {
    const blob = this.blobs.get(sha256)
    if (!blob) return []
    const missing: number[] = []
    for (let i = 0; i < blob.chunksCount; i++) {
      if (!blob.chunks.has(i)) {
        missing.push(i)
      }
    }
    return missing
  }

  getBlob(sha256: string): Uint8Array | null {
    const blob = this.blobs.get(sha256)
    if (!blob || !blob.complete) return null
    return blob.bytes ?? null
  }

  // 4.5 Progress Aggregation
  registerBlobReference(
    workspaceId: string,
    ref: string,
    meta: { availableLocally: boolean; size: number }
  ) {
    let refs = this.blobReferences.get(workspaceId)
    if (!refs) {
      refs = new Map()
      this.blobReferences.set(workspaceId, refs)
    }
    refs.set(ref, meta)
  }

  markDocumentSynchronized(peerId: string, documentId: string) {
    this.peerSynchronizedDocs.get(peerId)?.add(documentId)
  }

  markBlobTransferred(peerId: string, blobHash: string) {
    this.peerTransferredBlobs.get(peerId)?.add(blobHash)
  }

  getProgress(workspaceId: string, peerId: string): ReplicationProgress {
    const docsSynced = this.peerSynchronizedDocs.get(peerId)?.has(workspaceId) ?? false

    const refs = this.blobReferences.get(workspaceId) || new Map()
    const transferred = this.peerTransferredBlobs.get(peerId) || new Set()

    const unavailableLocalPaths: string[] = []
    let filesPending = 0
    let filesTotal = 0

    for (const [ref, meta] of refs.entries()) {
      if (!meta.availableLocally || ref.startsWith("local://") || ref.startsWith("file://")) {
        unavailableLocalPaths.push(ref)
        continue
      }
      filesTotal++
      if (!transferred.has(ref)) {
        filesPending++
      }
    }

    const everythingSynced = docsSynced && filesPending === 0

    return {
      workspaceId,
      documentsSynced: docsSynced,
      filesPending,
      filesTotal,
      unavailableLocalPaths,
      everythingSynced,
    }
  }
}
