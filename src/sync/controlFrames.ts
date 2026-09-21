import { fromBase64Url, toBase64Url } from "../domain/identity"

const FRAME_BYTES = 256 * 1024
const CHUNK_BYTES = 128 * 1024
const SNAPSHOT_BYTES = 24 * 1024 * 1024
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
type Chunk = { version: 2; workspaceId: string; transferId: string; index: number; totalBytes: number; data: string }
type Pending = { id: string; size: number; parts: Map<number, Uint8Array> }

export function* controlFrames(workspaceId: string, bytes: Uint8Array): Generator<Uint8Array> {
  if (bytes.length > SNAPSHOT_BYTES) throw new Error("Mesh control snapshot exceeds size limit")
  if (bytes.length <= FRAME_BYTES) { yield bytes; return }
  const transferId = crypto.randomUUID()
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    yield encode({ version: 2, workspaceId, transferId, index: offset / CHUNK_BYTES,
      totalBytes: bytes.length, data: toBase64Url(bytes.subarray(offset, offset + CHUNK_BYTES)) })
  }
}

function parseChunk(value: unknown, workspaceId: string): Chunk {
  const chunk = value as Partial<Chunk> | null
  if (!chunk || chunk.version !== 2 || chunk.workspaceId !== workspaceId ||
    typeof chunk.transferId !== "string" || chunk.transferId.length !== 36 ||
    !Number.isInteger(chunk.totalBytes) || chunk.totalBytes! <= FRAME_BYTES || chunk.totalBytes! > SNAPSHOT_BYTES ||
    !Number.isInteger(chunk.index) || chunk.index! < 0 || chunk.index! >= Math.ceil(chunk.totalBytes! / CHUNK_BYTES) ||
    typeof chunk.data !== "string") throw new Error("Invalid mesh control chunk")
  return chunk as Chunk
}

export class ControlFrameReceiver {
  private pending?: Pending
  constructor(private readonly workspaceId: string) {}

  receive(bytes: Uint8Array): Uint8Array | undefined {
    if (bytes.length > FRAME_BYTES) throw new Error("Mesh control frame exceeds size limit")
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if ((value as { version?: unknown } | null)?.version !== 2) {
      if (this.pending) throw new Error("Incomplete mesh control snapshot")
      return bytes
    }
    const chunk = parseChunk(value, this.workspaceId)
    const part = fromBase64Url(chunk.data)
    const expected = Math.min(CHUNK_BYTES, chunk.totalBytes - chunk.index * CHUNK_BYTES)
    if (part.length !== expected) throw new Error("Invalid mesh control chunk length")
    this.pending ??= { id: chunk.transferId, size: chunk.totalBytes, parts: new Map() }
    const pending = this.pending
    if (pending.id !== chunk.transferId || pending.size !== chunk.totalBytes || pending.parts.has(chunk.index)) {
      throw new Error("Conflicting mesh control chunk")
    }
    pending.parts.set(chunk.index, part)
    if (pending.parts.size !== Math.ceil(pending.size / CHUNK_BYTES)) return
    const complete = new Uint8Array(pending.size)
    for (const [index, data] of pending.parts) complete.set(data, index * CHUNK_BYTES)
    this.pending = undefined
    return complete
  }
}
