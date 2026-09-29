import { getAncestryPath } from "./ancestry"
import { isItem, type Item, type WorkspaceDocumentV2 } from "./model"

export type ArchiveColumnLike = {
  archive?: true
}

export function isArchiveColumn(column: ArchiveColumnLike): boolean {
  return column.archive === true
}

export function setArchiveColumn(column: ArchiveColumnLike, archive: boolean): void {
  if (archive) column.archive = true
  else delete column.archive
}

export function archivedItemsForBoard(doc: WorkspaceDocumentV2, boardId: string): Item[] {
  return Object.values(doc.entities).filter((entity): entity is Item => {
    if (!isItem(entity) || !entity.archivedAt) return false
    const ancestry = getAncestryPath(doc.entities, entity.id)
    return !ancestry.issue && ancestry.path.includes(boardId)
  })
}
