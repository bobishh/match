import type { ChangeProof, TransactionReceipt } from "./domain/model"

export type StoredChange = {
  workspaceId: string
  changeHash: string
  bytes: Uint8Array
  addedAt: string
}

export type StoredProofRecord = { id: string; workspaceId: string; changeHash: string; proof: ChangeProof }
export type StoredReceiptRecord = {
  id: string
  workspaceId: string
  transactionId: string
  receipt: TransactionReceipt
}

export type LocalJournal = {
  changes: Array<{ workspaceId: string; changeHash: string; bytesBase64: string; addedAt: string }>
  proofs: Record<string, ChangeProof>
  receipts: Record<string, TransactionReceipt>
  snapshot?: StoredWorkspaceSnapshot
  authorizations?: unknown[]
}

export type StoredWorkspaceSnapshot = {
  id: string
  workspaceId: string
  title: string
  heads: string[]
  bytes: Uint8Array
  savedAt: string
}

const journalDatabaseName = "match-workspace-journal-v1"
const journalStores = ["changes", "proofs", "receipts", "snapshots", "authorizations"] as const
type JournalStoreName = typeof journalStores[number]
type JournalIndexedStoreName = JournalStoreName

let journalDatabasePromise: Promise<IDBDatabase> | undefined
const localJournalQueues = new Map<string, Promise<unknown>>()
const memoryJournals = new Map<string, LocalJournal>()

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"))
  })
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"))
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"))
  })
}

function requestOpenJournal(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(journalDatabaseName) : indexedDB.open(journalDatabaseName, version)
    let blocked = false
    request.onupgradeneeded = () => {
      const database = request.result
      for (const name of journalStores) {
        const store = database.objectStoreNames.contains(name)
          ? request.transaction!.objectStore(name)
          : database.createObjectStore(name, { keyPath: "id" })
        if (!store.indexNames.contains("workspaceId")) store.createIndex("workspaceId", "workspaceId", { unique: false })
        if (name === "snapshots" && !store.indexNames.contains("catalog")) {
          store.createIndex("catalog", ["workspaceId", "title", "savedAt"], { unique: false })
        }
      }
    }
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return }
      request.result.onversionchange = () => { request.result.close(); journalDatabasePromise = undefined }
      resolve(request.result)
    }
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"))
    request.onblocked = () => {
      blocked = true
      const error = new Error("Close other Match tabs and reload to upgrade workspace storage")
      error.name = "IndexedDBBlockedError"
      reject(error)
    }
  })
}

async function ensureJournalStores(): Promise<IDBDatabase> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const database = await requestOpenJournal()
    const complete = journalStores.every(name => database.objectStoreNames.contains(name))
    if (complete && database.transaction("snapshots", "readonly").objectStore("snapshots").indexNames.contains("catalog")) return database
    const version = database.version + 1
    database.close()
    try { return await requestOpenJournal(version) }
    catch (error) {
      if (!(error instanceof DOMException && error.name === "VersionError") || attempt === 2) throw error
    }
  }
  throw new Error("IndexedDB journal upgrade failed")
}

function openJournalDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is not available"))
  return journalDatabasePromise ??= ensureJournalStores().catch(error => {
    journalDatabasePromise = undefined
    throw error
  })
}

export function readLocalJournal(workspaceId: string): LocalJournal {
  return structuredClone(memoryJournals.get(workspaceId) ?? { changes: [], proofs: {}, receipts: {} })
}

export function writeLocalJournal(workspaceId: string, journal: LocalJournal): void {
  memoryJournals.set(workspaceId, structuredClone(journal))
}

export function withLocalJournalLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
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

export async function openWorkspaceJournal(): Promise<IDBDatabase> {
  return openJournalDatabase()
}

export async function recordsForWorkspace<T>(
  database: IDBDatabase,
  storeName: JournalIndexedStoreName,
  workspaceId: string
): Promise<T[]> {
  const transaction = database.transaction(storeName, "readonly")
  const completion = transactionDone(transaction)
  const records = await requestResult(
    transaction.objectStore(storeName).index("workspaceId").getAll(workspaceId),
  ) as T[]
  await completion
  return records
}

export async function deleteWorkspaceJournal(workspaceId: string): Promise<void> {
  memoryJournals.delete(workspaceId)
  if (typeof indexedDB === "undefined") {
    return
  }
  const database = await openJournalDatabase()
  const transaction = database.transaction([...journalStores], "readwrite")
  const completion = transactionDone(transaction)
  for (const name of ["changes", "proofs", "receipts", "snapshots", "authorizations"] as const) {
    const store = transaction.objectStore(name)
    const keys = await requestResult(store.index("workspaceId").getAllKeys(workspaceId))
    for (const key of keys) store.delete(key)
  }
  await completion
}

export async function readWorkspaceSnapshot(workspaceId: string): Promise<StoredWorkspaceSnapshot | undefined> {
  if (typeof indexedDB === "undefined") return readLocalJournal(workspaceId).snapshot
  const database = await openWorkspaceJournal()
  const transaction = database.transaction("snapshots", "readonly")
  const completion = transactionDone(transaction)
  const snapshot = await requestResult(transaction.objectStore("snapshots").get(workspaceId)) as StoredWorkspaceSnapshot | undefined
  await completion
  return snapshot
}

export type CommittedWorkspaceMeta = { id: string; title: string; updatedAt: string }

export async function listCommittedWorkspaces(): Promise<CommittedWorkspaceMeta[]> {
  if (typeof indexedDB === "undefined") return [...memoryJournals.values()].flatMap(journal => journal.snapshot
    ? [{ id: journal.snapshot.workspaceId, title: journal.snapshot.title, updatedAt: journal.snapshot.savedAt }] : [])
  const database = await openWorkspaceJournal()
  const transaction = database.transaction("snapshots", "readonly")
  const completion = transactionDone(transaction)
  const results: CommittedWorkspaceMeta[] = []
  // Index keys carry catalog metadata; never clone every board's document bytes.
  const request = transaction.objectStore("snapshots").index("catalog").openKeyCursor()
  const scanned = new Promise<void>((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) { resolve(); return }
      const [id, title, updatedAt] = cursor.key as string[]
      results.push({ id: id!, title: title!, updatedAt: updatedAt! })
      cursor.continue()
    }
    request.onerror = () => reject(request.error ?? new Error("Workspace catalog read failed"))
  })
  await Promise.all([scanned, completion])
  return results
}
