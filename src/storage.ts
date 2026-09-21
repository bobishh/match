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
  if (typeof localStorage !== "undefined") localStorage.setItem(key, value)
  else persistentStorageBacking.set(key, value)
}

function removeStorageRaw(key: string): void {
  if (typeof localStorage !== "undefined") localStorage.removeItem(key)
  else persistentStorageBacking.delete(key)
}

function storageKeys(): string[] {
  if (typeof localStorage === "undefined") return [...persistentStorageBacking.keys()]
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key): key is string => key !== null)
}

const workspaceMetaPrefix = "match.workspace-meta."
const workspaceDeletedPrefix = "match.workspace-deleted."
type WorkspaceMeta = { id: string; title: string; updatedAt: string }

const journalDatabaseName = "match-workspace-journal-v1"
const journalStores = ["changes", "proofs", "receipts", "metadata"] as const
type JournalStoreName = typeof journalStores[number]
type JournalIndexedStoreName = Exclude<JournalStoreName, "metadata">
type StoredProofRecord = { id: string; workspaceId: string; changeHash: string; proof: ChangeProof }
type StoredReceiptRecord = { id: string; workspaceId: string; transactionId: string; receipt: TransactionReceipt }
type LocalJournal = {
  changes: Array<{ workspaceId: string; changeHash: string; bytesBase64: string; addedAt: string }>
  proofs: Record<string, ChangeProof>
  receipts: Record<string, TransactionReceipt>
}

let journalDatabasePromise: Promise<IDBDatabase> | undefined
const localJournalQueues = new Map<string, Promise<unknown>>()
const migratedJournalWorkspaces = new Set<string>()

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"))
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"))
  })
}

function openJournalDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is not available"))
  return journalDatabasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(journalDatabaseName, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      for (const name of journalStores) {
        if (database.objectStoreNames.contains(name)) continue
        const store = database.createObjectStore(name, { keyPath: name === "metadata" ? "workspaceId" : "id" })
        if (name !== "metadata") store.createIndex("workspaceId", "workspaceId", { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"))
    request.onblocked = () => reject(new Error("IndexedDB upgrade blocked"))
  })
}

function readLocalJournal(workspaceId: string): LocalJournal {
  const current = getStorageRaw(`match.v2.journal.${workspaceId}`)
  if (current) {
    try { return JSON.parse(current) as LocalJournal } catch { /* Read legacy records below. */ }
  }
  let changes: LocalJournal["changes"] = []
  let proofs: LocalJournal["proofs"] = {}
  let receipts: LocalJournal["receipts"] = {}
  try { changes = JSON.parse(getStorageRaw(`match.v1.changes.${workspaceId}`) ?? "[]") } catch {}
  try { proofs = JSON.parse(getStorageRaw(`match.v1.proofs.${workspaceId}`) ?? "{}") } catch {}
  try { receipts = JSON.parse(getStorageRaw(`match.v1.receipts.${workspaceId}`) ?? "{}") } catch {}
  return { changes, proofs, receipts }
}

function writeLocalJournal(workspaceId: string, journal: LocalJournal) {
  setStorageRaw(`match.v2.journal.${workspaceId}`, JSON.stringify(journal))
}

function withLocalJournalLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
  const previous = localJournalQueues.get(workspaceId) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  localJournalQueues.set(workspaceId, current)
  void current.then(() => {
    if (localJournalQueues.get(workspaceId) === current) localJournalQueues.delete(workspaceId)
  }, () => {
    if (localJournalQueues.get(workspaceId) === current) localJournalQueues.delete(workspaceId)
  })
  return current
}

async function ensureJournalMigrated(workspaceId: string): Promise<IDBDatabase> {
  const database = await openJournalDatabase()
  if (migratedJournalWorkspaces.has(workspaceId)) return database
  const transaction = database.transaction([...journalStores], "readwrite")
  const completion = transactionDone(transaction)
  try {
    const migrated = await requestResult(transaction.objectStore("metadata").get(workspaceId))
    if (!migrated) {
      const legacy = readLocalJournal(workspaceId)
      const changes = transaction.objectStore("changes")
      const proofs = transaction.objectStore("proofs")
      const receipts = transaction.objectStore("receipts")
      for (const change of legacy.changes) changes.put({
        id: `${workspaceId}:${change.changeHash}`,
        workspaceId: change.workspaceId,
        changeHash: change.changeHash,
        bytes: fromBase64Url(change.bytesBase64),
        addedAt: change.addedAt,
      })
      for (const [changeHash, proof] of Object.entries(legacy.proofs)) {
        proofs.put({ id: `${workspaceId}:${changeHash}`, workspaceId, changeHash, proof } satisfies StoredProofRecord)
      }
      for (const [transactionId, receipt] of Object.entries(legacy.receipts)) {
        receipts.put({ id: `${workspaceId}:${transactionId}`, workspaceId, transactionId, receipt } satisfies StoredReceiptRecord)
      }
      transaction.objectStore("metadata").put({ workspaceId, migratedAt: new Date().toISOString() })
    }
  } catch (error) {
    transaction.abort()
    await completion.catch(() => undefined)
    throw error
  }
  await completion
  migratedJournalWorkspaces.add(workspaceId)
  return database
}

async function recordsForWorkspace<T>(database: IDBDatabase, storeName: JournalIndexedStoreName, workspaceId: string): Promise<T[]> {
  const transaction = database.transaction(storeName, "readonly")
  const completion = transactionDone(transaction)
  const store = transaction.objectStore(storeName)
  const records = await requestResult(store.index("workspaceId").getAll(workspaceId)) as T[]
  await completion
  return records
}

async function deleteWorkspaceJournal(workspaceId: string): Promise<void> {
  migratedJournalWorkspaces.delete(workspaceId)
  if (typeof indexedDB === "undefined") {
    removeStorageRaw(`match.v2.journal.${workspaceId}`)
    return
  }
  const database = await openJournalDatabase()
  const transaction = database.transaction([...journalStores], "readwrite")
  const completion = transactionDone(transaction)
  for (const name of ["changes", "proofs", "receipts"] as const) {
    const store = transaction.objectStore(name)
    const keys = await requestResult(store.index("workspaceId").getAllKeys(workspaceId))
    for (const key of keys) store.delete(key)
  }
  transaction.objectStore("metadata").delete(workspaceId)
  await completion
  removeStorageRaw(`match.v2.journal.${workspaceId}`)
}

export class WorkspaceStorage {
  private inMemory: InMemoryStore

  constructor(store = memoryStore) {
    this.inMemory = store
  }

  async listWorkspaces(): Promise<{ id: string; title: string; updatedAt: string }[]> {
    // Each workspace owns a separate key: saving one can never erase another.
    // Discover snapshots whose catalog record is missing.
    const records = new Map<string, WorkspaceMeta>()
    const deleted = (id: string) => getStorageRaw(`${workspaceDeletedPrefix}${id}`) !== null
    const accept = (value: WorkspaceMeta) => {
      if (value && typeof value.id === "string" && typeof value.title === "string" && !deleted(value.id)) {
        records.set(value.id, value)
      }
    }
    const keys = storageKeys()
    for (const key of keys.filter(key => key.startsWith(workspaceMetaPrefix))) {
      try { accept(JSON.parse(getStorageRaw(key)!)) } catch { /* Recover from the snapshot below. */ }
    }
    for (const key of keys.filter(key => key.startsWith("match.snapshot."))) {
      const id = key.slice("match.snapshot.".length)
      if (records.has(id) || deleted(id)) continue
      let doc: Automerge.Doc<WorkspaceDocumentV2> | undefined
      try {
        const saved = JSON.parse(getStorageRaw(key)!)
        doc = Automerge.load<WorkspaceDocumentV2>(saved.bytesBase64 ? fromBase64Url(saved.bytesBase64) : new Uint8Array(saved))
        if (doc.id === id && typeof doc.title === "string") accept({ id, title: doc.title, updatedAt: saved.savedAt ?? "" })
      } catch { /* Preserve unreadable data for manual recovery. */ }
      finally { if (doc) Automerge.free(doc) }
    }
    for (const record of records.values()) {
      const key = `${workspaceMetaPrefix}${record.id}`
      if (getStorageRaw(key) === null) setStorageRaw(key, JSON.stringify(record))
    }
    this.inMemory.workspaces = records
    return [...records.values()]
  }

  async registerWorkspace(id: string, title: string): Promise<void> {
    if (getStorageRaw(`${workspaceDeletedPrefix}${id}`) !== null) throw new Error("Workspace was deleted in another tab")
    const meta = { id, title, updatedAt: new Date().toISOString() }
    setStorageRaw(`${workspaceMetaPrefix}${id}`, JSON.stringify(meta))
    this.inMemory.workspaces.set(id, meta)
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

    removeStorageRaw(`${workspaceMetaPrefix}${oldId}`)
    this.inMemory.snapshots.delete(oldId)
    this.inMemory.workspaces.delete(oldId)
    for (const map of [this.inMemory.changes, this.inMemory.proofs, this.inMemory.receipts]) {
      for (const key of map.keys()) {
        if (key.startsWith(`${oldId}:`)) map.delete(key)
      }
    }
    await deleteWorkspaceJournal(oldId)
    for (const prefix of ["match.snapshot.", "match.v1.changes.", "match.v1.proofs.", "match.v1.receipts."]) {
      removeStorageRaw(`${prefix}${oldId}`)
    }
    return moved
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    checkStorageFailureHook()
    setStorageRaw(`${workspaceDeletedPrefix}${workspaceId}`, new Date().toISOString())
    removeStorageRaw(`${workspaceMetaPrefix}${workspaceId}`)
    this.inMemory.snapshots.delete(workspaceId)
    this.inMemory.workspaces.delete(workspaceId)
    for (const map of [this.inMemory.changes, this.inMemory.proofs, this.inMemory.receipts]) {
      for (const key of map.keys()) {
        if (key.startsWith(`${workspaceId}:`)) map.delete(key)
      }
    }
    await deleteWorkspaceJournal(workspaceId)
    for (const prefix of ["match.snapshot.", "match.v1.changes.", "match.v1.proofs.", "match.v1.receipts."]) {
      removeStorageRaw(`${prefix}${workspaceId}`)
    }
  }

  async commitTransaction(
    workspaceId: string,
    receipt: TransactionReceipt,
    changeBytes: Uint8Array,
    proof: ChangeProof
  ): Promise<TransactionReceipt> {
    checkStorageFailureHook()
    const receiptKey = `${workspaceId}:${receipt.transactionId}`
    const changeKey = `${workspaceId}:${receipt.changeHash}`
    const storedChange: StoredChange = {
      workspaceId,
      changeHash: receipt.changeHash,
      bytes: new Uint8Array(changeBytes),
      addedAt: new Date().toISOString(),
    }

    if (typeof indexedDB !== "undefined") {
      const database = await ensureJournalMigrated(workspaceId)
      const transaction = database.transaction(["changes", "proofs", "receipts"], "readwrite")
      const completion = transactionDone(transaction)
      try {
        const existing = await requestResult(transaction.objectStore("receipts").get(receiptKey)) as StoredReceiptRecord | undefined
        if (existing) {
          await completion
          return existing.receipt
        }
        transaction.objectStore("changes").put({ id: changeKey, ...storedChange })
        transaction.objectStore("proofs").put({
          id: changeKey, workspaceId, changeHash: receipt.changeHash, proof,
        } satisfies StoredProofRecord)
        transaction.objectStore("receipts").put({
          id: receiptKey, workspaceId, transactionId: receipt.transactionId, receipt,
        } satisfies StoredReceiptRecord)
      } catch (error) {
        transaction.abort()
        await completion.catch(() => undefined)
        throw error
      }
      await completion
    } else {
      const existing = await withLocalJournalLock(workspaceId, async () => {
        const journal = readLocalJournal(workspaceId)
        const saved = journal.receipts[receipt.transactionId]
        if (saved) return saved
        journal.changes = journal.changes.filter(change => change.changeHash !== receipt.changeHash)
        journal.changes.push({
          workspaceId, changeHash: receipt.changeHash, bytesBase64: toBase64Url(changeBytes), addedAt: storedChange.addedAt,
        })
        journal.proofs[receipt.changeHash] = proof
        journal.receipts[receipt.transactionId] = receipt
        writeLocalJournal(workspaceId, journal)
        return null
      })
      if (existing) return existing
    }

    this.inMemory.changes.set(changeKey, storedChange)
    this.inMemory.proofs.set(changeKey, proof)
    this.inMemory.receipts.set(receiptKey, receipt)
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
    if (getStorageRaw(`${workspaceDeletedPrefix}${workspaceId}`) !== null) throw new Error("Workspace was deleted in another tab")
    setStorageRaw(
      `match.snapshot.${workspaceId}`,
      JSON.stringify({ heads, bytesBase64: toBase64Url(bytes), savedAt: snapshot.savedAt })
    )
    await this.registerWorkspace(workspaceId, doc.title)
    this.inMemory.snapshots.set(workspaceId, snapshot)
  }

  async loadWorkspaceDoc(
    workspaceId: string
  ): Promise<{ doc: Automerge.Doc<WorkspaceDocumentV2>; heads: Heads } | null> {
    if (getStorageRaw(`${workspaceDeletedPrefix}${workspaceId}`) !== null) return null
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

    if (typeof indexedDB !== "undefined") {
      const database = await ensureJournalMigrated(workspaceId)
      const transaction = database.transaction("changes", "readwrite")
      const completion = transactionDone(transaction)
      const store = transaction.objectStore("changes")
      const records = await requestResult(store.index("workspaceId").getAll(workspaceId)) as Array<StoredChange & { id: string }>
      for (const record of records) if (includedHashes.has(record.changeHash)) store.delete(record.id)
      await completion
    } else {
      await withLocalJournalLock(workspaceId, async () => {
        const journal = readLocalJournal(workspaceId)
        journal.changes = journal.changes.filter(change => !includedHashes.has(change.changeHash))
        writeLocalJournal(workspaceId, journal)
      })
    }

    const prefix = `${workspaceId}:`
    for (const [key, change] of this.inMemory.changes.entries()) {
      if (key.startsWith(prefix) && includedHashes.has(change.changeHash)) this.inMemory.changes.delete(key)
    }
  }

  async listChanges(workspaceId: string): Promise<StoredChange[]> {
    const prefix = `${workspaceId}:`
    let results: StoredChange[]
    if (typeof indexedDB !== "undefined") {
      const database = await ensureJournalMigrated(workspaceId)
      const records = await recordsForWorkspace<StoredChange & { id: string }>(database, "changes", workspaceId)
      results = records.map(record => ({
        workspaceId: record.workspaceId,
        changeHash: record.changeHash,
        bytes: new Uint8Array(record.bytes),
        addedAt: record.addedAt,
      }))
    } else {
      results = readLocalJournal(workspaceId).changes.map(item => ({
        workspaceId: item.workspaceId,
        changeHash: item.changeHash,
        bytes: fromBase64Url(item.bytesBase64),
        addedAt: item.addedAt,
      }))
    }
    for (const key of [...this.inMemory.changes.keys()]) if (key.startsWith(prefix)) this.inMemory.changes.delete(key)
    for (const change of results) this.inMemory.changes.set(`${workspaceId}:${change.changeHash}`, change)
    return results
  }

  async getReceipt(workspaceId: string, transactionId: string): Promise<TransactionReceipt | null> {
    const key = `${workspaceId}:${transactionId}`
    let receipt: TransactionReceipt | null = null
    if (typeof indexedDB !== "undefined") {
      const database = await ensureJournalMigrated(workspaceId)
      const transaction = database.transaction("receipts", "readonly")
      const completion = transactionDone(transaction)
      const record = await requestResult(transaction.objectStore("receipts").get(key)) as StoredReceiptRecord | undefined
      await completion
      receipt = record?.receipt ?? null
    } else receipt = readLocalJournal(workspaceId).receipts[transactionId] ?? null
    if (receipt) this.inMemory.receipts.set(key, receipt)
    else this.inMemory.receipts.delete(key)
    return receipt
  }

  async getProof(workspaceId: string, changeHash: string): Promise<ChangeProof | null> {
    const key = `${workspaceId}:${changeHash}`
    let proof: ChangeProof | null = null
    if (typeof indexedDB !== "undefined") {
      const database = await ensureJournalMigrated(workspaceId)
      const transaction = database.transaction("proofs", "readonly")
      const completion = transactionDone(transaction)
      const record = await requestResult(transaction.objectStore("proofs").get(key)) as StoredProofRecord | undefined
      await completion
      proof = record?.proof ?? null
    } else proof = readLocalJournal(workspaceId).proofs[changeHash] ?? null
    if (proof) this.inMemory.proofs.set(key, proof)
    else this.inMemory.proofs.delete(key)
    return proof
  }

  async getProofs(workspaceId: string): Promise<StoredProofsV1> {
    let records: StoredProofRecord[]
    if (typeof indexedDB !== "undefined") {
      const database = await ensureJournalMigrated(workspaceId)
      records = await recordsForWorkspace<StoredProofRecord>(database, "proofs", workspaceId)
    } else {
      records = Object.entries(readLocalJournal(workspaceId).proofs).map(([changeHash, proof]) => ({
        id: `${workspaceId}:${changeHash}`, workspaceId, changeHash, proof,
      }))
    }
    const prefix = `${workspaceId}:`
    for (const key of [...this.inMemory.proofs.keys()]) if (key.startsWith(prefix)) this.inMemory.proofs.delete(key)
    for (const record of records) this.inMemory.proofs.set(record.id, record.proof)

    return {
      grants: [],
      certificates: [],
      actorBindings: [],
      changeProofs: records.map(record => record.proof),
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
    const request = indexedDB.open(databaseName)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName)
    }
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
