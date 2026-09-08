import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import type { Workspace } from "./types"

const databaseName = "match"
const storeName = "workspace"
const workspaceKey = "default"
const fallbackKey = "match.workspace"

function emptyWorkspace(): Workspace {
  return { leads: [], documents: [] }
}

export type WorkspaceRecord = {
  workspace: Workspace
  automergeBytes?: Uint8Array
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(storeName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function loadWorkspace(): Promise<Workspace> {
  return (await loadWorkspaceRecord()).workspace
}

export async function loadWorkspaceRecord(): Promise<WorkspaceRecord> {
  if (typeof indexedDB === "undefined") {
    const value = localStorage.getItem(fallbackKey)
    if (!value) return { workspace: emptyWorkspace() }
    const parsed = JSON.parse(value) as WorkspaceRecord | Workspace
    return "workspace" in parsed ? parsed : { workspace: parsed }
  }

  try {
    const database = await openDatabase()
    return await new Promise((resolve, reject) => {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).get(workspaceKey)
      request.onsuccess = () => {
        const value = request.result as WorkspaceRecord | Workspace | undefined
        resolve(value && "workspace" in value ? value : { workspace: value ?? emptyWorkspace() })
      }
      request.onerror = () => reject(request.error)
    })
  } catch {
    const value = localStorage.getItem(fallbackKey)
    if (!value) return { workspace: emptyWorkspace() }
    const parsed = JSON.parse(value) as WorkspaceRecord | Workspace
    return "workspace" in parsed ? parsed : { workspace: parsed }
  }
}

export async function saveWorkspace(workspace: Workspace): Promise<void> {
  return saveWorkspaceRecord({ workspace })
}

export async function saveWorkspaceRecord(record: WorkspaceRecord): Promise<void> {
  if (typeof indexedDB === "undefined") {
    localStorage.setItem(fallbackKey, JSON.stringify(record))
    return
  }

  try {
    const database = await openDatabase()
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(storeName, "readwrite").objectStore(storeName).put(record, workspaceKey)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  } catch {
    localStorage.setItem(fallbackKey, JSON.stringify(record))
  }
}

export function downloadWorkspaceBundle(workspace: Workspace, automergeBytes?: Uint8Array): void {
  const manifest = {
    format: "match",
    version: "0.0.1",
    exportedAt: new Date().toISOString(),
    counts: { leads: workspace.leads.length, documents: workspace.documents.length },
    merge: automergeBytes ? "automerge" : "snapshot",
  }
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "leads.json": strToU8(JSON.stringify(workspace.leads, null, 2)),
    "documents.json": strToU8(JSON.stringify(workspace.documents, null, 2)),
  }
  if (automergeBytes) files["automerge/workspace.bin"] = automergeBytes
  const blob = new Blob([zipSync(files)], { type: "application/vnd.match+zip" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `match-${new Date().toISOString().slice(0, 10)}.match`
  anchor.click()
  URL.revokeObjectURL(url)
}

export async function readWorkspaceBundle(file: File): Promise<WorkspaceRecord> {
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()))
  const leadsFile = archive["leads.json"]
  const documentsFile = archive["documents.json"]
  if (!leadsFile || !documentsFile) throw new Error("Invalid Match bundle")

  const leads = JSON.parse(strFromU8(leadsFile)) as Workspace["leads"]
  const documents = JSON.parse(strFromU8(documentsFile)) as Workspace["documents"]
  const automergeBytes = archive["automerge/workspace.bin"]
  return { workspace: { leads, documents }, automergeBytes }
}

export function downloadWorkspaceJson(workspace: Workspace): void {
  const blob = new Blob([JSON.stringify(workspace, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `match-${new Date().toISOString().slice(0, 10)}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}
