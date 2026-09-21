import type { ChangeProof, TransactionReceipt } from "./domain/model"
import { fromBase64Url } from "./domain/identity"
import { getStorageRaw, removeStorageRaw, setStorageRaw } from "./storageRaw"

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
const journalStores = ["changes", "proofs", "receipts", "metadata"] as const
type JournalStoreName = typeof journalStores[number]
type JournalIndexedStoreName = Exclude<JournalStoreName, "metadata">

let journalDatabasePromise: Promise<IDBDatabase> | undefined
const localJournalQueues = new Map<string, Promise<unknown>>()
const migratedJournalWorkspaces = new Set<string>()

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
        const store = database.createObjectStore(name, { keyPath: name === "metadata" ? "workspaceId" : "id" })
        if (name !== "metadata") store.createIndex("workspaceId", "workspaceId", { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"))
    request.onblocked = () => reject(new Error("IndexedDB upgrade blocked"))
  })
}

export function readLocalJournal(workspaceId: string): LocalJournal {
  const current = getStorageRaw(`match.v2.journal.${workspaceId}`)
  if (current) {
    try {
      return JSON.parse(current) as LocalJournal
    } catch {
      // Read legacy records below.
    }
  }
  let changes: LocalJournal["changes"] = []
  let proofs: LocalJournal["proofs"] = {}
  let receipts: LocalJournal["receipts"] = {}
  try {
    changes = JSON.parse(getStorageRaw(`match.v1.changes.${workspaceId}`) ?? "[]") as LocalJournal["changes"]
  } catch {
    // Ignore malformed legacy changes.
  }
  try {
    proofs = JSON.parse(getStorageRaw(`match.v1.proofs.${workspaceId}`) ?? "{}") as LocalJournal["proofs"]
  } catch {
    // Ignore malformed legacy proofs.
  }
  try {
    receipts = JSON.parse(getStorageRaw(`match.v1.receipts.${workspaceId}`) ?? "{}") as LocalJournal["receipts"]
  } catch {
    // Ignore malformed legacy receipts.
  }
  return { changes, proofs, receipts }
}

export function writeLocalJournal(workspaceId: string, journal: LocalJournal): void {
  setStorageRaw(`match.v2.journal.${workspaceId}`, JSON.stringify(journal))
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

export async function ensureJournalMigrated(workspaceId: string): Promise<IDBDatabase> {
  const database = await openJournalDatabase()
  if (migratedJournalWorkspaces.has(workspaceId)) return database
  const transaction = database.transaction([...journalStores], "readwrite")
  const completion = transactionDone(transaction)
  try {
    const migrated = await requestResult(transaction.objectStore("metadata").get(workspaceId))
    if (!migrated) migrateLegacyJournal(transaction, workspaceId)
  } catch (error) {
    transaction.abort()
    await completion.catch(() => undefined)
    throw error
  }
  await completion
  migratedJournalWorkspaces.add(workspaceId)
  return database
}

function migrateLegacyJournal(transaction: IDBTransaction, workspaceId: string): void {
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
