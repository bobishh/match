import * as Automerge from "@automerge/automerge/slim"
import automergeWasmUrl from "@automerge/automerge/automerge.wasm?url"
import { normalizeWorkspace, type Artifact, type Document, type Lead, type Template, type Workspace } from "./types"

let automergeReady: Promise<void> | undefined

export function initializeAutomerge(): Promise<void> {
  return (automergeReady ??= Automerge.initializeWasm(automergeWasmUrl))
}

export type WorkspaceDocument = {
  leads: Lead[]
  documents: Document[]
  templates: Template[]
  artifacts: Artifact[]
}

export type WorkspaceDoc = Automerge.Doc<WorkspaceDocument>

export function newWorkspaceDoc(workspace: Workspace): WorkspaceDoc {
  let doc = Automerge.init<WorkspaceDocument>()
  doc = Automerge.change(doc, { message: "Create Match workspace" }, (draft) => {
    draft.leads = clone(workspace.leads)
    draft.documents = clone(workspace.documents)
    draft.templates = clone(workspace.templates)
    draft.artifacts = clone(workspace.artifacts)
  })
  return doc
}

export function updateWorkspaceDoc(doc: WorkspaceDoc, workspace: Workspace, message: string): WorkspaceDoc {
  return Automerge.change(doc, { message }, (draft) => {
    draft.leads = clone(workspace.leads)
    draft.documents = clone(workspace.documents)
    draft.templates = clone(workspace.templates)
    draft.artifacts = clone(workspace.artifacts)
  })
}

export function loadWorkspaceDoc(bytes: Uint8Array): WorkspaceDoc {
  return Automerge.load<WorkspaceDocument>(bytes)
}

export function saveWorkspaceDoc(doc: WorkspaceDoc): Uint8Array {
  return Automerge.save(doc)
}

export function workspaceHeads(doc: WorkspaceDoc): string[] {
  return Automerge.getHeads(doc).sort()
}

export function workspaceFromDoc(doc: WorkspaceDoc): Workspace {
  return normalizeWorkspace({
    leads: clone(doc.leads),
    documents: clone(doc.documents),
    templates: clone(doc.templates ?? []),
    artifacts: clone(doc.artifacts ?? []),
  })
}

export function mergeWorkspaceDocs(local: WorkspaceDoc, remote: WorkspaceDoc): WorkspaceDoc {
  // Automerge freezes both merge arguments. The current local document must stay
  // writable when a no-op reconciliation keeps it instead of the merge result.
  return Automerge.merge(Automerge.clone(local), remote)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
