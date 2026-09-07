import * as Automerge from "@automerge/automerge/slim"
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64"
import type { Document, Lead, Workspace } from "./types"

let automergeReady: Promise<void> | undefined

export function initializeAutomerge(): Promise<void> {
  return (automergeReady ??= Automerge.initializeBase64Wasm(automergeWasmBase64))
}

export type WorkspaceDocument = {
  leads: Lead[]
  documents: Document[]
}

export type WorkspaceDoc = Automerge.Doc<WorkspaceDocument>

export function newWorkspaceDoc(workspace: Workspace): WorkspaceDoc {
  let doc = Automerge.init<WorkspaceDocument>()
  doc = Automerge.change(doc, { message: "Create Match workspace" }, (draft) => {
    draft.leads = clone(workspace.leads)
    draft.documents = clone(workspace.documents)
  })
  return doc
}

export function updateWorkspaceDoc(doc: WorkspaceDoc, workspace: Workspace, message: string): WorkspaceDoc {
  return Automerge.change(doc, { message }, (draft) => {
    draft.leads = clone(workspace.leads)
    draft.documents = clone(workspace.documents)
  })
}

export function loadWorkspaceDoc(bytes: Uint8Array): WorkspaceDoc {
  return Automerge.load<WorkspaceDocument>(bytes)
}

export function saveWorkspaceDoc(doc: WorkspaceDoc): Uint8Array {
  return Automerge.save(doc)
}

export function workspaceFromDoc(doc: WorkspaceDoc): Workspace {
  return {
    leads: clone(doc.leads),
    documents: clone(doc.documents),
  }
}

export function mergeWorkspaceDocs(local: WorkspaceDoc, remote: WorkspaceDoc): WorkspaceDoc {
  return Automerge.merge(local, remote)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
