import { computed, nextTick, watch } from "vue"
import Sortable from "sortablejs"
import type { useAppCore } from "./useAppCore"
import { activeFilterCount, defaultBoardFilters, matchesItemFilters } from "../filters"
import { isArchiveColumn } from "../domain/archive"
import { projectEntityHistory } from "../domain/history"
import { isItem, type AttachedDocument, type Item } from "../domain/model"
import type { LeadStatus } from "../types"
import { orderItemsByPriority } from "../domain/priority"
import { itemNarrative } from "../domain/narrative"

export type AppBoardContext = Pick<ReturnType<typeof useAppCore>,
  | "match"
  | "search" | "filters" | "isEditingBoard" | "itemFormParentId" | "activeMobileColumnIndex"
  | "boardRef" | "movedItemId" | "movedColumnId" | "onlineWorkspaceDevices"
  | "canEditItems" | "canEditBoard" | "notice" | "archiveUndo" | "boardRenderKey"
  | "selectedItemId" | "editingItemId" | "itemToMove" | "selectedLeadId" | "detailDialog"
  | "quickNoteDraft" | "quickNoteError"
>

export function useAppBoard(core: AppBoardContext) {
  const presentation = useBoardPresentation(core)
  const sortable = useBoardSortables(core, presentation)
  const selection = useBoardSelection(core)
  return { ...presentation, ...sortable, ...selection }
}

function useBoardPresentation(core: AppBoardContext) {
  const { match, search, filters, isEditingBoard, itemFormParentId, activeMobileColumnIndex, boardRef, movedItemId, movedColumnId } = core
  const workspaceLabel = computed(() => match.activeWorkspace.title.toLowerCase() === "job search" ? "jobs" : match.activeWorkspace.title)
  const entityName = computed(() => match.activeBoard.value?.entityName || (match.activeBoard.value?.preset?.key === "job-search" ? "lead" : "item"))
  const addItemLabel = computed(() => `+ Add ${entityName.value}`)
  const columnStatus = (columnId: string): LeadStatus | null => {
    const bindings = match.activeBoard.value?.preset?.bindings
    return bindings ? (Object.entries(bindings).find(([, id]) => id === columnId)?.[0].replace("status.", "") as LeadStatus | undefined) ?? null : null
  }
  const itemFormColumns = computed(() => match.genericColumns.value.filter(column => !isArchiveColumn(column)).map(column => ({ ...column, formValue: match.isBlankBoard.value ? column.id : columnStatus(column.id) ?? column.id })))
  const itemFormParentValue = computed(() => match.isBlankBoard.value ? itemFormParentId.value : columnStatus(itemFormParentId.value) ?? itemFormParentId.value)
  const computedItemFieldIds = computed(() => {
    const policy = match.activeBoard.value?.priorityPolicy
    return policy ? [policy.priorityFieldId, policy.fitFieldId].filter((id): id is string => Boolean(id)) : []
  })
  const itemFormOptionValues = computed(() => Object.fromEntries(Object.entries(match.activeBoard.value?.preset?.bindings ?? {}).filter(([binding]) => binding.startsWith("option.")).map(([binding, optionId]) => [optionId, binding.split(".").at(-1)!])))
  const leadsById = computed(() => new Map(match.workspace.leads.map(lead => [lead.id, lead])))
  const leadForItem = (item: Item) => match.isBlankBoard.value ? undefined : leadsById.value.get(item.id)
  const notesByItem = computed(() => {
    void match.docVersion.value
    const notes = new Map<string, AttachedDocument[]>()
    for (const entity of Object.values(match.getActiveDoc()?.entities ?? {})) {
      if (entity.kind !== "document" || entity.documentKind !== "note" || entity.archivedAt || !entity.placement.parentId) continue
      const attached = notes.get(entity.placement.parentId) ?? []
      attached.push(entity)
      notes.set(entity.placement.parentId, attached)
    }
    return notes
  })
  const searchableTextByItem = computed(() => {
    void match.docVersion.value
    const doc = match.getActiveDoc()
    if (!doc) return new Map<string, string>()
    const leads = leadsById.value
    const notes = notesByItem.value
    const notesFieldId = textNotesFieldId()
    const searchable = new Map<string, string>()
    for (const entity of Object.values(doc.entities)) {
      if (!isItem(entity)) continue
      const lead = match.isBlankBoard.value ? undefined : leads.get(entity.id)
      const narrative = itemNarrative(entity, lead ? notesFieldId : undefined, notes.get(entity.id) ?? [])
      const fieldText = Object.values(entity.values).filter(value => value !== null).join(" ")
      searchable.set(entity.id, (lead
        ? `${lead.company} ${lead.role} ${narrative} ${fieldText}`
        : `${entity.title} ${narrative} ${fieldText}`).toLowerCase())
    }
    return searchable
  })
  const normalizedSearch = computed(() => search.value.trim().toLowerCase())
  const textNotesFieldId = () => {
    const id = match.activeBoard.value?.preset?.bindings["field.notes"]
    return id && match.boardFields.value.some(field => field.id === id && field.valueType === "text") ? id : undefined
  }
  const cardNotes = (item: Item) => {
    const notes = notesByItem.value.get(item.id) ?? []
    return itemNarrative(item, leadForItem(item) ? textNotesFieldId() : undefined, notes)
  }
  const cardFields = (item: Item) => cardFieldValues(item, match.boardFields.value, match.activeBoard.value?.preset?.bindings ?? {}, leadForItem(item))
  const itemsByColumn = computed(() => {
    const board = match.activeBoard.value
    const query = normalizedSearch.value
    const activeFilters = filters.value
    const notesFieldId = textNotesFieldId()
    const searchable = query ? searchableTextByItem.value : null
    return new Map(match.genericColumns.value.map(column => [column.id, orderItemsByPriority(board, column.items.filter(item => {
      const matchesSearch = !query || searchable?.get(item.id)?.includes(query) === true
      return matchesSearch && matchesItemFilters(item, column.id, activeFilters)
    }), notesFieldId)]))
  })
  const itemsForColumn = (column: { id: string; items: Item[] }) => itemsByColumn.value.get(column.id) ?? []
  const totalItems = computed(() => match.genericColumns.value.reduce((total, column) => total + column.items.length, 0))
  const visibleItems = computed(() => match.genericColumns.value.reduce((total, column) => total + itemsForColumn(column).length, 0))
  const hasFilters = computed(() => Boolean(search.value.trim()) || activeFilterCount(filters.value) > 0)
  const workspacePresenceSummary = computed(() => summarizeWorkspace(totalItems.value, visibleItems.value, match.workspace.documents.length + match.workspace.artifacts.length, core.onlineWorkspaceDevices.value, hasFilters.value))
  const visibleColumns = computed(() => visibleBoardColumns(match.genericColumns.value, hasFilters.value, isEditingBoard.value, filters.value.columnId, itemsForColumn))
  const clearFilters = () => { search.value = ""; filters.value = defaultBoardFilters() }
  const updateMobileColumnIndex = () => { activeMobileColumnIndex.value = mobileColumnIndex(boardRef.value) }
  const moveMobileColumn = (direction: -1 | 1) => moveBoardColumn(boardRef.value, visibleColumns.value, activeMobileColumnIndex, direction)
  let highlightTimer: ReturnType<typeof setTimeout> | undefined
  const highlightMoved = (entityId: string, kind: "item" | "column") => {
    if (highlightTimer) clearTimeout(highlightTimer)
    if (kind === "item") movedItemId.value = entityId
    else movedColumnId.value = entityId
    highlightTimer = setTimeout(() => { movedItemId.value = null; movedColumnId.value = null }, 700)
  }
  const clearHighlightTimer = () => { if (highlightTimer) clearTimeout(highlightTimer) }
  return { workspaceLabel, entityName, addItemLabel, itemFormColumns, itemFormParentValue, computedItemFieldIds, itemFormOptionValues, leadForItem, cardNotes, cardFields, columnStatus, itemsForColumn, totalItems, visibleItems, hasFilters, workspacePresenceSummary, visibleColumns, clearFilters, updateMobileColumnIndex, moveMobileColumn, highlightMoved, clearHighlightTimer }
}

function cardFieldValues(item: Item, fields: ReturnType<typeof useAppCore>["match"]["boardFields"]["value"], bindings: Record<string, string>, lead: unknown) {
  const summaryFields = lead ? ["company", "role", "priority", "location", "fitScore"].map(name => bindings[`field.${name}`]) : []
  return fields.flatMap(field => {
    const value = item.values[field.id]
    if (field.archivedAt || summaryFields.includes(field.id) || value === null || value === undefined || value === "") return []
    const label = field.valueType === "select" ? field.options[String(value)]?.title : typeof value === "boolean" ? (value ? "Yes" : "No") : String(value)
    return label ? [{ id: field.id, title: field.title, value: label }] : []
  })
}

function summarizeWorkspace(totalItems: number, visibleItems: number, totalDocuments: number, devices: number, hasFilters: boolean) {
  const cards = hasFilters ? `${visibleItems} of ${totalItems} cards` : `${totalItems} ${totalItems === 1 ? "card" : "cards"}`
  const docs = `${totalDocuments} ${totalDocuments === 1 ? "doc" : "docs"}`
  return `${cards} · ${docs} · ${devices} ${devices === 1 ? "device" : "devices"}`
}

function visibleBoardColumns(columns: ReturnType<typeof useAppCore>["match"]["genericColumns"]["value"], hasFilters: boolean, isEditing: boolean, selectedColumnId: string | undefined, itemsForColumn: (column: { id: string; items: Item[] }) => Item[]) {
  if (!hasFilters || isEditing) return columns
  if (selectedColumnId) return columns.filter(column => column.id === selectedColumnId)
  return columns.filter(column => itemsForColumn(column).length > 0)
}

function mobileColumnIndex(board: HTMLElement | null) {
  if (!board || window.matchMedia("(min-width: 561px)").matches) return 0
  const columns = [...board.querySelectorAll<HTMLElement>(":scope > .column")]
  if (!columns.length) return 0
  return columns.reduce((closest, column, current) => Math.abs(column.offsetLeft - board.scrollLeft) < Math.abs(columns[closest].offsetLeft - board.scrollLeft) ? current : closest, 0)
}

function moveBoardColumn(board: HTMLElement | null, columns: unknown[], index: { value: number }, direction: -1 | 1) {
  if (!board || !columns.length) return
  const target = Math.min(columns.length - 1, Math.max(0, index.value + direction))
  board.querySelectorAll<HTMLElement>(":scope > .column")[target]?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest", inline: "start" })
  index.value = target
}

function useBoardSortables(core: AppBoardContext, presentation: ReturnType<typeof useBoardPresentation>) {
  let columnSortable: Sortable | null = null
  let cardSortables: Sortable[] = []
  let touchPoint: { x: number; y: number } | null = null
  let removeTouchTracking: (() => void) | null = null
  const destroyBoardSortables = () => {
    const dragged = Sortable.dragged
    const active = Sortable.active
    const ownsDrag = Boolean(active && (active === columnSortable || cardSortables.includes(active)) ||
      dragged && (columnSortable?.el.contains(dragged) || cardSortables.some(sortable => sortable.el.contains(dragged))))
    // Sortable.destroy() nulls these references without removing fallback DOM.
    const ghost = ownsDrag ? Sortable.ghost : null
    const clone = ownsDrag ? Sortable.clone : null
    columnSortable?.destroy()
    columnSortable = null
    cardSortables.forEach(sortable => sortable.destroy())
    cardSortables = []
    removeTouchTracking?.()
    removeTouchTracking = null
    touchPoint = null
    ghost?.remove()
    clone?.remove()
    return ownsDrag
  }
  const setupBoardSortables = async () => {
    await nextTick()
    if (destroyBoardSortables()) {
      // Discard Sortable's temporary placement and rebuild from persisted state.
      core.boardRenderKey.value += 1
      return
    }
    const board = core.boardRef.value
    if (!board || !core.match.activeBoard.value || !core.canEditItems.value) return
    if (core.isEditingBoard.value) return setupColumnSortable(board, core, presentation, value => { columnSortable = value })
    removeTouchTracking = addTouchTracking(board, point => { touchPoint = point })
    cardSortables = setupCardSortables(board, core, presentation, () => touchPoint, () => { touchPoint = null })
  }
  return { destroyBoardSortables, setupBoardSortables }
}

const dragOrigins = new WeakMap<HTMLElement, { parent: Node; next: Node | null }>()
function rememberDrag(event: Sortable.SortableEvent) {
  const item = event.item
  if (item.parentNode) dragOrigins.set(item, { parent: item.parentNode, next: item.nextSibling })
}
function restoreDrag(item: HTMLElement) {
  const origin = dragOrigins.get(item)
  if (!origin) return
  origin.parent.insertBefore(item, origin.next?.parentNode === origin.parent ? origin.next : null)
  dragOrigins.delete(item)
}

function setupColumnSortable(board: HTMLElement, core: AppBoardContext, presentation: ReturnType<typeof useBoardPresentation>, setSortable: (sortable: Sortable) => void) {
  if (!core.canEditBoard.value) return
  setSortable(Sortable.create(board, {
    animation: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180, direction: "horizontal", draggable: ".column", handle: ".column-drag-handle", filter: "button, input, select, textarea", ghostClass: "column-sortable-ghost", chosenClass: "column-sortable-chosen", dragClass: "column-sortable-drag", forceFallback: true, fallbackTolerance: 4,
    onStart: rememberDrag,
    onEnd(event) {
      if (event.oldIndex === event.newIndex) return
      const entityId = (event.item as HTMLElement).dataset.columnId
      const columns = [...board.querySelectorAll<HTMLElement>(":scope > .column")]
      const index = columns.findIndex(column => column.dataset.columnId === entityId)
      const beforeId = columns[index + 1]?.dataset.columnId ?? null
      if (!entityId) return
      restoreDrag(event.item)
      void core.match.executeCommandAsync({ kind: "moveEntity", entityId, parentId: core.match.activeBoard.value!.id, beforeId }).then(() => { presentation.highlightMoved(entityId, "column"); core.notice.value = "Column moved" }).catch(error => { core.notice.value = `Move failed: ${error.message}` })
    },
  }))
}

function addTouchTracking(board: HTMLElement, update: (point: { x: number; y: number } | null) => void) {
  const reset = () => update(null)
  const track = (event: TouchEvent) => { const touch = event.touches[0] ?? event.changedTouches[0]; if (touch) update({ x: touch.clientX, y: touch.clientY }) }
  board.addEventListener("touchstart", reset, { passive: true })
  board.addEventListener("touchmove", track, { passive: true })
  board.addEventListener("touchend", track, { passive: true })
  return () => { board.removeEventListener("touchstart", reset); board.removeEventListener("touchmove", track); board.removeEventListener("touchend", track) }
}

function setupCardSortables(board: HTMLElement, core: AppBoardContext, presentation: ReturnType<typeof useBoardPresentation>, readTouchPoint: () => { x: number; y: number } | null, clearTouchPoint: () => void) {
  return [...board.querySelectorAll<HTMLElement>(".card-stack[data-column-id]")].map(stack => Sortable.create(stack, {
    group: "board-cards", animation: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180, draggable: ".lead-card[data-item-id]", filter: "input", preventOnFilter: false, ghostClass: "card-sortable-ghost", chosenClass: "card-sortable-chosen", dragClass: "card-sortable-drag", emptyInsertThreshold: 48, forceFallback: true, delay: 180, delayOnTouchOnly: true, touchStartThreshold: 8, fallbackTolerance: 4, fallbackOnBody: true, scroll: true, bubbleScroll: true, scrollSensitivity: 96, scrollSpeed: 16,
    onStart: rememberDrag,
    onEnd(event) { moveSortableCard(event, board, core, presentation, readTouchPoint(), clearTouchPoint) },
  }))
}

function moveSortableCard(event: Sortable.SortableEvent, board: HTMLElement, core: AppBoardContext, presentation: ReturnType<typeof useBoardPresentation>, touchPoint: { x: number; y: number } | null, clearTouchPoint: () => void) {
  const item = event.item as HTMLElement
  const itemId = item.dataset.itemId
  const target = cardDropTarget(event.to as HTMLElement, board, touchPoint)
  clearTouchPoint()
  const parentId = target.dataset.columnId
  if (!itemId || !parentId) { restoreDrag(item); return }
  const cards = [...target.querySelectorAll<HTMLElement>(":scope > .lead-card[data-item-id]")]
  const beforeId = cards[cards.findIndex(card => card.dataset.itemId === itemId) + 1]?.dataset.itemId ?? null
  const sourceColumn = core.match.genericColumns.value.find(column => column.id === event.from.dataset.columnId)
  const archiveTarget = core.match.genericColumns.value.find(column => column.id === parentId)
  const targetIsArchive = Boolean(archiveTarget && isArchiveColumn(archiveTarget))
  const sourceItem = core.match.getActiveDoc()?.entities[itemId]
  if (targetIsArchive && sourceItem && isItem(sourceItem) && sourceItem.archivedAt) { restoreDrag(item); return }
  const command = targetIsArchive
    ? { kind: "setEntityArchived" as const, entityId: itemId, archived: true }
    : sourceItem && isItem(sourceItem) && sourceItem.archivedAt
      ? { kind: "restoreAndMove" as const, entityId: itemId, parentId, beforeId }
      : { kind: "moveEntity" as const, entityId: itemId, parentId, beforeId }
  restoreDrag(item)
  void core.match.executeCommandAsync(command).then(() => {
    presentation.highlightMoved(itemId, "item")
    if (targetIsArchive && sourceColumn) {
      core.archiveUndo.value = { workspaceId: core.match.activeWorkspace.id, itemId, title: item.querySelector(".card-open-button")?.getAttribute("aria-label")?.replace(/^Open /, "") || "item" }
      core.notice.value = "Item archived"
    } else core.notice.value = "Item moved"
  }).catch(error => { core.notice.value = `Move failed: ${error.message}` })
}

function cardDropTarget(target: HTMLElement, board: HTMLElement, touchPoint: { x: number; y: number } | null) {
  if (!touchPoint) return target
  const column = [...board.querySelectorAll<HTMLElement>(":scope > .column")].find(candidate => {
    const bounds = candidate.getBoundingClientRect()
    return touchPoint.x >= bounds.left && touchPoint.x <= bounds.right && touchPoint.y >= bounds.top && touchPoint.y <= bounds.bottom
  })
  return column?.querySelector<HTMLElement>(".card-stack[data-column-id]") ?? target
}

function useBoardSelection(core: AppBoardContext) {
  const selectedItem = computed(() => readSelectedItem(core))
  const subitemsForSelectedItem = computed(() => selectedItem.value ? readSubitems(core, selectedItem.value.id) : [])
  const selectedItemHistory = computed(() => {
    void core.match.docVersion.value
    const doc = core.match.getActiveDoc()
    return doc && core.selectedItemId.value ? projectEntityHistory(doc, core.selectedItemId.value) : []
  })
  const editingItem = computed(() => core.editingItemId.value ? readItem(core, core.editingItemId.value) : null)
  const candidateParentsForMove = computed(() => itemParents(core))
  watch(core.selectedLeadId, async leadId => { if (leadId) { await nextTick(); core.detailDialog.value?.focus() } })
  watch([core.selectedLeadId, core.selectedItemId], () => { core.quickNoteDraft.value = ""; core.quickNoteError.value = "" })
  return { selectedItem, subitemsForSelectedItem, selectedItemHistory, editingItem, candidateParentsForMove }
}

function readSelectedItem(core: AppBoardContext) {
  void core.match.docVersion.value
  return core.selectedItemId.value ? readItem(core, core.selectedItemId.value) : null
}

function readItem(core: AppBoardContext, id: string) {
  const entity = core.match.getActiveDoc()?.entities[id]
  return isItem(entity) ? entity : null
}

function readSubitems(core: AppBoardContext, parentId: string) {
  const doc = core.match.getActiveDoc()
  return doc ? Object.values(doc.entities).filter((entity): entity is Item => isItem(entity) && entity.placement.parentId === parentId && !entity.archivedAt) : []
}

function itemParents(core: AppBoardContext) {
  const current = core.itemToMove.value
  const doc = core.match.getActiveDoc()
  return current && doc ? Object.values(doc.entities).filter((entity): entity is Item => isItem(entity) && entity.id !== current.id && !entity.archivedAt).map(item => ({ id: item.id, title: item.title })) : []
}
