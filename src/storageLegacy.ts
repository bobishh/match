import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import type { Workspace } from "./types"
import type { StoredProofsV1 } from "./domain/proofs"

const databaseName = "match"
const storeName = "workspace"
const workspaceKey = "default"
const fallbackKey = "match.workspace"

export type WorkspaceRecord = {
  workspace: Workspace
  automergeBytes?: Uint8Array
}

type WorkspaceBundleManifestV2 = {
  format: "match"
  version: 2
  workspaceId: string
  heads: string[]
  includedBlobHashes: string[]
  missingBlobHashes: string[]
  proofFormatVersion: 1
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type WorkspaceBundleV2 = {
  manifest: WorkspaceBundleManifestV2
  automergeBytes: Uint8Array
  proofs: StoredProofsV1
  workspaceSnapshot?: JsonValue
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function saveWorkspace(workspace: Workspace): Promise<void> {
  return saveWorkspaceRecord({ workspace })
}

export async function saveWorkspaceRecord(record: WorkspaceRecord): Promise<void> {
  if (typeof indexedDB === "undefined") {
    saveWorkspaceFallback(record)
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
    saveWorkspaceFallback(record)
  }
}

function saveWorkspaceFallback(record: WorkspaceRecord): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(fallbackKey, JSON.stringify(record))
}

export function downloadWorkspaceBundle(workspace: Workspace, automergeBytes?: Uint8Array): void {
  const manifest = {
    format: "match",
    version: "0.0.1",
    exportedAt: new Date().toISOString(),
    counts: {
      leads: workspace.leads.length,
      documents: workspace.documents.length,
      templates: workspace.templates.length,
      artifacts: workspace.artifacts.length,
    },
    merge: automergeBytes ? "automerge" : "snapshot",
  }
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "leads.json": strToU8(JSON.stringify(workspace.leads, null, 2)),
    "documents.json": strToU8(JSON.stringify(workspace.documents, null, 2)),
    "templates.json": strToU8(JSON.stringify(workspace.templates, null, 2)),
    "artifacts.json": strToU8(JSON.stringify(workspace.artifacts, null, 2)),
  }
  if (automergeBytes) files["automerge/workspace.bin"] = automergeBytes
  downloadBlob(new Blob([zipSync(files)], { type: "application/vnd.match+zip" }), "match")
}

function downloadBlob(blob: Blob, extension: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `match-${new Date().toISOString().slice(0, 10)}.${extension}`
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
  const templates = archive["templates.json"] ? JSON.parse(strFromU8(archive["templates.json"])) as Workspace["templates"] : []
  const artifacts = archive["artifacts.json"] ? JSON.parse(strFromU8(archive["artifacts.json"])) as Workspace["artifacts"] : []
  return { workspace: { leads, documents, templates, artifacts }, automergeBytes: archive["automerge/workspace.bin"] }
}

export function createWorkspaceBundleV2(
  workspaceId: string,
  heads: string[],
  automergeBytes: Uint8Array,
  proofs: StoredProofsV1,
  workspaceSnapshot?: JsonValue
): Uint8Array {
  const manifest: WorkspaceBundleManifestV2 = {
    format: "match",
    version: 2,
    workspaceId,
    heads,
    includedBlobHashes: [],
    missingBlobHashes: [],
    proofFormatVersion: 1,
  }
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "workspace.automerge": automergeBytes,
    "proofs.json": strToU8(JSON.stringify(proofs, null, 2)),
  }
  if (workspaceSnapshot) files["workspace.json"] = strToU8(JSON.stringify(workspaceSnapshot, null, 2))
  return zipSync(files)
}

export function readWorkspaceBundleV2(bytes: Uint8Array): WorkspaceBundleV2 {
  const files = unzipSync(bytes)
  const manifestBytes = files["manifest.json"]
  const automergeBytes = files["workspace.automerge"]
  const proofsBytes = files["proofs.json"]
  if (!manifestBytes || !automergeBytes) {
    throw new Error("Invalid v2 workspace bundle: missing manifest or automerge file")
  }
  const manifestValue: unknown = JSON.parse(strFromU8(manifestBytes))
  if (!isWorkspaceBundleManifest(manifestValue)) throw new Error("Invalid v2 workspace bundle manifest")
  const proofsValue: unknown = proofsBytes ? JSON.parse(strFromU8(proofsBytes)) : emptyProofs()
  if (!isStoredProofs(proofsValue)) throw new Error("Invalid v2 workspace bundle proofs")
  const snapshotBytes = files["workspace.json"]
  const snapshotValue: unknown = snapshotBytes ? JSON.parse(strFromU8(snapshotBytes)) : undefined
  if (snapshotValue !== undefined && !isJsonValue(snapshotValue)) {
    throw new Error("Invalid v2 workspace bundle snapshot")
  }
  return {
    manifest: manifestValue,
    automergeBytes,
    proofs: proofsValue,
    workspaceSnapshot: snapshotValue,
  }
}

function isWorkspaceBundleManifest(value: unknown): value is WorkspaceBundleManifestV2 {
  if (!value || typeof value !== "object") return false
  const manifest = value as Record<string, unknown>
  return manifest.format === "match" && manifest.version === 2 && typeof manifest.workspaceId === "string" &&
    Array.isArray(manifest.heads) && manifest.heads.every((head) => typeof head === "string") &&
    Array.isArray(manifest.includedBlobHashes) && Array.isArray(manifest.missingBlobHashes) &&
    manifest.proofFormatVersion === 1
}

function emptyProofs(): StoredProofsV1 {
  return { grants: [], certificates: [], actorBindings: [], changeProofs: [] }
}

function isStoredProofs(value: unknown): value is StoredProofsV1 {
  if (!value || typeof value !== "object") return false
  const proofs = value as Record<string, unknown>
  return Array.isArray(proofs.grants) && Array.isArray(proofs.certificates) &&
    Array.isArray(proofs.actorBindings) && Array.isArray(proofs.changeProofs)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== "object") return false
  return Object.values(value as Record<string, unknown>).every(isJsonValue)
}
