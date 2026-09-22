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
}

const journalDatabaseName = "match-workspace-journal-v1"
const journalStores = ["changes", "proofs", "receipts"] as const
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

function openJournalDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is not available"))
  return journalDatabasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(journalDatabaseName, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      for (const name of journalStores) {
        if (database.objectStoreNames.contains(name)) continue
        const store = database.createObjectStore(name, { keyPath: "id" })
        store.createIndex("workspaceId", "workspaceId", { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"))
    request.onblocked = () => reject(new Error("IndexedDB upgrade blocked"))
  })
}

export function readLocalJournal(workspaceId: string): LocalJournal {
  return memoryJournals.get(workspaceId) ?? { changes: [], proofs: {}, receipts: {} }
}

export function writeLocalJournal(workspaceId: string, journal: LocalJournal): void {
  memoryJournals.set(workspaceId, journal)
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
  for (const name of ["changes", "proofs", "receipts"] as const) {
    const store = transaction.objectStore(name)
    const keys = await requestResult(store.index("workspaceId").getAllKeys(workspaceId))
    for (const key of keys) store.delete(key)
  }
  await completion
}
