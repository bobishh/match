import { getAncestryPath } from "./ancestry"
import { hasEntityKind, isItem, type Item, type WorkspaceDocumentV2, type WorkspaceEntity } from "./model"

export type ItemLifecycle = { state: "active" | "archived"; changedAt: string }
export type ItemWorkflow = { columnId: string; changedAt: string }

function transitionRecord<T>(value: T | string | undefined): T | undefined {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as T } catch { return undefined }
}

export function itemLifecycle(item: Pick<Item, "archivedAt" | "lifecycle">): ItemLifecycle | undefined {
  return transitionRecord<ItemLifecycle>(item.lifecycle)
}

export function itemWorkflow(item: Pick<Item, "workflow">): ItemWorkflow | undefined {
  return transitionRecord<ItemWorkflow>(item.workflow)
}

export function isItemArchived(item: Pick<Item, "archivedAt" | "lifecycle">): boolean {
  return itemLifecycle(item)?.state === "archived" || (!itemLifecycle(item) && Boolean(item.archivedAt))
}

export function setItemLifecycle(item: Item, archived: boolean, changedAt: string): void {
  item.lifecycle = JSON.stringify({ state: archived ? "archived" : "active", changedAt } satisfies ItemLifecycle)
  delete item.archivedAt
}

export function setItemWorkflow(item: Item, columnId: string, changedAt: string): void {
  item.workflow = JSON.stringify({ columnId, changedAt } satisfies ItemWorkflow)
}

export function workflowColumnId(entities: Record<string, WorkspaceEntity>, entityId: string): string | undefined {
  return getAncestryPath(entities, entityId).path.find(id => hasEntityKind(entities[id], "column"))
}

export type ArchiveColumnLike = {
  archive?: true
  id?: string
  collapsible?: boolean
}

export function isArchiveColumn(column: ArchiveColumnLike, board?: { archiveColumnId?: string | null }): boolean {
  if (board && board.archiveColumnId !== undefined) return board.archiveColumnId === column.id
  return column.archive === true
}

export function isArchiveColumnInWorkspace(column: ArchiveColumnLike & { placement?: { parentId?: string | null } }, entities: Record<string, unknown>): boolean {
  const boardId = column.placement?.parentId
  const board = boardId ? entities[boardId] as { kind?: string; archiveColumnId?: string | null } | undefined : undefined
  if (board?.kind === "board" && board.archiveColumnId !== undefined) return board.archiveColumnId === column.id
  return column.archive === true
}

export function archivedItemsForBoard(doc: WorkspaceDocumentV2, boardId: string): Item[] {
  return Object.values(doc.entities).filter((entity): entity is Item => {
    if (!isItem(entity) || !isItemArchived(entity)) return false
    const ancestry = getAncestryPath(doc.entities, entity.id)
    return !ancestry.issue && ancestry.path.includes(boardId)
  })
}
