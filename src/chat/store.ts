/**
 * ChatStore: Real IndexedDB chat storage for Match.
 *
 * Provides durable, transactional, local-first chat message and profile storage.
 * - Database: "match-chat-v1" (configurable via constructor)
 * - Atomic readwrite transactions across messages, profiles, and workspace meta
 * - Cap per workspace: 2000 messages AND 4 MiB serialized record bytes
 * - Monotonic prune cutoff prevents reimporting pruned messages
 * - Deterministic profile LWW resolution with canonical JSON tie-breaking
 * - Strictly IndexedDB: no silent localStorage fallback
 */

export type StoredChatMessage = {
  id: string
  workspaceId: string
  personId: string
  createdAt: string
  body: string
  record: unknown
}

export type StoredChatProfile = {
  workspaceId: string
  personId: string
  name: string
  revision: number
  record: unknown
}

export type ChatSnapshot = {
  messages: StoredChatMessage[]
  profiles: StoredChatProfile[]
}

export const DEFAULT_DB_NAME = "match-chat-v1"
export const MAX_WORKSPACE_MESSAGES = 2000
export const MAX_WORKSPACE_BYTES = 4 * 1024 * 1024 // 4 MiB
export const MAX_WORKSPACE_PROFILES = 512
export const MAX_RECORD_BYTES = 32 * 1024 // 32 KiB
export const MAX_BODY_CODEPOINTS = 8000
export const MAX_STRING_FIELD_LENGTH = 256

const STORE_MESSAGES = "messages"
const STORE_PROFILES = "profiles"
const STORE_META = "meta"

const INDEX_MSG_WORKSPACE_ORDER = "by_workspace_order"
const INDEX_MSG_WORKSPACE = "by_workspace"
const INDEX_PROF_WORKSPACE = "by_workspace"

interface StoredMessageInternal extends StoredChatMessage {
  orderKey: string
  serializedBytes: number
}

interface WorkspaceMetaInternal {
  workspaceId: string
  cursor: string | null
  pruneCutoff: string | null
}

const textEncoder = new TextEncoder()

/**
 * Deterministically serialize a JavaScript value to canonical JSON.
 * - Object keys sorted alphabetically
 * - Deterministic formatting without arbitrary whitespace
 * - Circular references throw TypeError
 */
function canonicalJsonInternal(val: unknown, seen: Set<unknown>): string {
  if (val === null) return "null"
  const type = typeof val
  if (type === "boolean" || type === "number" || type === "string") {
    return JSON.stringify(val)
  }
  if (type === "undefined" || type === "symbol" || type === "function") {
    return "null"
  }
  if (type === "bigint") {
    throw new TypeError("BigInt cannot be serialized to canonical JSON")
  }
  if (typeof val === "object") {
    if (seen.has(val)) {
      throw new TypeError("Circular reference detected in object")
    }
    seen.add(val)
    try {
      if (Array.isArray(val)) {
        const items = val.map((item) => (item === undefined ? "null" : canonicalJsonInternal(item, seen)))
        return `[${items.join(",")}]`
      }
      const obj = val as Record<string, unknown>
      const keys = Object.keys(obj).sort()
      const entries: string[] = []
      for (const key of keys) {
        const v = obj[key]
        if (v !== undefined && typeof v !== "function" && typeof v !== "symbol") {
          entries.push(`${JSON.stringify(key)}:${canonicalJsonInternal(v, seen)}`)
        }
      }
      return `{${entries.join(",")}}`
    } finally {
      seen.delete(val)
    }
  }
  return "null"
}

export function canonicalJson(val: unknown): string {
  return canonicalJsonInternal(val, new Set())
}

export function getSerializedBytes(val: unknown): number {
  return textEncoder.encode(canonicalJson(val)).byteLength
}

export function getMessageRecordSerializedBytes(message: StoredChatMessage): number {
  return textEncoder.encode(
    canonicalJson({
      id: message.id,
      workspaceId: message.workspaceId,
      personId: message.personId,
      createdAt: message.createdAt,
      body: message.body,
      record: message.record,
    })
  ).byteLength
}

/**
 * Used for ordering and cursors: `${createdAt}|${id}`.
 * Chronological order by createdAt then id.
 */
export function messageOrderKey(message: { createdAt: string; id: string }): string {
  return `${message.createdAt}|${message.id}`
}

function countCodepoints(str: string): number {
  return Array.from(str).length
}

export function validateMessage(message: StoredChatMessage): void {
  if (!message || typeof message !== "object") {
    throw new Error("Message must be a non-null object")
  }
  if (typeof message.id !== "string" || message.id.length === 0 || message.id.length > MAX_STRING_FIELD_LENGTH) {
    throw new Error(`Message id must be a string between 1 and ${MAX_STRING_FIELD_LENGTH} characters`)
  }
  if (
    typeof message.workspaceId !== "string" ||
    message.workspaceId.length === 0 ||
    message.workspaceId.length > MAX_STRING_FIELD_LENGTH
  ) {
    throw new Error(`Message workspaceId must be a string between 1 and ${MAX_STRING_FIELD_LENGTH} characters`)
  }
  if (
    typeof message.personId !== "string" ||
    message.personId.length === 0 ||
    message.personId.length > MAX_STRING_FIELD_LENGTH
  ) {
    throw new Error(`Message personId must be a string between 1 and ${MAX_STRING_FIELD_LENGTH} characters`)
  }
  if (typeof message.createdAt !== "string" || message.createdAt.length === 0 || message.createdAt.length > 128) {
    throw new Error("Message createdAt must be a valid timestamp string")
  }
  if (isNaN(Date.parse(message.createdAt))) {
    throw new Error("Message createdAt must be a valid ISO timestamp")
  }
  if (typeof message.body !== "string") {
    throw new Error("Message body must be a string")
  }
  if (countCodepoints(message.body) > MAX_BODY_CODEPOINTS) {
    throw new Error(`Message body exceeds maximum ${MAX_BODY_CODEPOINTS} codepoints`)
  }
  const recordBytes = getSerializedBytes(message.record)
  if (recordBytes > MAX_RECORD_BYTES) {
    throw new Error(`Message record serialized bytes (${recordBytes}) exceeds ${MAX_RECORD_BYTES} bytes limit`)
  }
}

export function validateProfile(profile: StoredChatProfile): void {
  if (!profile || typeof profile !== "object") {
    throw new Error("Profile must be a non-null object")
  }
  if (
    typeof profile.workspaceId !== "string" ||
    profile.workspaceId.length === 0 ||
    profile.workspaceId.length > MAX_STRING_FIELD_LENGTH
  ) {
    throw new Error(`Profile workspaceId must be a string between 1 and ${MAX_STRING_FIELD_LENGTH} characters`)
  }
  if (
    typeof profile.personId !== "string" ||
    profile.personId.length === 0 ||
    profile.personId.length > MAX_STRING_FIELD_LENGTH
  ) {
    throw new Error(`Profile personId must be a string between 1 and ${MAX_STRING_FIELD_LENGTH} characters`)
  }
  if (typeof profile.name !== "string" || profile.name.length > 500) {
    throw new Error("Profile name must be a string with length <= 500")
  }
  if (typeof profile.revision !== "number" || !Number.isInteger(profile.revision) || profile.revision < 0) {
    throw new Error("Profile revision must be a non-negative integer")
  }
  const recordBytes = getSerializedBytes(profile.record)
  if (recordBytes > MAX_RECORD_BYTES) {
    throw new Error(`Profile record serialized bytes (${recordBytes}) exceeds ${MAX_RECORD_BYTES} bytes limit`)
  }
}

export function areMessagesIdentical(a: StoredChatMessage, b: StoredChatMessage): boolean {
  return (
    a.id === b.id &&
    a.workspaceId === b.workspaceId &&
    a.personId === b.personId &&
    a.createdAt === b.createdAt &&
    a.body === b.body &&
    canonicalJson(a.record) === canonicalJson(b.record)
  )
}

/**
 * Profile resolution: latest revision wins.
 * Tie-breaker: canonical JSON record lexical ordering deterministic.
 */
export function doesProfileWin(incoming: StoredChatProfile, existing: StoredChatProfile): boolean {
  if (incoming.revision > existing.revision) return true
  if (incoming.revision < existing.revision) return false
  const incRecJson = canonicalJson(incoming.record)
  const extRecJson = canonicalJson(existing.record)
  if (incRecJson > extRecJson) return true
  if (incRecJson < extRecJson) return false
  if (incoming.name > existing.name) return true
  return false
}

function computeRetention(allMessages: StoredMessageInternal[]): {
  retained: StoredMessageInternal[]
  pruned: StoredMessageInternal[]
  retainedIds: Set<string>
} {
  const retained: StoredMessageInternal[] = []
  const retainedIds = new Set<string>()
  let totalBytes = 0

  // Keep latest within cap (traverse newest to oldest)
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const msg = allMessages[i]
    if (retained.length + 1 > MAX_WORKSPACE_MESSAGES) {
      break
    }
    if (totalBytes + msg.serializedBytes > MAX_WORKSPACE_BYTES) {
      break
    }
    retained.unshift(msg)
    retainedIds.add(msg.id)
    totalBytes += msg.serializedBytes
  }

  const pruned = allMessages.slice(0, allMessages.length - retained.length)
  return { retained, pruned, retainedIds }
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error("IDBRequest error"))
  })
}

export class ChatStore {
  private readonly dbName: string
  private dbInstance: IDBDatabase | null = null

  constructor(dbName: string = DEFAULT_DB_NAME) {
    this.dbName = dbName
  }

  private openDb(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined" || !indexedDB) {
      return Promise.reject(new Error("IndexedDB is not available in this environment"))
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1)

      request.onblocked = () => {
        reject(new Error(`IndexedDB open blocked for database ${this.dbName}`))
      }

      request.onerror = () => {
        reject(request.error || new Error(`Failed to open IndexedDB ${this.dbName}`))
      }

      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
          const msgStore = db.createObjectStore(STORE_MESSAGES, { keyPath: ["workspaceId", "id"] })
          msgStore.createIndex(INDEX_MSG_WORKSPACE_ORDER, ["workspaceId", "orderKey"], { unique: false })
          msgStore.createIndex(INDEX_MSG_WORKSPACE, "workspaceId", { unique: false })
        }
        if (!db.objectStoreNames.contains(STORE_PROFILES)) {
          const profStore = db.createObjectStore(STORE_PROFILES, { keyPath: ["workspaceId", "personId"] })
          profStore.createIndex(INDEX_PROF_WORKSPACE, "workspaceId", { unique: false })
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "workspaceId" })
        }
      }

      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => {
          try {
            db.close()
          } catch {}
          this.dbInstance = null
        }
        db.onclose = () => {
          this.dbInstance = null
        }
        resolve(db)
      }
    })
  }

  private async getDb(): Promise<IDBDatabase> {
    if (this.dbInstance) {
      return this.dbInstance
    }
    const db = await this.openDb()
    this.dbInstance = db
    return db
  }

  /**
   * Run an atomic transaction across stores.
   * Resolves only when transaction fires oncomplete (durability).
   * Rejects immediately on error, quota exceeded, or abort.
   */
  private runTx<T>(
    storeNames: string[],
    mode: IDBTransactionMode,
    fn: (tx: IDBTransaction) => Promise<T>
  ): Promise<T> {
    return new Promise(async (resolve, reject) => {
      let db: IDBDatabase
      try {
        db = await this.getDb()
      } catch (err) {
        reject(err)
        return
      }

      let tx: IDBTransaction
      try {
        tx = db.transaction(storeNames, mode)
      } catch (err) {
        reject(err)
        return
      }

      let result: T
      let isResultReady = false
      let hasTxFinished = false

      tx.oncomplete = () => {
        hasTxFinished = true
        if (isResultReady) {
          resolve(result)
        } else {
          reject(new Error("Transaction completed before result was produced"))
        }
      }

      tx.onerror = () => {
        hasTxFinished = true
        reject(tx.error || new Error("Transaction error"))
      }

      tx.onabort = () => {
        hasTxFinished = true
        reject(tx.error || new Error("Transaction aborted"))
      }

      try {
        result = await fn(tx)
        isResultReady = true
        if (hasTxFinished) {
          resolve(result)
        }
      } catch (err) {
        try {
          tx.abort()
        } catch {}
        reject(err)
      }
    })
  }

  async load(workspaceId: string): Promise<ChatSnapshot> {
    if (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > MAX_STRING_FIELD_LENGTH) {
      throw new Error(`Invalid workspaceId: must be string between 1 and ${MAX_STRING_FIELD_LENGTH}`)
    }

    return this.runTx([STORE_MESSAGES, STORE_PROFILES], "readonly", async (tx) => {
      const msgStore = tx.objectStore(STORE_MESSAGES)
      const profStore = tx.objectStore(STORE_PROFILES)

      const msgIndex = msgStore.index(INDEX_MSG_WORKSPACE_ORDER)
      const profIndex = profStore.index(INDEX_PROF_WORKSPACE)

      const msgsReq = msgIndex.getAll(IDBKeyRange.bound([workspaceId, ""], [workspaceId, "\uffff"]))
      const profsReq = profIndex.getAll(IDBKeyRange.only(workspaceId))

      const [storedMsgs, storedProfs] = await Promise.all([
        promisifyRequest<StoredMessageInternal[]>(msgsReq),
        promisifyRequest<StoredChatProfile[]>(profsReq),
      ])

      const messages: StoredChatMessage[] = (storedMsgs || []).map((m) => ({
        id: m.id,
        workspaceId: m.workspaceId,
        personId: m.personId,
        createdAt: m.createdAt,
        body: m.body,
        record: m.record,
      }))

      const profiles: StoredChatProfile[] = (storedProfs || []).map((p) => ({
        workspaceId: p.workspaceId,
        personId: p.personId,
        name: p.name,
        revision: p.revision,
        record: p.record,
      }))

      return { messages, profiles }
    })
  }

  async append(message: StoredChatMessage): Promise<boolean> {
    validateMessage(message)

    return this.runTx([STORE_MESSAGES, STORE_PROFILES, STORE_META], "readwrite", async (tx) => {
      const msgStore = tx.objectStore(STORE_MESSAGES)
      const metaStore = tx.objectStore(STORE_META)

      const orderKey = messageOrderKey(message)
      const serializedBytes = getMessageRecordSerializedBytes(message)
      const internalMsg: StoredMessageInternal = {
        ...message,
        orderKey,
        serializedBytes,
      }

      const metaReq = metaStore.get(message.workspaceId)
      const msgIndex = msgStore.index(INDEX_MSG_WORKSPACE_ORDER)
      const range = IDBKeyRange.bound([message.workspaceId, ""], [message.workspaceId, "\uffff"])
      const msgsReq = msgIndex.getAll(range)

      const [metaResult, existingMsgsResult] = await Promise.all([
        promisifyRequest<WorkspaceMetaInternal | undefined>(metaReq),
        promisifyRequest<StoredMessageInternal[]>(msgsReq),
      ])

      const meta: WorkspaceMetaInternal = metaResult || {
        workspaceId: message.workspaceId,
        cursor: null,
        pruneCutoff: null,
      }

      // Check prune cutoff: pruned messages cannot be reimported
      if (meta.pruneCutoff && orderKey <= meta.pruneCutoff) {
        return false
      }

      const existingMsgs = existingMsgsResult || []
      const existing = existingMsgs.find((m) => m.id === message.id)
      if (existing) {
        if (!areMessagesIdentical(existing, message)) {
          throw new Error(
            `Message conflict: immutable message content mismatch for [${message.workspaceId}, ${message.id}]`
          )
        }
        return false
      }

      // Merge and enforce retention caps
      const allMsgs = [...existingMsgs, internalMsg]
      allMsgs.sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0))

      const { retained, pruned, retainedIds } = computeRetention(allMsgs)

      // Delete any pruned messages that were in the DB
      const existingIds = new Set(existingMsgs.map((m) => m.id))
      for (const prunedMsg of pruned) {
        if (existingIds.has(prunedMsg.id)) {
          msgStore.delete([message.workspaceId, prunedMsg.id])
        }
      }

      // Persist prune cutoff monotonically in the same transaction
      if (pruned.length > 0) {
        const latestPrunedKey = pruned[pruned.length - 1].orderKey
        meta.pruneCutoff =
          meta.pruneCutoff && meta.pruneCutoff > latestPrunedKey
            ? meta.pruneCutoff
            : latestPrunedKey
        metaStore.put(meta)
      }

      // Persist newly inserted durable record if retained
      if (retainedIds.has(message.id)) {
        msgStore.put(internalMsg)
        return true
      }

      return false
    })
  }

  async putProfile(profile: StoredChatProfile): Promise<boolean> {
    validateProfile(profile)

    return this.runTx([STORE_MESSAGES, STORE_PROFILES, STORE_META], "readwrite", async (tx) => {
      const profStore = tx.objectStore(STORE_PROFILES)
      const profIndex = profStore.index(INDEX_PROF_WORKSPACE)

      const getReq = profStore.get([profile.workspaceId, profile.personId])
      const allReq = profIndex.getAll(IDBKeyRange.only(profile.workspaceId))

      const [existing, allProfiles] = await Promise.all([
        promisifyRequest<StoredChatProfile | undefined>(getReq),
        promisifyRequest<StoredChatProfile[]>(allReq),
      ])

      if (!existing) {
        const count = (allProfiles || []).length
        if (count >= MAX_WORKSPACE_PROFILES) {
          throw new Error(`Profile limit of ${MAX_WORKSPACE_PROFILES} exceeded for workspace`)
        }
        profStore.put(profile)
        return true
      }

      if (doesProfileWin(profile, existing)) {
        profStore.put(profile)
        return true
      }

      return false
    })
  }

  async merge(
    workspaceId: string,
    messages: StoredChatMessage[],
    profiles: StoredChatProfile[]
  ): Promise<{ added: StoredChatMessage[]; changed: boolean }> {
    if (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > MAX_STRING_FIELD_LENGTH) {
      throw new Error(`Invalid workspaceId: must be string between 1 and ${MAX_STRING_FIELD_LENGTH}`)
    }
    if (!Array.isArray(messages)) {
      throw new Error("messages must be an array")
    }
    if (!Array.isArray(profiles)) {
      throw new Error("profiles must be an array")
    }

    // Validate incoming messages
    for (const msg of messages) {
      if (msg.workspaceId !== workspaceId) {
        throw new Error(
          `Incoming message workspaceId '${msg.workspaceId}' does not match target workspaceId '${workspaceId}'`
        )
      }
      validateMessage(msg)
    }

    // Validate incoming profiles
    for (const prof of profiles) {
      if (prof.workspaceId !== workspaceId) {
        throw new Error(
          `Incoming profile workspaceId '${prof.workspaceId}' does not match target workspaceId '${workspaceId}'`
        )
      }
      validateProfile(prof)
    }

    // Intra-batch message duplicate and conflict detection
    const batchMsgMap = new Map<string, StoredChatMessage>()
    for (const msg of messages) {
      const prev = batchMsgMap.get(msg.id)
      if (prev) {
        if (!areMessagesIdentical(prev, msg)) {
          throw new Error(`Message conflict in batch: immutable content mismatch for [${workspaceId}, ${msg.id}]`)
        }
      } else {
        batchMsgMap.set(msg.id, msg)
      }
    }

    // Intra-batch profile deduplication
    const batchProfMap = new Map<string, StoredChatProfile>()
    for (const prof of profiles) {
      const prev = batchProfMap.get(prof.personId)
      if (!prev) {
        batchProfMap.set(prof.personId, prof)
      } else if (doesProfileWin(prof, prev)) {
        batchProfMap.set(prof.personId, prof)
      }
    }

    return this.runTx([STORE_MESSAGES, STORE_PROFILES, STORE_META], "readwrite", async (tx) => {
      const msgStore = tx.objectStore(STORE_MESSAGES)
      const profStore = tx.objectStore(STORE_PROFILES)
      const metaStore = tx.objectStore(STORE_META)

      const msgIndex = msgStore.index(INDEX_MSG_WORKSPACE_ORDER)
      const profIndex = profStore.index(INDEX_PROF_WORKSPACE)

      const msgsReq = msgIndex.getAll(IDBKeyRange.bound([workspaceId, ""], [workspaceId, "\uffff"]))
      const profsReq = profIndex.getAll(IDBKeyRange.only(workspaceId))
      const metaReq = metaStore.get(workspaceId)

      const [existingMsgs, existingProfs, existingMeta] = await Promise.all([
        promisifyRequest<StoredMessageInternal[]>(msgsReq),
        promisifyRequest<StoredChatProfile[]>(profsReq),
        promisifyRequest<WorkspaceMetaInternal | undefined>(metaReq),
      ])

      const meta: WorkspaceMetaInternal = existingMeta || {
        workspaceId,
        cursor: null,
        pruneCutoff: null,
      }

      let changed = false

      // 1. Process profiles
      const profMap = new Map<string, StoredChatProfile>()
      for (const p of existingProfs || []) {
        profMap.set(p.personId, p)
      }

      for (const incomingProf of batchProfMap.values()) {
        const existing = profMap.get(incomingProf.personId)
        if (!existing) {
          if (profMap.size >= MAX_WORKSPACE_PROFILES) {
            throw new Error(`Profile limit of ${MAX_WORKSPACE_PROFILES} exceeded for workspace`)
          }
          profStore.put(incomingProf)
          profMap.set(incomingProf.personId, incomingProf)
          changed = true
        } else if (doesProfileWin(incomingProf, existing)) {
          profStore.put(incomingProf)
          profMap.set(incomingProf.personId, incomingProf)
          changed = true
        }
      }

      // 2. Process messages
      const existingMsgMap = new Map<string, StoredMessageInternal>()
      for (const m of existingMsgs || []) {
        existingMsgMap.set(m.id, m)
      }

      const newCandidates: StoredMessageInternal[] = []
      for (const msg of batchMsgMap.values()) {
        const orderKey = messageOrderKey(msg)
        if (meta.pruneCutoff && orderKey <= meta.pruneCutoff) {
          continue
        }

        const existing = existingMsgMap.get(msg.id)
        if (existing) {
          if (!areMessagesIdentical(existing, msg)) {
            throw new Error(
              `Message conflict: immutable message content mismatch for [${workspaceId}, ${msg.id}]`
            )
          }
          continue
        }

        const serializedBytes = getMessageRecordSerializedBytes(msg)
        newCandidates.push({
          ...msg,
          orderKey,
          serializedBytes,
        })
      }

      const allMsgs = [...(existingMsgs || []), ...newCandidates]
      allMsgs.sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0))

      const { retained, pruned, retainedIds } = computeRetention(allMsgs)

      // Delete any pruned messages that were in the DB
      for (const prunedMsg of pruned) {
        if (existingMsgMap.has(prunedMsg.id)) {
          msgStore.delete([workspaceId, prunedMsg.id])
        }
      }

      // Persist prune cutoff monotonically in the same transaction
      if (pruned.length > 0) {
        const latestPrunedKey = pruned[pruned.length - 1].orderKey
        meta.pruneCutoff =
          meta.pruneCutoff && meta.pruneCutoff > latestPrunedKey
            ? meta.pruneCutoff
            : latestPrunedKey
        metaStore.put(meta)
      }

      // Retain added messages
      const addedRetained: StoredChatMessage[] = []
      for (const candidate of newCandidates) {
        if (retainedIds.has(candidate.id)) {
          msgStore.put(candidate)
          addedRetained.push({
            id: candidate.id,
            workspaceId: candidate.workspaceId,
            personId: candidate.personId,
            createdAt: candidate.createdAt,
            body: candidate.body,
            record: candidate.record,
          })
        }
      }

      if (addedRetained.length > 0) {
        changed = true
      }

      return { added: addedRetained, changed }
    })
  }

  async readCursor(workspaceId: string): Promise<string | null> {
    if (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > MAX_STRING_FIELD_LENGTH) {
      throw new Error(`Invalid workspaceId: must be string between 1 and ${MAX_STRING_FIELD_LENGTH}`)
    }

    return this.runTx([STORE_META], "readonly", async (tx) => {
      const metaStore = tx.objectStore(STORE_META)
      const meta = await promisifyRequest<WorkspaceMetaInternal | undefined>(metaStore.get(workspaceId))
      return meta?.cursor ?? null
    })
  }

  async markRead(workspaceId: string, cursor: string): Promise<void> {
    if (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > MAX_STRING_FIELD_LENGTH) {
      throw new Error(`Invalid workspaceId: must be string between 1 and ${MAX_STRING_FIELD_LENGTH}`)
    }
    if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 512) {
      throw new Error("Invalid cursor: must be string between 1 and 512 characters")
    }

    return this.runTx([STORE_META], "readwrite", async (tx) => {
      const metaStore = tx.objectStore(STORE_META)
      const meta = await promisifyRequest<WorkspaceMetaInternal | undefined>(metaStore.get(workspaceId))
      const currentMeta: WorkspaceMetaInternal = meta || {
        workspaceId,
        cursor: null,
        pruneCutoff: null,
      }

      // Cursor monotonic: never moves backward
      if (currentMeta.cursor && cursor <= currentMeta.cursor) {
        return
      }

      currentMeta.cursor = cursor
      metaStore.put(currentMeta)
    })
  }
}

export const chatStore = new ChatStore()
