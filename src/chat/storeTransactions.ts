import {
  INDEX_MSG_WORKSPACE_ORDER,
  INDEX_PROF_WORKSPACE,
  MAX_WORKSPACE_PROFILES,
  STORE_MESSAGES,
  STORE_META,
  STORE_PROFILES,
  areMessagesIdentical,
  compareText,
  computeRetention,
  doesProfileWin,
  getMessageRecordSerializedBytes,
  messageOrderKey,
  type StoredChatMessage,
  type StoredChatProfile,
  type StoredMessageInternal,
  type WorkspaceMetaInternal,
} from "./storePolicy"

export function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error("IDBRequest error"))
  })
}

function defaultMeta(workspaceId: string): WorkspaceMetaInternal {
  return { workspaceId, cursor: null, pruneCutoff: null }
}

function updatePruneCutoff(
  metaStore: IDBObjectStore,
  meta: WorkspaceMetaInternal,
  pruned: StoredMessageInternal[]
): void {
  const latestPrunedKey = pruned.at(-1)?.orderKey
  if (!latestPrunedKey) return
  meta.pruneCutoff = meta.pruneCutoff && meta.pruneCutoff > latestPrunedKey ? meta.pruneCutoff : latestPrunedKey
  metaStore.put(meta)
}

function deletePruned(
  messageStore: IDBObjectStore,
  workspaceId: string,
  pruned: StoredMessageInternal[],
  existingIds: Set<string>
): void {
  for (const message of pruned) {
    if (existingIds.has(message.id)) messageStore.delete([workspaceId, message.id])
  }
}

export async function appendMessageTransaction(tx: IDBTransaction, message: StoredChatMessage): Promise<boolean> {
  const messageStore = tx.objectStore(STORE_MESSAGES)
  const metaStore = tx.objectStore(STORE_META)
  const orderKey = messageOrderKey(message)
  const internalMessage: StoredMessageInternal = {
    ...message,
    orderKey,
    serializedBytes: getMessageRecordSerializedBytes(message),
  }
  const range = IDBKeyRange.bound([message.workspaceId, ""], [message.workspaceId, "\uffff"])
  const [storedMeta, storedMessages] = await Promise.all([
    promisifyRequest<WorkspaceMetaInternal | undefined>(metaStore.get(message.workspaceId)),
    promisifyRequest<StoredMessageInternal[]>(messageStore.index(INDEX_MSG_WORKSPACE_ORDER).getAll(range)),
  ])
  const meta = storedMeta ?? defaultMeta(message.workspaceId)
  if (meta.pruneCutoff && orderKey <= meta.pruneCutoff) return false
  const existing = storedMessages.find((candidate) => candidate.id === message.id)
  if (existing && !areMessagesIdentical(existing, message)) {
    throw new Error(`Message conflict: immutable message content mismatch for [${message.workspaceId}, ${message.id}]`)
  }
  if (existing) return false

  const allMessages = [...storedMessages, internalMessage].sort((left, right) =>
    compareText(left.orderKey, right.orderKey)
  )
  const { pruned, retainedIds } = computeRetention(allMessages)
  deletePruned(messageStore, message.workspaceId, pruned, new Set(storedMessages.map((item) => item.id)))
  updatePruneCutoff(metaStore, meta, pruned)
  if (!retainedIds.has(message.id)) return false
  messageStore.put(internalMessage)
  return true
}

function mergeProfiles(
  profileStore: IDBObjectStore,
  existingProfiles: StoredChatProfile[],
  incomingProfiles: Map<string, StoredChatProfile>
): boolean {
  const profiles = new Map(existingProfiles.map((profile) => [profile.personId, profile]))
  let changed = false
  for (const incoming of incomingProfiles.values()) {
    const existing = profiles.get(incoming.personId)
    if (!existing && profiles.size >= MAX_WORKSPACE_PROFILES) {
      throw new Error(`Profile limit of ${MAX_WORKSPACE_PROFILES} exceeded for workspace`)
    }
    if (existing && !doesProfileWin(incoming, existing)) continue
    profileStore.put(incoming)
    profiles.set(incoming.personId, incoming)
    changed = true
  }
  return changed
}

function newMessageCandidates(
  workspaceId: string,
  incomingMessages: Map<string, StoredChatMessage>,
  existingMessages: Map<string, StoredMessageInternal>,
  pruneCutoff: string | null
): StoredMessageInternal[] {
  const candidates: StoredMessageInternal[] = []
  for (const message of incomingMessages.values()) {
    const orderKey = messageOrderKey(message)
    if (pruneCutoff && orderKey <= pruneCutoff) continue
    const existing = existingMessages.get(message.id)
    if (existing && !areMessagesIdentical(existing, message)) {
      throw new Error(`Message conflict: immutable message content mismatch for [${workspaceId}, ${message.id}]`)
    }
    if (existing) continue
    candidates.push({ ...message, orderKey, serializedBytes: getMessageRecordSerializedBytes(message) })
  }
  return candidates
}

function publicMessage(message: StoredMessageInternal): StoredChatMessage {
  return {
    id: message.id,
    workspaceId: message.workspaceId,
    personId: message.personId,
    createdAt: message.createdAt,
    body: message.body,
    record: message.record,
  }
}

function persistCandidates(
  messageStore: IDBObjectStore,
  candidates: StoredMessageInternal[],
  retainedIds: Set<string>
): StoredChatMessage[] {
  const added: StoredChatMessage[] = []
  for (const candidate of candidates) {
    if (!retainedIds.has(candidate.id)) continue
    messageStore.put(candidate)
    added.push(publicMessage(candidate))
  }
  return added
}

export async function mergeChatTransaction(
  tx: IDBTransaction,
  workspaceId: string,
  messageBatch: Map<string, StoredChatMessage>,
  profileBatch: Map<string, StoredChatProfile>
): Promise<{ added: StoredChatMessage[]; changed: boolean }> {
  const messageStore = tx.objectStore(STORE_MESSAGES)
  const profileStore = tx.objectStore(STORE_PROFILES)
  const metaStore = tx.objectStore(STORE_META)
  const messageRange = IDBKeyRange.bound([workspaceId, ""], [workspaceId, "\uffff"])
  const [storedMessages, storedProfiles, storedMeta] = await Promise.all([
    promisifyRequest<StoredMessageInternal[]>(messageStore.index(INDEX_MSG_WORKSPACE_ORDER).getAll(messageRange)),
    promisifyRequest<StoredChatProfile[]>(profileStore.index(INDEX_PROF_WORKSPACE).getAll(IDBKeyRange.only(workspaceId))),
    promisifyRequest<WorkspaceMetaInternal | undefined>(metaStore.get(workspaceId)),
  ])
  const meta = storedMeta ?? defaultMeta(workspaceId)
  const profilesChanged = mergeProfiles(profileStore, storedProfiles, profileBatch)
  const existingMessages = new Map(storedMessages.map((message) => [message.id, message]))
  const candidates = newMessageCandidates(workspaceId, messageBatch, existingMessages, meta.pruneCutoff)
  const allMessages = [...storedMessages, ...candidates].sort((left, right) =>
    compareText(left.orderKey, right.orderKey)
  )
  const { pruned, retainedIds } = computeRetention(allMessages)
  deletePruned(messageStore, workspaceId, pruned, new Set(existingMessages.keys()))
  updatePruneCutoff(metaStore, meta, pruned)
  const added = persistCandidates(messageStore, candidates, retainedIds)
  return { added, changed: profilesChanged || added.length > 0 }
}
