import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import * as Automerge from "@automerge/automerge/slim"
import { normalizeWorkspace, type Workspace } from "./types"
import { bootstrapIdentity } from "./domain/identity"
import type {
  TransactionReceipt,
  ChangeProof,
  WorkspaceDocumentV2,
  PersonalRootDocumentV1,
  Heads,
} from "./domain/model"
import type { StoredProofsV1 } from "./domain/proofs"

export type StoredChange = {
  workspaceId: string
  changeHash: string
  bytes: Uint8Array
  addedAt: string
}

export type StoredSnapshot = {
  workspaceId: string
  heads: Heads
  bytes: Uint8Array
  savedAt: string
}

let testStorageFailureHook = false

export function setStorageFailureHookForTest(active: boolean) {
  testStorageFailureHook = active
}

function checkStorageFailureHook() {
  if (testStorageFailureHook) {
    throw new Error("Storage failure injected")
  }
  if (typeof window !== "undefined" && (window as any).__MATCH_INJECT_STORAGE_FAILURE__) {
    throw new Error("Storage failure injected")
  }
}

// In-memory backing store for tests or environments without IndexedDB
type InMemoryStore = {
  changes: Map<string, StoredChange> // key: `${workspaceId}:${changeHash}`
  proofs: Map<string, ChangeProof> // key: `${workspaceId}:${changeHash}`
  receipts: Map<string, TransactionReceipt> // key: `${workspaceId}:${transactionId}`
  snapshots: Map<string, StoredSnapshot> // key: workspaceId
  workspaces: Map<string, { id: string; title: string; updatedAt: string }>
  personalRoots: Map<string, PersonalRootDocumentV1>
}

const memoryStore: InMemoryStore = {
  changes: new Map(),
  proofs: new Map(),
  receipts: new Map(),
  snapshots: new Map(),
  workspaces: new Map(),
  personalRoots: new Map(),
}

import { toBase64Url, fromBase64Url } from "./domain/identity"

const persistentStorageBacking = new Map<string, string>()

function getStorageRaw(key: string): string | null {
  if (typeof localStorage !== "undefined") {
    try {
      return localStorage.getItem(key)
    } catch {}
  }
  return persistentStorageBacking.get(key) ?? null
}

function setStorageRaw(key: string, value: string): void {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(key, value)
    } catch {}
  }
  persistentStorageBacking.set(key, value)
}

function removeStorageRaw(key: string): void {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(key)
    } catch {}
  }
  persistentStorageBacking.delete(key)
}

export class WorkspaceStorage {
  private inMemory: InMemoryStore

  constructor(store = memoryStore) {
    this.inMemory = store
  }

  async listWorkspaces(): Promise<{ id: string; title: string; updatedAt: string }[]> {
    const raw = getStorageRaw("match.workspaces")
    if (raw) {
      try {
        const list = JSON.parse(raw) as { id: string; title: string; updatedAt: string }[]
        for (const item of list) {
          this.inMemory.workspaces.set(item.id, item)
        }
      } catch {}
    }
    return Array.from(this.inMemory.workspaces.values())
  }

  async registerWorkspace(id: string, title: string): Promise<void> {
    const meta = { id, title, updatedAt: new Date().toISOString() }
    this.inMemory.workspaces.set(id, meta)
    const list = Array.from(this.inMemory.workspaces.values())
    setStorageRaw("match.workspaces", JSON.stringify(list))
  }

  async rekeyWorkspace(oldId: string, newId: string, newTitle: string): Promise<Automerge.Doc<WorkspaceDocumentV2>> {
    checkStorageFailureHook()
    if (oldId === newId) throw new Error("Workspace IDs must differ")
    if (await this.loadWorkspaceDoc(newId)) throw new Error(`Workspace ${newId} already exists`)
    const loaded = await this.loadWorkspaceDoc(oldId)
    if (!loaded) throw new Error(`Workspace ${oldId} not found`)

    const moved = Automerge.change(Automerge.clone(loaded.doc), draft => {
      draft.id = newId
      draft.title = newTitle
    })
    // Save the recoverable copy first. Old keys are removed only after that succeeds.
    await this.saveSnapshot(newId, moved, Automerge.save(moved))

    this.inMemory.snapshots.delete(oldId)
    this.inMemory.workspaces.delete(oldId)
    for (const map of [this.inMemory.changes, this.inMemory.proofs, this.inMemory.receipts]) {
      for (const key of map.keys()) {
        if (key.startsWith(`${oldId}:`)) map.delete(key)
      }
    }
    for (const prefix of ["match.snapshot.", "match.v1.changes.", "match.v1.proofs.", "match.v1.receipts."]) {
      removeStorageRaw(`${prefix}${oldId}`)
    }
    setStorageRaw("match.workspaces", JSON.stringify(Array.from(this.inMemory.workspaces.values())))
    return moved
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    checkStorageFailureHook()
    this.inMemory.snapshots.delete(workspaceId)
    this.inMemory.workspaces.delete(workspaceId)
    for (const map of [this.inMemory.changes, this.inMemory.proofs, this.inMemory.receipts]) {
      for (const key of map.keys()) {
        if (key.startsWith(`${workspaceId}:`)) map.delete(key)
      }
    }
    for (const prefix of ["match.snapshot.", "match.v1.changes.", "match.v1.proofs.", "match.v1.receipts."]) {
      removeStorageRaw(`${prefix}${workspaceId}`)
    }
    setStorageRaw("match.workspaces", JSON.stringify(Array.from(this.inMemory.workspaces.values())))
  }

  async commitTransaction(
    workspaceId: string,
    receipt: TransactionReceipt,
    changeBytes: Uint8Array,
    proof: ChangeProof
  ): Promise<TransactionReceipt> {
    checkStorageFailureHook()

    // Idempotent retry: check if receipt already stored
    const existing = await this.getReceipt(workspaceId, receipt.transactionId)
    if (existing) {
      return existing
    }

    const receiptKey = `${workspaceId}:${receipt.transactionId}`
    const changeKey = `${workspaceId}:${receipt.changeHash}`
    const nowIso = new Date().toISOString()

    const storedChange: StoredChange = {
      workspaceId,
      changeHash: receipt.changeHash,
      bytes: new Uint8Array(changeBytes),
      addedAt: nowIso,
    }

    this.inMemory.changes.set(changeKey, storedChange)
    this.inMemory.proofs.set(changeKey, proof)
    this.inMemory.receipts.set(receiptKey, receipt)

    // Persist changes list
    const changes = await this.listChanges(workspaceId)
    const serializedChanges = changes.map((c) => ({
      workspaceId: c.workspaceId,
      changeHash: c.changeHash,
      bytesBase64: toBase64Url(c.bytes),
      addedAt: c.addedAt,
    }))
    setStorageRaw(`match.v1.changes.${workspaceId}`, JSON.stringify(serializedChanges))

    // Persist proofs
    const proofsRaw = getStorageRaw(`match.v1.proofs.${workspaceId}`)
    const proofsMap: Record<string, ChangeProof> = proofsRaw ? JSON.parse(proofsRaw) : {}
    proofsMap[receipt.changeHash] = proof
    setStorageRaw(`match.v1.proofs.${workspaceId}`, JSON.stringify(proofsMap))

    // Persist receipts
    const receiptsRaw = getStorageRaw(`match.v1.receipts.${workspaceId}`)
    const receiptsMap: Record<string, TransactionReceipt> = receiptsRaw ? JSON.parse(receiptsRaw) : {}
    receiptsMap[receipt.transactionId] = receipt
    setStorageRaw(`match.v1.receipts.${workspaceId}`, JSON.stringify(receiptsMap))

    return receipt
  }

  async saveSnapshot(
    workspaceId: string,
    doc: Automerge.Doc<WorkspaceDocumentV2>,
    bytes: Uint8Array
  ): Promise<void> {
    checkStorageFailureHook()
    const heads = Automerge.getHeads(doc).sort()
    const snapshot = {
      workspaceId,
      heads,
      bytes: new Uint8Array(bytes),
      savedAt: new Date().toISOString(),
    }
    this.inMemory.snapshots.set(workspaceId, snapshot)

    await this.registerWorkspace(workspaceId, doc.title)

    setStorageRaw(
      `match.snapshot.${workspaceId}`,
      JSON.stringify({ heads, bytesBase64: toBase64Url(bytes), savedAt: snapshot.savedAt })
    )
  }

  async loadWorkspaceDoc(
    workspaceId: string
  ): Promise<{ doc: Automerge.Doc<WorkspaceDocumentV2>; heads: Heads } | null> {
    let snapshot: { workspaceId: string; heads: Heads; bytes: Uint8Array; savedAt: string } | null = null
    const rawSnapshot = getStorageRaw(`match.snapshot.${workspaceId}`)
    if (rawSnapshot) {
      try {
        const parsed = JSON.parse(rawSnapshot)
        const byteArr = parsed.bytesBase64
          ? fromBase64Url(parsed.bytesBase64)
          : new Uint8Array(parsed)
        snapshot = {
          workspaceId,
          heads: parsed.heads || [],
          bytes: byteArr,
          savedAt: parsed.savedAt || new Date().toISOString(),
        }
        this.inMemory.snapshots.set(workspaceId, snapshot)
      } catch {}
    }

    if (!snapshot) {
      snapshot = this.inMemory.snapshots.get(workspaceId) ?? null
    }

    let doc: Automerge.Doc<WorkspaceDocumentV2>

    if (snapshot) {
      doc = Automerge.load<WorkspaceDocumentV2>(snapshot.bytes)
    } else {
      doc = Automerge.init<WorkspaceDocumentV2>()
    }

    const changes = await this.listChanges(workspaceId)
    if (changes.length > 0) {
      const changeByteArrays = changes.map((c) => c.bytes)
      try {
        const [updatedDoc] = Automerge.applyChanges(doc, changeByteArrays)
        doc = updatedDoc
      } catch {
        // If some changes were already present, apply individual
        for (const bytes of changeByteArrays) {
          try {
            const [next] = Automerge.applyChanges(doc, [bytes])
            doc = next
          } catch {
            // Already applied or dependent
          }
        }
      }
    }

    const heads = Automerge.getHeads(doc).sort()
    if (!snapshot && changes.length === 0) {
      return null
    }

    return { doc, heads }
  }

  async compactWorkspace(
    workspaceId: string,
    doc: Automerge.Doc<WorkspaceDocumentV2>
  ): Promise<void> {
    checkStorageFailureHook()
    const snapshotBytes = Automerge.save(doc)
    await this.saveSnapshot(workspaceId, doc, snapshotBytes)

    // Identify which changes are included in doc
    const includedChanges = Automerge.getAllChanges(doc)
    const includedHashes = new Set<string>()
    for (const changeBytes of includedChanges) {
      const decoded = Automerge.decodeChange(changeBytes)
      includedHashes.add(decoded.hash)
    }

    // Delete ONLY changes that are included in doc
    const prefix = `${workspaceId}:`
    for (const [key, change] of this.inMemory.changes.entries()) {
      if (key.startsWith(prefix)) {
        if (includedHashes.has(change.changeHash)) {
          this.inMemory.changes.delete(key)
        }
      }
    }

    const remaining = await this.listChanges(workspaceId)
    const serializedRemaining = remaining
      .filter((c) => !includedHashes.has(c.changeHash))
      .map((c) => ({
        workspaceId: c.workspaceId,
        changeHash: c.changeHash,
        bytesBase64: toBase64Url(c.bytes),
        addedAt: c.addedAt,
      }))
    setStorageRaw(`match.v1.changes.${workspaceId}`, JSON.stringify(serializedRemaining))
  }

  async listChanges(workspaceId: string): Promise<StoredChange[]> {
    const raw = getStorageRaw(`match.v1.changes.${workspaceId}`)
    if (raw) {
      try {
        const list = JSON.parse(raw) as { workspaceId: string; changeHash: string; bytesBase64: string; addedAt: string }[]
        for (const item of list) {
          const key = `${workspaceId}:${item.changeHash}`
          if (!this.inMemory.changes.has(key)) {
            this.inMemory.changes.set(key, {
              workspaceId: item.workspaceId,
              changeHash: item.changeHash,
              bytes: fromBase64Url(item.bytesBase64),
              addedAt: item.addedAt,
            })
          }
        }
      } catch {}
    }

    const prefix = `${workspaceId}:`
    const results: StoredChange[] = []
    for (const [key, val] of this.inMemory.changes.entries()) {
      if (key.startsWith(prefix)) {
        results.push(val)
      }
    }
    return results
  }

  async getReceipt(workspaceId: string, transactionId: string): Promise<TransactionReceipt | null> {
    const key = `${workspaceId}:${transactionId}`
    if (this.inMemory.receipts.has(key)) {
      return this.inMemory.receipts.get(key) || null
    }
    const raw = getStorageRaw(`match.v1.receipts.${workspaceId}`)
    if (raw) {
      try {
        const map = JSON.parse(raw)
        if (map[transactionId]) {
          this.inMemory.receipts.set(key, map[transactionId])
          return map[transactionId]
        }
      } catch {}
    }
    return null
  }

  async getProof(workspaceId: string, changeHash: string): Promise<ChangeProof | null> {
    const key = `${workspaceId}:${changeHash}`
    if (this.inMemory.proofs.has(key)) {
      return this.inMemory.proofs.get(key) || null
    }
    const raw = getStorageRaw(`match.v1.proofs.${workspaceId}`)
    if (raw) {
      try {
        const map = JSON.parse(raw)
        if (map[changeHash]) {
          this.inMemory.proofs.set(key, map[changeHash])
          return map[changeHash]
        }
      } catch {}
    }
    return null
  }

  async getProofs(workspaceId: string): Promise<StoredProofsV1> {
    // Ensure all proofs for workspaceId are loaded
    await this.listChanges(workspaceId)
    const raw = getStorageRaw(`match.v1.proofs.${workspaceId}`)
    if (raw) {
      try {
        const map = JSON.parse(raw)
        for (const [hash, proof] of Object.entries(map)) {
          this.inMemory.proofs.set(`${workspaceId}:${hash}`, proof as ChangeProof)
        }
      } catch {}
    }

    const changeProofs = Array.from(this.inMemory.proofs.entries())
      .filter(([k]) => k.startsWith(`${workspaceId}:`))
      .map(([_, v]) => v)

    return {
      grants: [],
      certificates: [],
      actorBindings: [],
      changeProofs,
    }
  }

  async savePersonalRoot(root: PersonalRootDocumentV1): Promise<void> {
    checkStorageFailureHook()
    this.inMemory.personalRoots.set(root.rootId, JSON.parse(JSON.stringify(root)))
    const raw = getStorageRaw("match.v1.personal_roots")
    const map: Record<string, PersonalRootDocumentV1> = raw ? JSON.parse(raw) : {}
    map[root.rootId] = JSON.parse(JSON.stringify(root))
    setStorageRaw("match.v1.personal_roots", JSON.stringify(map))
  }

  async loadPersonalRoot(rootId?: string): Promise<PersonalRootDocumentV1 | null> {
    const raw = getStorageRaw("match.v1.personal_roots")
    if (raw) {
      try {
        const map = JSON.parse(raw)
        for (const [id, root] of Object.entries(map)) {
          this.inMemory.personalRoots.set(id, root as PersonalRootDocumentV1)
        }
      } catch {}
    }

    if (rootId) {
      const found = this.inMemory.personalRoots.get(rootId)
      return found ? JSON.parse(JSON.stringify(found)) : null
    }
    const personId = (await bootstrapIdentity()).identity.personId
    const current = [...this.inMemory.personalRoots.values()].find(root => root.identity.personId === personId)
    return current ? JSON.parse(JSON.stringify(current)) : null
  }
}

export const defaultStorage = new WorkspaceStorage()

// --- Backward compatibility helpers for v0 Match legacy code ---

const databaseName = "match"
const storeName = "workspace"
const workspaceKey = "default"
const fallbackKey = "match.workspace"

export function emptyWorkspace(): Workspace {
  return { leads: [], documents: [], templates: [], artifacts: [] }
}

export type WorkspaceRecord = {
  workspace: Workspace
  automergeBytes?: Uint8Array
}

export function normalizeRecord(value: WorkspaceRecord | Workspace | undefined): WorkspaceRecord {
  if (!value) return { workspace: emptyWorkspace() }
  if ("workspace" in value) return { workspace: normalizeWorkspace(value.workspace), automergeBytes: value.automergeBytes }
  return { workspace: normalizeWorkspace(value) }
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
    const value = typeof localStorage !== "undefined" ? localStorage.getItem(fallbackKey) : null
    if (!value) return { workspace: emptyWorkspace() }
    const parsed = JSON.parse(value) as WorkspaceRecord | Workspace
    return normalizeRecord(parsed)
  }

  try {
    const database = await openDatabase()
    return await new Promise((resolve, reject) => {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).get(workspaceKey)
      request.onsuccess = () => {
        const value = request.result as WorkspaceRecord | Workspace | undefined
        resolve(normalizeRecord(value))
      }
      request.onerror = () => reject(request.error)
    })
  } catch {
    const value = typeof localStorage !== "undefined" ? localStorage.getItem(fallbackKey) : null
    if (!value) return { workspace: emptyWorkspace() }
    const parsed = JSON.parse(value) as WorkspaceRecord | Workspace
    return normalizeRecord(parsed)
  }
}

export async function saveWorkspace(workspace: Workspace): Promise<void> {
  return saveWorkspaceRecord({ workspace })
}

export async function saveWorkspaceRecord(record: WorkspaceRecord): Promise<void> {
  if (typeof indexedDB === "undefined") {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(fallbackKey, JSON.stringify(record))
    }
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
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(fallbackKey, JSON.stringify(record))
    }
  }
}

export function downloadWorkspaceBundle(workspace: Workspace, automergeBytes?: Uint8Array): void {
  const manifest = {
    format: "match",
    version: "0.0.1",
    exportedAt: new Date().toISOString(),
    counts: { leads: workspace.leads.length, documents: workspace.documents.length, templates: workspace.templates.length, artifacts: workspace.artifacts.length },
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
  const templates = archive["templates.json"] ? JSON.parse(strFromU8(archive["templates.json"])) as Workspace["templates"] : []
  const artifacts = archive["artifacts.json"] ? JSON.parse(strFromU8(archive["artifacts.json"])) as Workspace["artifacts"] : []
  const automergeBytes = archive["automerge/workspace.bin"]
  return { workspace: { leads, documents, templates, artifacts }, automergeBytes }
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

export function createWorkspaceBundleV2(
  workspaceId: string,
  heads: string[],
  automergeBytes: Uint8Array,
  proofs: StoredProofsV1,
  workspaceSnapshot?: any
): Uint8Array {
  const manifest = {
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

  if (workspaceSnapshot) {
    files["workspace.json"] = strToU8(JSON.stringify(workspaceSnapshot, null, 2))
  }

  return zipSync(files)
}

export function readWorkspaceBundleV2(bytes: Uint8Array): {
  manifest: any
  automergeBytes: Uint8Array
  proofs: StoredProofsV1
  workspaceSnapshot?: any
} {
  const files = unzipSync(bytes)
  const manifestBytes = files["manifest.json"]
  const automergeBytes = files["workspace.automerge"]
  const proofsBytes = files["proofs.json"]
  if (!manifestBytes || !automergeBytes) {
    throw new Error("Invalid v2 workspace bundle: missing manifest or automerge file")
  }
  const manifest = JSON.parse(strFromU8(manifestBytes))
  const proofs: StoredProofsV1 = proofsBytes
    ? JSON.parse(strFromU8(proofsBytes))
    : { grants: [], certificates: [], actorBindings: [], changeProofs: [] }
  const snapshotBytes = files["workspace.json"]
  const workspaceSnapshot = snapshotBytes ? JSON.parse(strFromU8(snapshotBytes)) : undefined

  return {
    manifest,
    automergeBytes,
    proofs,
    workspaceSnapshot,
  }
}
