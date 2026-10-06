import { computed, nextTick, watch } from "vue"
import type { useAppCore } from "./useAppCore"
import { useBoardDragController } from "./useBoardDrag"
import { activeFilterCount, defaultBoardFilters, matchesItemFilters } from "../filters"
import { isArchiveColumn, isItemArchived } from "../domain/archive"
import { projectEntityHistory } from "../domain/history"
import { isItem, type AttachedDocument, type Item } from "../domain/model"
import type { LeadStatus } from "../types"
import { orderItemsByPriority } from "../domain/priority"
import { itemNarrative } from "../domain/narrative"

export type AppBoardContext = Pick<ReturnType<typeof useAppCore>,
  | "tincanban"
  | "search" | "filters" | "isEditingBoard" | "itemFormParentId" | "activeMobileColumnIndex"
  | "boardRef" | "movedItemId" | "movedColumnId" | "onlineWorkspaceDevices"
  | "canEditItems" | "canEditBoard" | "notice" | "archiveUndo" | "boardRenderKey"
  | "selectedItemId" | "editingItemId" | "itemToMove" | "selectedLeadId" | "detailDialog"
  | "quickNoteDraft" | "quickNoteError"
>

export function useAppBoard(core: AppBoardContext) {
  const presentation = useBoardPresentation(core)
  const drag = useBoardDragController(core, presentation)
  const selection = useBoardSelection(core)
  return { ...presentation, ...drag, ...selection }
}

function useBoardPresentation(core: AppBoardContext) {
  const { tincanban, search, filters, isEditingBoard, itemFormParentId, activeMobileColumnIndex, boardRef, movedItemId, movedColumnId } = core
  const workspaceLabel = computed(() => tincanban.activeWorkspace.title.toLowerCase() === "job search" ? "jobs" : tincanban.activeWorkspace.title)
  const entityName = computed(() => tincanban.activeBoard.value?.entityName || (tincanban.activeBoard.value?.preset?.key === "job-search" ? "lead" : "item"))
  const addItemLabel = computed(() => `+ Add ${entityName.value}`)
  const columnStatus = (columnId: string): LeadStatus | null => {
    const bindings = tincanban.activeBoard.value?.preset?.bindings
    return bindings ? (Object.entries(bindings).find(([, id]) => id === columnId)?.[0].replace("status.", "") as LeadStatus | undefined) ?? null : null
  }
  const itemFormColumns = computed(() => tincanban.genericColumns.value.filter(column => !isArchiveColumn(column)).map(column => ({ ...column, formValue: tincanban.isBlankBoard.value ? column.id : columnStatus(column.id) ?? column.id })))
  const itemFormParentValue = computed(() => tincanban.isBlankBoard.value ? itemFormParentId.value : columnStatus(itemFormParentId.value) ?? itemFormParentId.value)
  const computedItemFieldIds = computed(() => {
    const policy = tincanban.activeBoard.value?.priorityPolicy
    return policy ? [policy.priorityFieldId, policy.fitFieldId].filter((id): id is string => Boolean(id)) : []
  })
  const itemFormOptionValues = computed(() => Object.fromEntries(Object.entries(tincanban.activeBoard.value?.preset?.bindings ?? {}).filter(([binding]) => binding.startsWith("option.")).map(([binding, optionId]) => [optionId, binding.split(".").at(-1)!])))
  const leadsById = computed(() => new Map(tincanban.workspace.leads.map(lead => [lead.id, lead])))
  const leadForItem = (item: Item) => tincanban.isBlankBoard.value ? undefined : leadsById.value.get(item.id)
  const notesByItem = computed(() => {
    void tincanban.docVersion.value
    const notes = new Map<string, AttachedDocument[]>()
    for (const entity of Object.values(tincanban.getActiveDoc()?.entities ?? {})) {
      if (entity.kind !== "document" || entity.documentKind !== "note" || entity.archivedAt || !entity.placement.parentId) continue
      const attached = notes.get(entity.placement.parentId) ?? []
      attached.push(entity)
      notes.set(entity.placement.parentId, attached)
    }
    return notes
  })
  const searchableTextByItem = computed(() => {
    void tincanban.docVersion.value
    const doc = tincanban.getActiveDoc()
    if (!doc) return new Map<string, string>()
    const leads = leadsById.value
    const notes = notesByItem.value
    const notesFieldId = textNotesFieldId()
    const searchable = new Map<string, string>()
    for (const entity of Object.values(doc.entities)) {
      if (!isItem(entity)) continue
      const lead = tincanban.isBlankBoard.value ? undefined : leads.get(entity.id)
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
    const id = tincanban.activeBoard.value?.preset?.bindings["field.notes"]
    return id && tincanban.boardFields.value.some(field => field.id === id && field.valueType === "text") ? id : undefined
  }
  const narrativeForCard = computed(() => {
    void tincanban.docVersion.value
    const notes = notesByItem.value
    const leads = leadsById.value
    const notesFieldId = textNotesFieldId()
    return cachedItemProjection(item => itemNarrative(item, leads.has(item.id) ? notesFieldId : undefined, notes.get(item.id) ?? []))
  })
  const fieldsForCard = computed(() => {
    void tincanban.docVersion.value
    const fields = tincanban.boardFields.value
    const bindings = tincanban.activeBoard.value?.preset?.bindings ?? {}
    const leads = leadsById.value
    return cachedItemProjection(item => cardFieldValues(item, fields, bindings, leads.get(item.id)))
  })
  const cardNotes = (item: Item) => narrativeForCard.value(item)
  const cardFields = (item: Item) => fieldsForCard.value(item)
  // Priority depends on workspace data, never on the current search query.
  // Filtering an already ordered column preserves its stable priority order.
  const orderedItemsByColumn = computed(() => {
    const board = tincanban.activeBoard.value
    const notesFieldId = textNotesFieldId()
    return new Map(tincanban.genericColumns.value.map(column => [column.id, orderItemsByPriority(board, column.items, notesFieldId)]))
  })
  const itemsByColumn = computed(() => {
    const query = normalizedSearch.value
    const activeFilters = filters.value
    const searchable = query ? searchableTextByItem.value : null
    return new Map([...orderedItemsByColumn.value].map(([columnId, items]) => [columnId, items.filter(item => {
      const matchesSearch = !query || searchable?.get(item.id)?.includes(query) === true
      return matchesSearch && matchesItemFilters(item, columnId, activeFilters)
    })]))
  })
  const itemsForColumn = (column: { id: string; items: Item[] }) => itemsByColumn.value.get(column.id) ?? []
  const totalItems = computed(() => tincanban.genericColumns.value.reduce((total, column) => total + column.items.length, 0))
  const visibleItems = computed(() => tincanban.genericColumns.value.reduce((total, column) => total + itemsForColumn(column).length, 0))
  const hasFilters = computed(() => Boolean(search.value.trim()) || activeFilterCount(filters.value) > 0)
  const workspacePresenceSummary = computed(() => summarizeWorkspace(totalItems.value, visibleItems.value, tincanban.workspace.documents.length + tincanban.workspace.artifacts.length, core.onlineWorkspaceDevices.value, hasFilters.value))
  const visibleColumns = computed(() => visibleBoardColumns(tincanban.genericColumns.value, hasFilters.value, isEditingBoard.value, filters.value.columnId, itemsForColumn))
  const clearFilters = () => { search.value = ""; filters.value = defaultBoardFilters() }
  let scrolledBoard: HTMLElement | null = null
  let boardScrollLeft = 0
  watch(() => visibleColumns.value.map(column => column.id).join("|"), () => {
    // Capture before Vue patches columns; the scroll event may still be queued.
    scrolledBoard = boardRef.value
    boardScrollLeft = scrolledBoard?.scrollLeft ?? 0
  }, { flush: "pre" })
  const updateMobileColumnIndex = () => {
    scrolledBoard = boardRef.value
    boardScrollLeft = scrolledBoard?.scrollLeft ?? 0
    activeMobileColumnIndex.value = mobileColumnIndex(scrolledBoard)
  }
  const resetBoardScroll = () => {
    // Reading geometry or calling scrollTo after a filter patch forces layout.
    // Scroll events already tell us whether this board needs resetting.
    if (scrolledBoard === boardRef.value && boardScrollLeft !== 0) {
      boardRef.value?.scrollTo({ left: 0, behavior: "instant" })
      boardScrollLeft = 0
    }
  }
  const moveMobileColumn = (direction: -1 | 1) => moveBoardColumn(boardRef.value, visibleColumns.value, activeMobileColumnIndex, direction)
  let highlightTimer: ReturnType<typeof setTimeout> | undefined
  const highlightMoved = (entityId: string, kind: "item" | "column") => {
    if (highlightTimer) clearTimeout(highlightTimer)
    if (kind === "item") movedItemId.value = entityId
    else movedColumnId.value = entityId
    highlightTimer = setTimeout(() => { movedItemId.value = null; movedColumnId.value = null }, 700)
  }
  const clearHighlightTimer = () => { if (highlightTimer) clearTimeout(highlightTimer) }
  return { workspaceLabel, entityName, addItemLabel, itemFormColumns, itemFormParentValue, computedItemFieldIds, itemFormOptionValues, leadForItem, cardNotes, cardFields, columnStatus, itemsForColumn, totalItems, visibleItems, hasFilters, workspacePresenceSummary, visibleColumns, clearFilters, updateMobileColumnIndex, resetBoardScroll, moveMobileColumn, highlightMoved, clearHighlightTimer }
}

function cachedItemProjection<T>(project: (item: Item) => T) {
  // Detail and board can hold different immutable revisions of the same ID.
  const cache = new WeakMap<Item, T>()
  return (item: Item): T => {
    if (!cache.has(item)) cache.set(item, project(item))
    return cache.get(item)!
  }
}

function cardFieldValues(item: Item, fields: ReturnType<typeof useAppCore>["tincanban"]["boardFields"]["value"], bindings: Record<string, string>, lead: unknown) {
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

function visibleBoardColumns(columns: ReturnType<typeof useAppCore>["tincanban"]["genericColumns"]["value"], hasFilters: boolean, isEditing: boolean, selectedColumnId: string | undefined, itemsForColumn: (column: { id: string; items: Item[] }) => Item[]) {
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

function useBoardSelection(core: AppBoardContext) {
  const selectedItem = computed(() => readSelectedItem(core))
  const subitemsForSelectedItem = computed(() => selectedItem.value ? readSubitems(core, selectedItem.value.id) : [])
  const selectedItemHistory = computed(() => {
    void core.tincanban.docVersion.value
    const doc = core.tincanban.getActiveDoc()
    return doc && core.selectedItemId.value ? projectEntityHistory(doc, core.selectedItemId.value) : []
  })
  const editingItem = computed(() => core.editingItemId.value ? readItem(core, core.editingItemId.value) : null)
  const candidateParentsForMove = computed(() => itemParents(core))
  watch(core.selectedLeadId, async leadId => { if (leadId) { await nextTick(); core.detailDialog.value?.focus() } })
  watch([core.selectedLeadId, core.selectedItemId], () => { core.quickNoteDraft.value = ""; core.quickNoteError.value = "" })
  return { selectedItem, subitemsForSelectedItem, selectedItemHistory, editingItem, candidateParentsForMove }
}

function readSelectedItem(core: AppBoardContext) {
  void core.tincanban.docVersion.value
  return core.selectedItemId.value ? readItem(core, core.selectedItemId.value) : null
}

function readItem(core: AppBoardContext, id: string) {
  const entity = core.tincanban.getActiveDoc()?.entities[id]
  return isItem(entity) ? entity : null
}

function readSubitems(core: AppBoardContext, parentId: string) {
  const doc = core.tincanban.getActiveDoc()
  return doc ? Object.values(doc.entities).filter((entity): entity is Item => isItem(entity) && entity.placement.parentId === parentId && !isItemArchived(entity)) : []
}

function itemParents(core: AppBoardContext) {
  const current = core.itemToMove.value
  const doc = core.tincanban.getActiveDoc()
  return current && doc ? Object.values(doc.entities).filter((entity): entity is Item => isItem(entity) && entity.id !== current.id && !isItemArchived(entity)).map(item => ({ id: item.id, title: item.title })) : []
}
