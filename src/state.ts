import { computed, reactive } from "vue"
import { loadWorkspaceRecord, saveWorkspaceRecord, type WorkspaceRecord } from "./storage"
import { initializeAutomerge, loadWorkspaceDoc, mergeWorkspaceDocs, newWorkspaceDoc, saveWorkspaceDoc, updateWorkspaceDoc, workspaceFromDoc, type WorkspaceDoc } from "./crdt"
import type { DocumentInput, Lead, LeadInput, Workspace } from "./types"
import { statusOrder } from "./types"
import { createDocument as createDocumentCommand, createLead as createLeadCommand, deleteDocument as deleteDocumentCommand, deleteLead as deleteLeadCommand, documentsFor as workspaceDocumentsFor, moveLead as moveLeadCommand, updateDocument as updateDocumentCommand, updateLead as updateLeadCommand } from "./domain/workspace"

const workspace = reactive<Workspace>({ leads: [], documents: [] })
const ready = reactive({ value: false })
let document: WorkspaceDoc

function now() {
  return new Date().toISOString()
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`
}

function currentWorkspace(): Workspace {
  return { leads: [...workspace.leads], documents: [...workspace.documents] }
}

async function persist() {
  await saveWorkspaceRecord({
    workspace: {
      leads: JSON.parse(JSON.stringify(workspace.leads)),
      documents: JSON.parse(JSON.stringify(workspace.documents)),
    },
    automergeBytes: saveWorkspaceDoc(document),
  })
}

function applyWorkspace(next: Workspace) {
  workspace.leads.splice(0, workspace.leads.length, ...next.leads)
  workspace.documents.splice(0, workspace.documents.length, ...next.documents)
}

function commit(message: string) {
  document = updateWorkspaceDoc(document, {
    leads: JSON.parse(JSON.stringify(workspace.leads)),
    documents: JSON.parse(JSON.stringify(workspace.documents)),
  }, message)
  void persist()
}

async function mergeRemoteBytes(bytes: Uint8Array) {
  document = mergeWorkspaceDocs(document, loadWorkspaceDoc(bytes))
  applyWorkspace(workspaceFromDoc(document))
  await persist()
}

async function mergeWorkspaceRecord(record: WorkspaceRecord) {
  const imported = record.automergeBytes ? loadWorkspaceDoc(record.automergeBytes) : newWorkspaceDoc(record.workspace)
  document = mergeWorkspaceDocs(document, imported)
  applyWorkspace(workspaceFromDoc(document))
  await persist()
}

export async function hydrate() {
  await initializeAutomerge()
  const saved = await loadWorkspaceRecord()
  document = saved.automergeBytes ? loadWorkspaceDoc(saved.automergeBytes) : newWorkspaceDoc(saved.workspace)
  applyWorkspace(workspaceFromDoc(document))
  ready.value = true
}

export function useMatch() {
  const columns = computed(() => statusOrder.map((status) => ({
    status,
    leads: workspace.leads.filter((lead) => lead.status === status),
  })))

  function createLead(input: LeadInput) {
    const result = createLeadCommand(currentWorkspace(), input, { id, now })
    applyWorkspace(result.workspace)
    commit("Create lead")
    return result.lead
  }

  function updateLead(leadId: string, patch: Partial<LeadInput>) {
    const result = updateLeadCommand(currentWorkspace(), leadId, patch, now())
    if (!result.lead) return
    applyWorkspace(result.workspace)
    commit("Update lead")
  }

  function moveLead(leadId: string, status: Lead["status"]) {
    const result = moveLeadCommand(currentWorkspace(), leadId, status, now())
    if (!result.lead) return
    applyWorkspace(result.workspace)
    commit("Move lead")
  }

  function createDocument(input: DocumentInput) {
    const result = createDocumentCommand(currentWorkspace(), input, { id, now })
    applyWorkspace(result.workspace)
    commit("Attach document")
    return result.document
  }

  function updateDocument(documentId: string, patch: Partial<DocumentInput>) {
    const result = updateDocumentCommand(currentWorkspace(), documentId, patch, now())
    if (!result.document) return
    applyWorkspace(result.workspace)
    commit("Update document")
  }

  function documentsFor(leadId: string) {
    return workspaceDocumentsFor(workspace, leadId)
  }

  function deleteLead(leadId: string) {
    applyWorkspace(deleteLeadCommand(currentWorkspace(), leadId).workspace)
    commit("Delete lead")
  }

  function deleteDocument(documentId: string) {
    applyWorkspace(deleteDocumentCommand(currentWorkspace(), documentId).workspace)
    commit("Delete document")
  }

  return {
    workspace,
    ready,
    columns,
    createLead,
    updateLead,
    moveLead,
    createDocument,
    updateDocument,
    deleteLead,
    deleteDocument,
    documentsFor,
    persist,
    getAutomergeBytes: () => saveWorkspaceDoc(document),
    mergeRemoteBytes,
    mergeWorkspaceRecord,
  }
}
