import { computed, reactive } from "vue"
import { loadWorkspaceRecord, saveWorkspaceRecord } from "./storage"
import { initializeAutomerge, loadWorkspaceDoc, mergeWorkspaceDocs, newWorkspaceDoc, saveWorkspaceDoc, updateWorkspaceDoc, workspaceFromDoc, type WorkspaceDoc } from "./crdt"
import type { DocumentInput, Lead, LeadInput, Workspace } from "./types"
import { statusOrder } from "./types"

const workspace = reactive<Workspace>({ leads: [], documents: [] })
const ready = reactive({ value: false })
let document: WorkspaceDoc

function now() {
  return new Date().toISOString()
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`
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
    const timestamp = now()
    const lead: Lead = { ...input, id: id("lead"), createdAt: timestamp, updatedAt: timestamp }
    workspace.leads.unshift(lead)
    commit("Create lead")
    return lead
  }

  function updateLead(leadId: string, patch: Partial<LeadInput>) {
    const lead = workspace.leads.find((item) => item.id === leadId)
    if (!lead) return
    Object.assign(lead, patch, { updatedAt: now() })
    commit("Update lead")
  }

  function moveLead(leadId: string, status: Lead["status"]) {
    updateLead(leadId, { status })
  }

  function createDocument(input: DocumentInput) {
    const timestamp = now()
    const document = { ...input, id: id("doc"), createdAt: timestamp, updatedAt: timestamp }
    workspace.documents.unshift(document)
    commit("Attach document")
    return document
  }

  function updateDocument(documentId: string, patch: Partial<DocumentInput>) {
    const document = workspace.documents.find((item) => item.id === documentId)
    if (!document) return
    Object.assign(document, patch, { updatedAt: now() })
    commit("Update document")
  }

  function documentsFor(leadId: string) {
    return workspace.documents.filter((document) => document.leadId === leadId)
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
    documentsFor,
    persist,
    getAutomergeBytes: () => saveWorkspaceDoc(document),
    mergeRemoteBytes,
  }
}
