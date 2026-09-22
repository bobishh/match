import {
  createBlobDescriptor,
  MeshBlobStore,
  type BlobDescriptor,
} from "@meta-uber/mesh-blob"
import { BrowserMeshStore } from "@meta-uber/mesh-browser-store"
import type { FileReference } from "./domain/model"

const blobs = new MeshBlobStore(
  new BrowserMeshStore("match-attachments-v1", ["blobs"]),
)

let fetchAttachment: ((descriptor: BlobDescriptor) => Promise<Uint8Array | undefined>) | undefined

export function configureAttachmentFetcher(
  fetcher: ((descriptor: BlobDescriptor) => Promise<Uint8Array | undefined>) | undefined,
): void {
  fetchAttachment = fetcher
}

export async function storeAttachment(file: File): Promise<FileReference> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const descriptor = await createBlobDescriptor(
    bytes,
    file.name,
    file.type || "application/octet-stream",
  )
  await blobs.put(descriptor, bytes)
  return referenceFromDescriptor(descriptor)
}

export async function readAttachment(
  reference: FileReference,
): Promise<Uint8Array | undefined> {
  const descriptor = blobDescriptor(reference)
  if (!descriptor) return undefined
  const local = await blobs.getVerified(descriptor)
  if (local || !fetchAttachment) return local
  const received = await fetchAttachment(descriptor)
  if (!received) return undefined
  await blobs.put(descriptor, received)
  return received
}

export async function readStoredAttachment(
  descriptor: BlobDescriptor,
): Promise<Uint8Array | undefined> {
  return blobs.getVerified(descriptor)
}

export async function writeStoredAttachment(
  descriptor: BlobDescriptor,
  bytes: Uint8Array,
): Promise<void> {
  await blobs.put(descriptor, bytes)
}

export function attachmentName(reference: FileReference): string {
  return reference.fileName
}

export function attachmentMediaType(reference: FileReference): string {
  return reference.type === "blob"
    ? reference.mimeType
    : "application/octet-stream"
}

export function attachmentSize(reference: FileReference): number | undefined {
  return reference.type === "blob" ? reference.byteLength : undefined
}

function referenceFromDescriptor(descriptor: BlobDescriptor): FileReference {
  return {
    type: "blob",
    ...(descriptor.blobId.startsWith("sha256:")
      ? { sha256: descriptor.blobId.slice("sha256:".length) }
      : { hash: descriptor.blobId.slice("blake3:".length) }),
    ...(descriptor.ticket ? { ticket: descriptor.ticket } : {}),
    byteLength: descriptor.size,
    mimeType: descriptor.mediaType,
    fileName: descriptor.name,
  }
}

export function blobDescriptor(
  reference: FileReference,
): BlobDescriptor | undefined {
  if (reference.type !== "blob") return undefined
  const blobId = reference.sha256
    ? `sha256:${reference.sha256}`
    : reference.hash
      ? `blake3:${reference.hash}`
      : undefined
  if (!blobId) return undefined
  return {
    kind: "blob",
    version: 1,
    blobId,
    name: reference.fileName,
    mediaType: reference.mimeType,
    size: reference.byteLength,
    ...(reference.hash ? { hash: reference.hash } : {}),
    ...(reference.ticket ? { ticket: reference.ticket } : {}),
  }
}
