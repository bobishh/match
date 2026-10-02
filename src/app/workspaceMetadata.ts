import { hasEntityKind, type WorkspaceDocumentV2 } from "../domain/model"
import { blobDescriptor } from "../attachments"

export function workspaceChatRoomId(doc: WorkspaceDocumentV2): string {
  const board = Object.values(doc.entities).find(entity => hasEntityKind(entity, "board"))
  if (!board) throw new Error("Workspace has no board")
  return `${doc.ownerPersonId}:${board.id}`
}

export function workspaceBlobDescriptor(doc: WorkspaceDocumentV2, blobId: string) {
  for (const entity of Object.values(doc.entities)) {
    const references = hasEntityKind(entity, "document")
      ? [entity.file]
      : hasEntityKind(entity, "artifact")
        ? [entity.pdf, entity.sourceMarkdown]
        : []
    for (const reference of references) {
      if (!reference) continue
      const descriptor = blobDescriptor(reference)
      if (descriptor?.blobId === blobId) return descriptor
    }
  }
  return undefined
}
