import * as Automerge from "@automerge/automerge/slim"
import { bootstrapIdentity } from "./domain/identity"
import type {
  TransactionReceipt,
  ChangeProof,
  WorkspaceDocumentV2,
  PersonalRootDocumentV1,
  Heads,
} from "./domain/model"
import { records, mergeAuthorizationRecords, type WorkspaceChangeAuthorization } from "./sync/workspaceChangeProofStore"
import { canonicalizeJson } from "./domain/identity"
import type { StoredProofsV1 } from "./domain/proofs"
import { toBase64Url, fromBase64Url } from "./domain/identity"
import { getStorageRaw, removeStorageRaw, setStorageRaw, storageKeys } from "./storageRaw"
import { includesWorkspaceHeads, repairLegacyCatalog } from "./storageCatalog"
import {
  deleteWorkspaceJournal,
  readWorkspaceSnapshot,
  listCommittedWorkspaces,
  type StoredWorkspaceSnapshot,
  openWorkspaceJournal,
  readLocalJournal,
  recordsForWorkspace,
  requestResult,
  transactionDone,
  withLocalJournalLock,
  writeLocalJournal,
  type StoredChange,
  type StoredProofRecord,
  type StoredReceiptRecord,
} from "./storageJournal"

export type { StoredChange } from "./storageJournal"
export * from "./storageLegacy"

type StoredSnapshot = {
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
  const failureWindow = typeof window === "undefined"
    ? undefined
    : window as Window & { __MATCH_INJECT_STORAGE_FAILURE__?: boolean }
  if (failureWindow?.__MATCH_INJECT_STORAGE_FAILURE__) {
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

const workspaceMetaPrefix = "match.workspace-meta."
type WorkspaceMeta = { id: string; title: string; updatedAt: string; archivedAt?: string | null }

function parseStoredSnapshot(raw: string, workspaceId: string): StoredSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as { bytesBase64?: string; heads?: Heads; savedAt?: string }
    return {
      workspaceId,
      heads: parsed.heads ?? [],
      bytes: parsed.bytesBase64 ? fromBase64Url(parsed.bytesBase64) : new Uint8Array(JSON.parse(raw) as number[]),
      savedAt: parsed.savedAt ?? new Date().toISOString(),
    }
  } catch {
    return null
  }
}

async function readIndexedJournalRecord<T>(
  workspaceId: string,
  storeName: "receipts" | "proofs",
  key: string
): Promise<T | undefined> {
  const database = await openWorkspaceJournal()
  const transaction = database.transaction(storeName, "readonly")
  const completion = transactionDone(transaction)
  const record = await requestResult(transaction.objectStore(storeName).get(key)) as T | undefined
  await completion
  return record
}


export class WorkspaceStorage {
  private inMemory: InMemoryStore

  constructor(store = memoryStore) {
    this.inMemory = store
  }

  async listWorkspaces(): Promise<WorkspaceMeta[]> {
    return (await this.workspaceRecords()).filter(record => !record.archivedAt)
  }

  async listArchivedWorkspaces(): Promise<WorkspaceMeta[]> {
    return (await this.workspaceRecords()).filter(record => Boolean(record.archivedAt))
  }

  // Catalog recovery and migration check several independent storage paths.
  // eslint-disable-next-line complexity
  private async workspaceRecords(): Promise<WorkspaceMeta[]> {
    // Each workspace owns a separate key: saving one can never erase another.
    // Discover snapshots whose catalog record is missing.
    const records = new Map<string, WorkspaceMeta>()
    const accept = (value: WorkspaceMeta) => {
      if (value && typeof value.id === "string" && typeof value.title === "string") {
        records.set(value.id, value)
      }
    }
    const keys = await storageKeys()
    for (const key of keys.filter(key => key.startsWith(workspaceMetaPrefix))) {
      try { accept(JSON.parse((await getStorageRaw(key))!)) } catch { /* Recover from the snapshot below. */ }
    }
    for (const key of keys.filter(key => key.startsWith("match.snapshot."))) {
      const id = key.slice("match.snapshot.".length)
      if (records.has(id)) continue
      let doc: Automerge.Doc<WorkspaceDocumentV2> | undefined
      try {
        const saved = JSON.parse((await getStorageRaw(key))!)
        doc = Automerge.load<WorkspaceDocumentV2>(saved.bytesBase64 ? fromBase64Url(saved.bytesBase64) : new Uint8Array(saved))
        if (doc.id === id && typeof doc.title === "string") accept({ id, title: doc.title, updatedAt: saved.savedAt ?? "", archivedAt: doc.archivedAt ?? null })
      } catch { /* Preserve unreadable data for manual recovery. */ }
      finally { if (doc) Automerge.free(doc) }
    }
    const committedSnapshots = await listCommittedWorkspaces()
    for (const snapshot of committedSnapshots) {
      const previous = records.get(snapshot.id)
      const committed = !previous || previous.updatedAt < snapshot.updatedAt ? await readWorkspaceSnapshot(snapshot.id) : null
      accept({ ...snapshot, archivedAt: committed?.archivedAt ?? previous?.archivedAt ?? null })
    }
    await repairLegacyCatalog(records, committedSnapshots)
    this.inMemory.workspaces = records
    return [...records.values()]
  }

  async registerWorkspace(id: string, title: string, archivedAt: string | null = null, allowRestore = false): Promise<void> {
    const previous = await getStorageRaw(`${workspaceMetaPrefix}${id}`)
    if (previous && !archivedAt && !allowRestore && (JSON.parse(previous) as WorkspaceMeta).archivedAt)
      throw new Error("Workspace was archived in another tab")
    const meta = { id, title, updatedAt: new Date().toISOString(), archivedAt }
    await setStorageRaw(`${workspaceMetaPrefix}${id}`, JSON.stringify(meta))
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

    await removeStorageRaw(`${workspaceMetaPrefix}${oldId}`)
    this.inMemory.snapshots.delete(oldId)
    this.inMemory.workspaces.delete(oldId)
    for (const map of [this.inMemory.changes, this.inMemory.proofs, this.inMemory.receipts]) {
      for (const key of map.keys()) {
        if (key.startsWith(`${oldId}:`)) map.delete(key)
      }
    }
    await deleteWorkspaceJournal(oldId)
    for (const prefix of ["match.snapshot.", "match.v1.changes.", "match.v1.proofs.", "match.v1.receipts."]) {
      await removeStorageRaw(`${prefix}${oldId}`)
    }
    return moved
  }

  async purgeWorkspaceForTest(workspaceId: string): Promise<void> {
    await removeStorageRaw(`${workspaceMetaPrefix}${workspaceId}`)
    this.inMemory.snapshots.delete(workspaceId)
    this.inMemory.workspaces.delete(workspaceId)
    for (const map of [this.inMemory.changes, this.inMemory.proofs, this.inMemory.receipts]) {
      for (const key of map.keys()) {
        if (key.startsWith(`${workspaceId}:`)) map.delete(key)
      }
    }
    await deleteWorkspaceJournal(workspaceId)
    for (const prefix of ["match.snapshot.", "match.v1.changes.", "match.v1.proofs.", "match.v1.receipts."]) {
      await removeStorageRaw(`${prefix}${workspaceId}`)
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
      const database = await openWorkspaceJournal()
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
    await this.commitWorkspace(workspaceId, doc, bytes, [])
  }

  /** Snapshot, authorization evidence and optional local transaction are one
   * durable unit. Callers hold the shared workspace mutation lock while reading
   * the latest document, validating it and committing the candidate. */
  // Atomic snapshot, proof and receipt commit shares one transaction.
  // eslint-disable-next-line complexity
  async commitWorkspace(
    workspaceId: string,
    doc: Automerge.Doc<WorkspaceDocumentV2>,
    bytes: Uint8Array,
    authorizations: WorkspaceChangeAuthorization[],
    command?: { receipt: TransactionReceipt; changeBytes: Uint8Array; proof: ChangeProof },
  ): Promise<{ proofChanged: boolean }> {
    checkStorageFailureHook()
    if (doc.id !== workspaceId) throw new Error("Workspace commit ID mismatch")
    const committed = await readWorkspaceSnapshot(workspaceId)
    const legacyRaw = committed ? null : await getStorageRaw(`match.snapshot.${workspaceId}`)
    const previous = committed ?? (legacyRaw ? parseStoredSnapshot(legacyRaw, workspaceId) : null)
    if (previous && !doc.archivedAt) {
      const previousDoc = Automerge.load<WorkspaceDocumentV2>(previous.bytes)
      try {
        if (previousDoc.archivedAt && !includesWorkspaceHeads(doc, Automerge.getHeads(previousDoc)))
          throw new Error("Workspace was archived in another tab")
      } finally { Automerge.free(previousDoc) }
    }
    const snapshot: StoredWorkspaceSnapshot = {
      id: workspaceId, workspaceId, title: doc.title, archivedAt: doc.archivedAt ?? null,
      heads: Automerge.getHeads(doc).sort(), bytes: new Uint8Array(bytes), savedAt: new Date().toISOString(),
    }
    // Legacy proof storage is read-only during migration. The transaction also
    // rereads current proofs, so standalone proof updates cannot be overwritten.
    const previousProofs = await records(workspaceId)
    let proofChanged = false
    const addCommand = (journal: ReturnType<typeof readLocalJournal>) => {
      if (!command) return
      const { receipt, changeBytes, proof } = command
      const saved = journal.receipts[receipt.transactionId]
      if (saved && saved.changeHash !== receipt.changeHash) throw new Error("Transaction ID conflicts with a committed change")
      if (saved) return
      journal.changes.push({ workspaceId, changeHash: receipt.changeHash, bytesBase64: toBase64Url(changeBytes), addedAt: snapshot.savedAt })
      journal.proofs[receipt.changeHash] = proof
      journal.receipts[receipt.transactionId] = receipt
    }
    if (typeof indexedDB === "undefined") {
      await withLocalJournalLock(workspaceId, async () => {
        const journal = readLocalJournal(workspaceId)
        const existing = mergeAuthorizationRecords(previousProofs, (journal.authorizations ?? []) as WorkspaceChangeAuthorization[])
        const next = mergeAuthorizationRecords(existing, authorizations)
        proofChanged = canonicalizeJson(existing) !== canonicalizeJson(next)
        journal.snapshot = snapshot
        journal.authorizations = next
        addCommand(journal)
        writeLocalJournal(workspaceId, journal)
      })
    } else {
      const database = await openWorkspaceJournal()
      const transaction = database.transaction(["snapshots", "authorizations", "changes", "proofs", "receipts"], "readwrite")
      const completion = transactionDone(transaction)
      try {
        const snapshotStore = transaction.objectStore("snapshots")
        const existingSnapshot = await requestResult(snapshotStore.get(workspaceId)) as StoredWorkspaceSnapshot | undefined
        const proofStore = transaction.objectStore("authorizations")
        const stored = await requestResult(proofStore.get(workspaceId)) as { records: WorkspaceChangeAuthorization[] } | undefined
        const existing = mergeAuthorizationRecords(previousProofs, stored?.records ?? [])
        const next = mergeAuthorizationRecords(existing, authorizations)
        proofChanged = canonicalizeJson(existing) !== canonicalizeJson(next)
        if (!existingSnapshot || existingSnapshot.heads.join() !== snapshot.heads.join()) snapshotStore.put(snapshot)
        if (!stored || proofChanged) proofStore.put({ id: workspaceId, workspaceId, records: next })
        if (command) {
          const { receipt, changeBytes, proof } = command
          const receiptKey = `${workspaceId}:${receipt.transactionId}`
          const existingReceipt = await requestResult(transaction.objectStore("receipts").get(receiptKey)) as StoredReceiptRecord | undefined
          if (existingReceipt && existingReceipt.receipt.changeHash !== receipt.changeHash) throw new Error("Transaction ID conflicts with a committed change")
          if (!existingReceipt) {
            const changeKey = `${workspaceId}:${receipt.changeHash}`
            transaction.objectStore("changes").put({ id: changeKey, workspaceId, changeHash: receipt.changeHash, bytes: new Uint8Array(changeBytes), addedAt: snapshot.savedAt })
            transaction.objectStore("proofs").put({ id: changeKey, workspaceId, changeHash: receipt.changeHash, proof })
            transaction.objectStore("receipts").put({ id: receiptKey, workspaceId, transactionId: receipt.transactionId, receipt })
          }
        }
      } catch (error) {
        transaction.abort()
        await completion.catch(() => undefined)
        throw error
      }
      await completion
    }
    // Memory projections advance only after the durable transaction completes.
    this.inMemory.snapshots.set(workspaceId, snapshot)
    await this.registerWorkspace(workspaceId, doc.title, doc.archivedAt ?? null, true)
    return { proofChanged }
  }

  async loadWorkspaceDoc(
    workspaceId: string
  ): Promise<{ doc: Automerge.Doc<WorkspaceDocumentV2>; heads: Heads } | null> {
    const committedSnapshot = await readWorkspaceSnapshot(workspaceId)
    const rawSnapshot = committedSnapshot ? null : await getStorageRaw(`match.snapshot.${workspaceId}`)
    const parsedSnapshot = committedSnapshot ?? (rawSnapshot ? parseStoredSnapshot(rawSnapshot, workspaceId) : null)
    if (parsedSnapshot) this.inMemory.snapshots.set(workspaceId, parsedSnapshot)
    const snapshot = parsedSnapshot ?? this.inMemory.snapshots.get(workspaceId) ?? null

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
      const database = await openWorkspaceJournal()
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
      const database = await openWorkspaceJournal()
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
    const receipt = typeof indexedDB === "undefined"
      ? readLocalJournal(workspaceId).receipts[transactionId] ?? null
      : (await readIndexedJournalRecord<StoredReceiptRecord>(workspaceId, "receipts", key))?.receipt ?? null
    if (receipt) this.inMemory.receipts.set(key, receipt)
    else this.inMemory.receipts.delete(key)
    return receipt
  }

  async getProof(workspaceId: string, changeHash: string): Promise<ChangeProof | null> {
    const key = `${workspaceId}:${changeHash}`
    const proof = typeof indexedDB === "undefined"
      ? readLocalJournal(workspaceId).proofs[changeHash] ?? null
      : (await readIndexedJournalRecord<StoredProofRecord>(workspaceId, "proofs", key))?.proof ?? null
    if (proof) this.inMemory.proofs.set(key, proof)
    else this.inMemory.proofs.delete(key)
    return proof
  }

  async getProofs(workspaceId: string): Promise<StoredProofsV1> {
    let records: StoredProofRecord[]
    if (typeof indexedDB !== "undefined") {
      const database = await openWorkspaceJournal()
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
    const raw = await getStorageRaw("match.v1.personal_roots")
    const map: Record<string, PersonalRootDocumentV1> = raw ? JSON.parse(raw) : {}
    map[root.rootId] = JSON.parse(JSON.stringify(root))
    await setStorageRaw("match.v1.personal_roots", JSON.stringify(map))
  }

  async loadPersonalRoot(rootId?: string): Promise<PersonalRootDocumentV1 | null> {
    const raw = await getStorageRaw("match.v1.personal_roots")
    if (raw) {
      try {
        const map = JSON.parse(raw)
        for (const [id, root] of Object.entries(map)) {
          this.inMemory.personalRoots.set(id, root as PersonalRootDocumentV1)
        }
      } catch {
        // Ignore malformed persisted personal roots.
      }
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
