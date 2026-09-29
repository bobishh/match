import { isItem, type Column, type Item, type WorkspaceDocumentV2 } from "./model"

export type ArchiveColumnLike = {
  archive?: true
  displayHint?: "normal" | "collapsed"
}

export function isArchiveColumn(column: ArchiveColumnLike): boolean {
  return column.archive === true || (column.archive === undefined && column.displayHint === "collapsed")
}

export function setArchiveColumn(column: ArchiveColumnLike, archive: boolean): void {
  if (archive) column.archive = true
  else delete column.archive
  column.displayHint = archive ? "collapsed" : "normal"
}

export function archivedItemsForBoard(doc: WorkspaceDocumentV2, boardId: string): Item[] {
  const columnIds = new Set(Object.values(doc.entities)
    .filter((entity): entity is Column => entity.kind === "column" && !entity.archivedAt && entity.placement.parentId === boardId)
    .map(column => column.id))
  return Object.values(doc.entities).filter((entity): entity is Item => isItem(entity) && Boolean(entity.archivedAt) && columnIds.has(entity.placement.parentId ?? ""))
}
