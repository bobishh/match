import { computed } from "vue"
import * as Automerge from "@automerge/automerge/slim"
import type { useAppCore } from "./useAppCore"
import type { useAppBoard } from "./useAppBoard"
import { downloadWorkspaceBundle, readWorkspaceBundle } from "../storage"
import { exportWorkspaceBundleV2, readWorkspaceBundleV2 } from "../domain/workspaceBundle"
import { defaultProofStore } from "../domain/proofs"
import type { BoardSchemaDraft } from "../domain/schema"
import type { WorkspaceSettingsDraft } from "../domain/workspaceSettings"
import { isArchiveColumn } from "../domain/archive"
import { isItem, type ChangeProof, type Column, type FieldValue, type Heads, type Item, type WorkspaceDocumentV2 } from "../domain/model"
import type { DocumentInput, LeadStatus } from "../types"

export function useAppActions(core: ReturnType<typeof useAppCore>, board: ReturnType<typeof useAppBoard>) {
  const selection = useLeadSelection(core)
  const content = useContentActions(core, board, selection)
  const boardActions = useBoardActions(core, board)
  const workspace = useWorkspaceActions(core)
  return { ...selection, ...content, ...boardActions, ...workspace }
}

function useLeadSelection(core: ReturnType<typeof useAppCore>) {
  const selectedLead = computed(() => core.match.workspace.leads.find(lead => lead.id === core.selectedLeadId.value) ?? null)
  const selectedLeadItem = computed(() => {
    void core.match.docVersion.value
    const entity = core.selectedLeadId.value ? core.match.getActiveDoc()?.entities[core.selectedLeadId.value] : null
    return isItem(entity) ? entity : null
  })
  const selectedDocuments = computed(() => selectedLead.value ? core.match.documentsFor(selectedLead.value.id) : [])
  const selectedArtifacts = computed(() => selectedLead.value ? core.match.artifactsFor(selectedLead.value.id) : [])
  const availableArtifactTemplates = computed(() => core.match.workspace.templates)
  return { selectedLead, selectedLeadItem, selectedDocuments, selectedArtifacts, availableArtifactTemplates }
}

function useContentActions(core: ReturnType<typeof useAppCore>, board: ReturnType<typeof useAppBoard>, selection: ReturnType<typeof useLeadSelection>) {
  const restoreSelectedItemVersion = async (changeHash: string) => {
    if (!core.selectedItemId.value || core.historyRestoreSaving.value) return
    core.historyRestoreSaving.value = true
    core.historyRestoreError.value = ""
    core.historyRestoreNotice.value = ""
    try {
      await core.match.executeCommandAsync({ kind: "restoreItemVersion", entityId: core.selectedItemId.value, changeHash })
      core.historyRestoreNotice.value = "Version restored"
    } catch (error) {
      core.historyRestoreError.value = `Restore failed: ${messageFrom(error)}`
    } finally { core.historyRestoreSaving.value = false }
  }
  const saveQuickNote = async (item: Item) => {
    const note = core.quickNoteDraft.value.trim()
    if (!note || core.quickNoteSaving.value) return
    core.quickNoteSaving.value = true
    core.quickNoteError.value = ""
    const notesFieldId = core.match.activeBoard.value?.preset?.bindings["field.notes"]
    try {
      await core.match.executeCommandAsync({ kind: "patchItem", entityId: item.id, ...(notesFieldId ? { values: { [notesFieldId]: appendQuickNote(item.values[notesFieldId], note) } } : { body: appendQuickNote(item.body, note) }) })
      core.quickNoteDraft.value = ""
      core.notice.value = "Note added"
    } catch (error) { core.quickNoteError.value = `Note not saved: ${messageFrom(error)}` }
    finally { core.quickNoteSaving.value = false }
  }
  const submitDocument = async (itemId: string, draft: Omit<DocumentInput, "leadId">) => {
    await core.match.createDocumentAsync({ leadId: itemId, ...draft, title: draft.title.trim() })
    core.notice.value = "Document attached"
  }
  const handleSaveTemplate = async (payload: { id?: string; name: string; markdown: string }) => {
    if (payload.id) await core.match.updateTemplateAsync(payload.id, { name: payload.name, markdown: payload.markdown })
    else await core.match.createTemplateAsync({ name: payload.name, markdown: payload.markdown })
    core.notice.value = "Template saved"
  }
  const openArtifactForm = () => {
    core.artifactError.value = ""
    core.artifactDraft.value = { kind: "cv", title: "", templateId: "", pdfPath: "", sourceMarkdownPath: "" }
    core.showArtifactForm.value = true
  }
  const submitArtifact = () => saveArtifact(core, selection.selectedLead.value)
  const setStatus = (status: LeadStatus) => moveItemToStatus(core, board, selection.selectedLead.value, status)
  const handleUpdateRejectionReason = async (reason: string) => {
    if (selection.selectedLead.value) await core.match.updateLeadAsync(selection.selectedLead.value.id, { rejectionReason: reason })
  }
  return { restoreSelectedItemVersion, saveQuickNote, submitDocument, handleSaveTemplate, openArtifactForm, submitArtifact, setStatus, handleUpdateRejectionReason }
}

function appendQuickNote(existing: unknown, note: string) {
  const current = typeof existing === "string" ? existing.trimEnd() : ""
  return current ? `${current}\n\n${note}` : note
}

async function saveArtifact(core: ReturnType<typeof useAppCore>, lead: ReturnType<typeof useLeadSelection>["selectedLead"]["value"]) {
  if (!lead) return
  const artifact = core.artifactDraft.value
  if (!artifact.title.trim() || !artifact.templateId || !artifact.pdfPath.trim()) {
    core.artifactError.value = "Title, base template, and PDF path required"
    return
  }
  if (!core.match.workspace.templates.some(template => template.id === artifact.templateId)) {
    core.artifactError.value = "Choose a base template"
    return
  }
  await core.match.createArtifactAsync({ leadId: lead.id, kind: artifact.kind, title: artifact.title.trim(), templateId: artifact.templateId, pdfPath: artifact.pdfPath.trim(), sourceMarkdownPath: artifact.sourceMarkdownPath.trim() || undefined })
  core.showArtifactForm.value = false
  core.artifactError.value = ""
  core.notice.value = "PDF artifact attached"
}

async function moveItemToStatus(core: ReturnType<typeof useAppCore>, board: ReturnType<typeof useAppBoard>, lead: ReturnType<typeof useLeadSelection>["selectedLead"]["value"], status: LeadStatus) {
  if (!lead) return
  const item = board.selectedItem.value ?? core.match.getActiveDoc()?.entities[lead.id]
  if (!isItem(item)) return
  const target = core.match.genericColumns.value.find(column => board.columnStatus(column.id) === status)
  if (!target) return
  const previous = previousPlacement(core, item)
  try {
    core.archiveError.value = ""
    await core.match.executeCommandAsync({ kind: "moveEntity", entityId: item.id, parentId: target.id, beforeId: null })
    if (isArchiveColumn(target) && previous) {
      core.archiveUndo.value = { workspaceId: core.match.activeWorkspace.id, itemId: item.id, title: item.title, action: "move", ...previous }
      core.notice.value = "Item archived"
    }
  } catch (error) { reportArchiveFailure(core, error) }
}

function previousPlacement(core: ReturnType<typeof useAppCore>, item: Item) {
  const column = core.match.genericColumns.value.find(candidate => candidate.id === item.placement.parentId)
  const index = column?.items.findIndex(candidate => candidate.id === item.id) ?? -1
  return column && index >= 0 ? { parentId: column.id, beforeId: column.items[index + 1]?.id ?? null } : null
}

function useBoardActions(core: ReturnType<typeof useAppCore>, board: ReturnType<typeof useAppBoard>) {
  const openBoardItem = (item: Item) => { if (!core.match.isBlankBoard.value && board.leadForItem(item)) core.selectedLeadId.value = item.id; else handleOpenItem(item) }
  const closeDetail = () => {
    core.selectedLeadId.value = null
    core.selectedItemId.value = null
    core.showArtifactForm.value = false
  }
  const openAddItem = (columnId?: string) => {
    core.storageError.value = ""
    core.itemFormError.value = ""
    core.itemFormParentId.value = columnId ?? initialItemParent(core)
    core.showItemForm.value = true
  }
  const handleSaveItem = (payload: ItemSavePayload) => saveItem(core, board, payload)
  const currentDocHeads = computed(() => { void core.match.docVersion.value; const doc = core.match.getActiveDoc(); return doc ? Automerge.getHeads(doc) : [] })
  const handleApplySchema = (payload: { schema: BoardSchemaDraft; expectedHeads?: Heads }) => applySchema(core, payload)
  const handleApplyWorkspaceSettings = (payload: { settings: WorkspaceSettingsDraft; expectedHeads?: Heads }) => applyWorkspaceSettings(core, payload)
  const handleDeleteItem = (itemId: string) => archiveItem(core, board.selectedItem.value, itemId)
  const undoArchive = () => restoreArchivedItem(core, board.highlightMoved)
  const handleOpenItem = (item: Item) => { core.selectedItemId.value = item.id }
  const handleOpenItemEdit = (item: Item) => openItemEdit(core, item)
  const handleAddSubitem = (parentItemId: string) => { core.itemFormParentId.value = parentItemId; core.itemFormError.value = ""; core.showItemForm.value = true }
  const handleStartMove = (item: Item) => { core.itemToMove.value = item; core.showMoveDialog.value = true }
  const handleConfirmMove = (newParentId: string) => confirmMove(core, newParentId)
  const handleRenameColumn = (newTitle: string) => renameColumn(core, newTitle)
  const handleDeleteColumn = () => deleteColumn(core)
  const addBoardColumn = async () => { await addColumn(core, core.newBoardColumnTitle.value); core.newBoardColumnTitle.value = "" }
  return { openBoardItem, closeDetail, openAddItem, handleSaveItem, currentDocHeads, handleApplySchema, handleApplyWorkspaceSettings, handleDeleteItem, undoArchive, handleOpenItem, handleOpenItemEdit, handleAddSubitem, handleStartMove, handleConfirmMove, handleRenameColumn, handleDeleteColumn, addBoardColumn }
}

type ItemSavePayload = { title: string; body: string; parentId?: string; values: Record<string, FieldValue> }

function initialItemParent(core: ReturnType<typeof useAppCore>) {
  const columns = core.match.genericColumns.value
  if (columns[0]) return columns[0].id
  const doc = core.match.getActiveDoc()
  return doc ? Object.values(doc.entities).find((entity): entity is Column => entity.kind === "column" && !entity.deleted)?.id ?? core.match.activeBoard.value?.id ?? "" : core.match.activeBoard.value?.id ?? ""
}

async function saveItem(core: ReturnType<typeof useAppCore>, board: ReturnType<typeof useAppBoard>, payload: ItemSavePayload) {
  if (core.savingItem.value) return
  core.savingItem.value = true
  try {
    core.storageError.value = ""
    core.itemFormError.value = ""
    const details = itemSaveDetails(core, board, payload)
    if (details.item) await saveExistingItem(core, details.item, details, payload.body)
    else await saveNewItem(core, details, payload.body)
    core.showItemForm.value = false
    core.notice.value = "Item saved"
  } catch (error) {
    core.storageError.value = "Storage failure: Save failed"
    core.itemFormError.value = messageFrom(error)
  } finally { core.savingItem.value = false }
}

function itemSaveDetails(core: ReturnType<typeof useAppCore>, board: ReturnType<typeof useAppBoard>, payload: ItemSavePayload) {
  const values = { ...payload.values }
  const requestedParent = payload.parentId || core.itemFormParentId.value
  const parentId = core.match.genericColumns.value.find(column => column.id === requestedParent || board.columnStatus(column.id) === requestedParent)?.id ?? requestedParent
  const item = board.editingItem.value
  const bindings = core.match.activeBoard.value?.preset?.bindings ?? {}
  const titleParts = [values[bindings["field.company"]], values[bindings["field.role"]]].filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map(value => value.trim())
  return { item, parentId, values, title: core.match.isBlankBoard.value ? payload.title || item?.title || "Untitled item" : titleParts.join(" — ") || item?.title || "Untitled item" }
}

async function saveExistingItem(core: ReturnType<typeof useAppCore>, item: Item, details: ReturnType<typeof itemSaveDetails>, body: string) {
  await core.match.executeCommandAsync({ kind: "patchItem", entityId: item.id, title: details.title, body, values: details.values })
  if (details.parentId && details.parentId !== item.placement.parentId) await core.match.executeCommandAsync({ kind: "moveEntity", entityId: item.id, parentId: details.parentId, beforeId: null })
  core.editingItemId.value = null
  if (!core.match.isBlankBoard.value) core.selectedLeadId.value = item.id
}

async function saveNewItem(core: ReturnType<typeof useAppCore>, details: ReturnType<typeof itemSaveDetails>, body: string) {
  const before = new Set(Object.keys(core.match.getActiveDoc()?.entities ?? {}))
  await core.match.executeCommandAsync({ kind: "createItem", parentId: details.parentId, title: details.title, body, values: details.values })
  if (core.match.isBlankBoard.value) return
  const created = Object.values(core.match.getActiveDoc()?.entities ?? {}).find(entity => isItem(entity) && !before.has(entity.id))
  if (created) core.selectedLeadId.value = created.id
}

async function applySchema(core: ReturnType<typeof useAppCore>, payload: { schema: BoardSchemaDraft; expectedHeads?: Heads }) {
  if (!core.match.activeBoard.value) return
  try {
    await core.match.executeCommandAsync({ kind: "updateBoardSchema", boardId: core.match.activeBoard.value.id, schema: payload.schema, expectedHeads: payload.expectedHeads })
    core.showEntitySettings.value = false
    core.notice.value = "Schema updated"
  } catch (error) { core.notice.value = `Schema update failed: ${messageFrom(error)}` }
}

async function applyWorkspaceSettings(core: ReturnType<typeof useAppCore>, payload: { settings: WorkspaceSettingsDraft; expectedHeads?: Heads }) {
  try {
    await core.match.executeCommandAsync({ kind: "updateWorkspaceSettings", settings: payload.settings, expectedHeads: payload.expectedHeads })
    core.showBoardSettings.value = false
    core.notice.value = "Workspace settings updated"
  } catch (error) { core.notice.value = `Workspace settings failed: ${messageFrom(error)}` }
}

async function archiveItem(core: ReturnType<typeof useAppCore>, item: Item | null, itemId: string) {
  try {
    core.archiveError.value = ""
    await core.match.executeCommandAsync({ kind: "setEntityDeleted", entityId: itemId, deleted: true })
    core.archiveUndo.value = item ? { workspaceId: core.match.activeWorkspace.id, itemId, title: item.title, action: "restore" } : null
    core.selectedItemId.value = null
    core.notice.value = "Item archived"
  } catch (error) { reportArchiveFailure(core, error) }
}

async function restoreArchivedItem(core: ReturnType<typeof useAppCore>, highlightMoved: ReturnType<typeof useAppBoard>["highlightMoved"]) {
  const archived = core.archiveUndo.value
  if (!archived || archived.workspaceId !== core.match.activeWorkspace.id || core.undoSaving.value) return
  core.undoSaving.value = true
  try {
    if (archived.action === "restore") await core.match.executeCommandAsync({ kind: "setEntityDeleted", entityId: archived.itemId, deleted: false })
    else await core.match.executeCommandAsync({ kind: "moveEntity", entityId: archived.itemId, parentId: archived.parentId, beforeId: archived.beforeId })
    core.archiveUndo.value = null
    core.archiveError.value = ""
    core.notice.value = `Restored ${archived.title}`
    highlightMoved(archived.itemId, "item")
  } catch (error) { core.archiveError.value = `Restore failed: ${messageFrom(error)}`; core.notice.value = core.archiveError.value }
  finally { core.undoSaving.value = false }
}

function openItemEdit(core: ReturnType<typeof useAppCore>, item: Item) {
  core.editingItemId.value = item.id
  core.itemFormParentId.value = item.placement.parentId ?? ""
  core.showItemForm.value = true
  core.selectedItemId.value = null
  core.selectedLeadId.value = null
  core.historyRestoreError.value = ""
  core.historyRestoreNotice.value = ""
}

async function confirmMove(core: ReturnType<typeof useAppCore>, newParentId: string) {
  if (!core.itemToMove.value) return
  await core.match.executeCommandAsync({ kind: "moveEntity", entityId: core.itemToMove.value.id, parentId: newParentId, beforeId: null })
  core.showMoveDialog.value = false
  core.itemToMove.value = null
  core.notice.value = "Item moved"
}

async function renameColumn(core: ReturnType<typeof useAppCore>, title: string) {
  if (!core.editingColumn.value) return
  await core.match.executeCommandAsync({ kind: "renameEntity", entityId: core.editingColumn.value.id, title })
  core.editingColumn.value = null
  core.notice.value = "Column renamed"
}

async function deleteColumn(core: ReturnType<typeof useAppCore>) {
  if (!core.editingColumn.value) return
  await core.match.executeCommandAsync({ kind: "setEntityDeleted", entityId: core.editingColumn.value.id, deleted: true })
  core.editingColumn.value = null
  core.notice.value = "Column moved to trash"
}

async function addColumn(core: ReturnType<typeof useAppCore>, title: string) {
  if (!title.trim() || !core.match.activeBoard.value) return
  await core.match.executeCommandAsync({ kind: "createColumn", boardId: core.match.activeBoard.value.id, title: title.trim() })
  core.notice.value = `Column "${title.trim()}" created`
}

function useWorkspaceActions(core: ReturnType<typeof useAppCore>) {
  const reloadPage = () => window.location.reload()
  const exportWorkspace = () => exportActiveWorkspace(core)
  const openImport = () => core.importInput.value?.click()
  const importWorkspace = (event: Event) => importWorkspaceFile(core, event)
  const createAndSyncWorkspace = (title: string, preset: "blank" | "job-search") =>
    createWorkspaceWithOwnerCredential(core, title, preset)
  const handleCreateWorkspace = async (payload: { title: string; preset: "blank" | "job-search" }) => {
    const doc = await core.match.createWorkspaceAsync(payload.title, payload.preset)
    core.notice.value = `Workspace "${payload.title}" created`
    core.showWorkspaces.value = false
    try { await core.sync.addOwnerWorkspace(doc.id) }
    catch (error) { core.notice.value = `Workspace created; sync setup failed: ${messageFrom(error)}` }
  }
  const handleSwitchWorkspace = async (id: string) => { await core.match.switchWorkspace(id); core.notice.value = "Switched workspace" }
  const handleRenameWorkspace = async (payload: { id: string; title: string }) => { await core.match.renameWorkspaceAsync(payload.id, payload.title); core.notice.value = `Workspace renamed to "${payload.title}"` }
  const handleDeleteWorkspace = async (id: string) => {
    await core.sync.leaveWorkspace(id)
    await core.match.deleteWorkspaceAsync(id)
    core.notice.value = "Workspace deleted"
  }
  return { reloadPage, exportWorkspace, openImport, importWorkspace, createAndSyncWorkspace, handleCreateWorkspace, handleSwitchWorkspace, handleRenameWorkspace, handleDeleteWorkspace }
}

async function createWorkspaceWithOwnerCredential(core: ReturnType<typeof useAppCore>, title: string,
  preset: "blank" | "job-search") {
  const doc = await core.match.createWorkspaceAsync(title, preset)
  await core.sync.addOwnerWorkspace(doc.id)
  return doc
}

async function exportActiveWorkspace(core: ReturnType<typeof useAppCore>) {
  const doc = core.match.getActiveDoc()
  if (!doc) {
    downloadWorkspaceBundle(core.match.workspace, core.match.getAutomergeBytes())
    core.notice.value = "Match bundle exported"
    return
  }
  const bundle = await exportWorkspaceBundleV2(doc, await defaultProofStore.listChangeProofs())
  downloadBundle(bundle, doc.title)
  core.notice.value = "Match bundle exported"
}

function downloadBundle(bytes: Uint8Array, title: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.match+zip" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `${title.toLowerCase().replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.match`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2_000)
}

async function importWorkspaceFile(core: ReturnType<typeof useAppCore>, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ""
  if (!file) return
  if (!core.canImportWorkspace.value) { core.notice.value = "Only the owner can import into this workspace"; return }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const bundle = await readWorkspaceBundleV2(bytes)
    if (bundle.ok) await importVersion2Bundle(core, bundle.value)
    else await core.match.mergeWorkspaceRecord(await readWorkspaceBundle(file))
    core.notice.value = bundle.ok ? "Match bundle imported" : "Match bundle merged"
  } catch (error) { core.notice.value = error instanceof Error ? error.message : "Match bundle import failed" }
}

type Version2Bundle = { doc: WorkspaceDocumentV2; proofs: ChangeProof[] }

async function importVersion2Bundle(core: ReturnType<typeof useAppCore>, bundle: Version2Bundle) {
  await core.match.importWorkspaceDocument(bundle.doc)
  for (const proof of bundle.proofs) if (proof?.payload?.changeHash) await defaultProofStore.putChangeProof(proof.payload.changeHash, proof)
}

function reportArchiveFailure(core: ReturnType<typeof useAppCore>, error: unknown) {
  core.archiveError.value = `Archive failed: ${messageFrom(error)}`
  core.notice.value = core.archiveError.value
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : "try again"
}
