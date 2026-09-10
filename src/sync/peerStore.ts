/**
 * PeerStore: Robust IndexedDB peer catalog and local node secret storage.
 *
 * Requirements:
 * - Persistent local 32-byte node secret
 * - Workspace peer records keyed by [workspaceId, deviceId]
 * - Endpoint, person/device IDs, per-peer transport secret, role (owner/editor)
 * - Monotonic lastSeen and optional revokedAt
 * - Deterministic merge/upsert with canonical tie-breaking
 * - Strictly IndexedDB: zero secrets or data in localStorage
 * - Strong validation and transactional completion (durability)
 */

export type PeerRole = "owner" | "editor"

export interface WorkspacePeerRecord {
  workspaceId: string
  deviceId: string
  personId: string
  endpoint: string
  transportSecret: string | Uint8Array
  role: PeerRole
  lastSeen: string // ISO 8601 string
  revokedAt?: string | null // optional ISO 8601 string or null
  advertisement?: unknown
}

export interface WorkspaceMeshCredential {
  version: 1
  workspaceId: string
  ownerPersonId: string
  ownerPublicKey: string
  transportSecret: string
  epoch: number
  updatedAt: string
  localGrant?: unknown
  ownerCertificates: unknown[]
  catalog?: unknown
}

export const DEFAULT_PEER_DB_NAME = "match-peer-catalog-v1"
export const STORE_PEERS = "peers"
export const STORE_NODE = "node"

export const INDEX_PEERS_WORKSPACE = "by_workspace"
export const INDEX_PEERS_DEVICE = "by_device"
export const INDEX_PEERS_LAST_SEEN = "by_last_seen"

const NODE_SECRET_KEY = "localNodeSecret"
const WORKSPACE_CREDENTIAL_PREFIX = "workspace:"

export const MAX_STRING_LENGTH = 256
export const MAX_ENDPOINT_LENGTH = 2048
export const MAX_SECRET_LENGTH = 4096
export const MAX_AUTH_BUNDLE_LENGTH = 131072

export function validateWorkspaceCredential(value: unknown): asserts value is WorkspaceMeshCredential {
  const item = value as WorkspaceMeshCredential
  if (!item || item.version !== 1 || typeof item.workspaceId !== "string" || !item.workspaceId || item.workspaceId.length > MAX_STRING_LENGTH ||
    typeof item.ownerPersonId !== "string" || !item.ownerPersonId || item.ownerPersonId.length > MAX_STRING_LENGTH ||
    typeof item.ownerPublicKey !== "string" || !item.ownerPublicKey || item.ownerPublicKey.length > MAX_SECRET_LENGTH ||
    typeof item.transportSecret !== "string" || !item.transportSecret || item.transportSecret.length > MAX_SECRET_LENGTH ||
    !Number.isSafeInteger(item.epoch) || item.epoch < 1 ||
    typeof item.updatedAt !== "string" || Number.isNaN(Date.parse(item.updatedAt)) ||
    !Array.isArray(item.ownerCertificates) || item.ownerCertificates.length > 32 ||
    new TextEncoder().encode(JSON.stringify(item)).byteLength > MAX_AUTH_BUNDLE_LENGTH) {
    throw new Error("Invalid workspace mesh credential")
  }
}

/**
 * Validates that a node secret is a 32-byte Uint8Array.
 */
export function validateNodeSecret(secret: unknown): asserts secret is Uint8Array {
  const isUint8 =
    secret instanceof Uint8Array ||
    (typeof secret === "object" && secret !== null && (secret as { constructor?: { name?: string } }).constructor?.name === "Uint8Array")

  if (!isUint8) {
    throw new Error("Invalid node secret: must be a Uint8Array of exactly 32 bytes")
  }
  if ((secret as Uint8Array).byteLength !== 32) {
    throw new Error("Invalid node secret: must be a Uint8Array of exactly 32 bytes")
  }
}

/**
 * Validates all fields of a WorkspacePeerRecord.
 */
export function validatePeerRecord(peer: unknown): asserts peer is WorkspacePeerRecord {
  if (typeof peer !== "object" || peer === null) {
    throw new Error("Invalid peer record: must be a non-null object")
  }
  const r = peer as Record<string, unknown>

  if (typeof r.workspaceId !== "string" || r.workspaceId.trim().length === 0 || r.workspaceId.length > MAX_STRING_LENGTH) {
    throw new Error(`Invalid peer record: workspaceId must be a non-empty string <= ${MAX_STRING_LENGTH} characters`)
  }
  if (typeof r.deviceId !== "string" || r.deviceId.trim().length === 0 || r.deviceId.length > MAX_STRING_LENGTH) {
    throw new Error(`Invalid peer record: deviceId must be a non-empty string <= ${MAX_STRING_LENGTH} characters`)
  }
  if (typeof r.personId !== "string" || r.personId.trim().length === 0 || r.personId.length > MAX_STRING_LENGTH) {
    throw new Error(`Invalid peer record: personId must be a non-empty string <= ${MAX_STRING_LENGTH} characters`)
  }
  if (typeof r.endpoint !== "string" || r.endpoint.trim().length === 0 || r.endpoint.length > MAX_ENDPOINT_LENGTH) {
    throw new Error(`Invalid peer record: endpoint must be a non-empty string <= ${MAX_ENDPOINT_LENGTH} characters`)
  }

  const isSecretString = typeof r.transportSecret === "string" && r.transportSecret.length > 0 && r.transportSecret.length <= MAX_SECRET_LENGTH
  const isSecretBytes = r.transportSecret instanceof Uint8Array && r.transportSecret.byteLength > 0 && r.transportSecret.byteLength <= MAX_SECRET_LENGTH
  if (!isSecretString && !isSecretBytes) {
    throw new Error(`Invalid peer record: transportSecret must be a non-empty string or Uint8Array <= ${MAX_SECRET_LENGTH} bytes`)
  }

  if (r.role !== "owner" && r.role !== "editor") {
    throw new Error("Invalid peer record: role must be 'owner' or 'editor'")
  }

  if (typeof r.lastSeen !== "string" || Number.isNaN(Date.parse(r.lastSeen))) {
    throw new Error("Invalid peer record: lastSeen must be a valid ISO 8601 date string")
  }

  if (r.revokedAt !== undefined && r.revokedAt !== null) {
    if (typeof r.revokedAt !== "string" || Number.isNaN(Date.parse(r.revokedAt))) {
      throw new Error("Invalid peer record: revokedAt must be a valid ISO 8601 date string or null/undefined")
    }
  }
  if (r.advertisement !== undefined && new TextEncoder().encode(JSON.stringify(r.advertisement)).byteLength > MAX_AUTH_BUNDLE_LENGTH) {
    throw new Error("Invalid peer record: advertisement is too large")
  }
}

/**
 * Deterministically serializes a value to canonical JSON.
 */
export function canonicalJson(val: unknown, seen = new Set<unknown>()): string {
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
  if (val instanceof Uint8Array) {
    let bin = ""
    for (let i = 0; i < val.byteLength; i++) {
      bin += String.fromCharCode(val[i])
    }
    return JSON.stringify(btoa(bin))
  }
  if (typeof val === "object") {
    if (seen.has(val)) {
      throw new TypeError("Circular reference detected")
    }
    seen.add(val)
    try {
      if (Array.isArray(val)) {
        const items = val.map((item) => (item === undefined ? "null" : canonicalJson(item, seen)))
        return `[${items.join(",")}]`
      }
      const obj = val as Record<string, unknown>
      const keys = Object.keys(obj).sort()
      const entries: string[] = []
      for (const key of keys) {
        const v = obj[key]
        if (v !== undefined && typeof v !== "function" && typeof v !== "symbol") {
          entries.push(`${JSON.stringify(key)}:${canonicalJson(v, seen)}`)
        }
      }
      return `{${entries.join(",")}}`
    } finally {
      seen.delete(val)
    }
  }
  return "null"
}

/**
 * Deterministically merges an existing peer record with an incoming update.
 *
 * Rules:
 * - workspaceId and deviceId must match
 * - lastSeen: monotonic progression (maximum timestamp)
 * - role: owner priority on tie, otherwise newer timestamp wins
 * - endpoint & transportSecret: newer timestamp wins, or deterministic tie-break
 * - revokedAt: once revoked, stays revoked unless explicitly unrevoked (null).
 *   If both have revokedAt, earliest revocation date is preserved.
 */
export function mergePeerRecords(
  existing: WorkspacePeerRecord,
  incoming: WorkspacePeerRecord
): WorkspacePeerRecord {
  validatePeerRecord(existing)
  validatePeerRecord(incoming)

  if (existing.workspaceId !== incoming.workspaceId) {
    throw new Error(
      `Cannot merge peer records from different workspaces: ${existing.workspaceId} vs ${incoming.workspaceId}`
    )
  }
  if (existing.deviceId !== incoming.deviceId) {
    throw new Error(
      `Cannot merge peer records with different deviceIds: ${existing.deviceId} vs ${incoming.deviceId}`
    )
  }

  const existingTime = new Date(existing.lastSeen).getTime()
  const incomingTime = new Date(incoming.lastSeen).getTime()
  const isIncomingNewer = incomingTime > existingTime

  // Deterministic tie-breaking if timestamps match
  const incomingJson = canonicalJson(incoming)
  const existingJson = canonicalJson(existing)
  const incomingWinsTie = incomingJson > existingJson

  const incomingDominates = isIncomingNewer || (incomingTime === existingTime && incomingWinsTie)

  // 1. Monotonic lastSeen
  const lastSeen = incomingTime >= existingTime ? incoming.lastSeen : existing.lastSeen

  // 2. personId
  let personId: string
  if (isIncomingNewer) {
    personId = incoming.personId
  } else if (existingTime > incomingTime) {
    personId = existing.personId
  } else {
    personId = incoming.personId >= existing.personId ? incoming.personId : existing.personId
  }

  // 3. endpoint
  const endpoint = incomingDominates ? incoming.endpoint : existing.endpoint

  // 4. transportSecret
  let transportSecret: string | Uint8Array
  if (incomingDominates) {
    transportSecret = incoming.transportSecret instanceof Uint8Array
      ? new Uint8Array(incoming.transportSecret)
      : incoming.transportSecret
  } else {
    transportSecret = existing.transportSecret instanceof Uint8Array
      ? new Uint8Array(existing.transportSecret)
      : existing.transportSecret
  }

  // 5. role
  let role: PeerRole
  if (isIncomingNewer) {
    role = incoming.role
  } else if (existingTime > incomingTime) {
    role = existing.role
  } else {
    // Tied timestamp: owner takes priority over editor
    role = existing.role === "owner" || incoming.role === "owner" ? "owner" : "editor"
  }

  // 6. revokedAt
  let revokedAt: string | null | undefined
  if (incoming.revokedAt === null && incomingDominates) {
    // Explicit un-revocation by a dominating update
    revokedAt = null
  } else if (existing.revokedAt && incoming.revokedAt) {
    const extRevTime = new Date(existing.revokedAt).getTime()
    const incRevTime = new Date(incoming.revokedAt).getTime()
    revokedAt = incRevTime <= extRevTime ? incoming.revokedAt : existing.revokedAt
  } else if (existing.revokedAt) {
    revokedAt = existing.revokedAt
  } else if (incoming.revokedAt) {
    revokedAt = incoming.revokedAt
  } else {
    revokedAt = undefined
  }

  const merged: WorkspacePeerRecord = {
    workspaceId: existing.workspaceId,
    deviceId: existing.deviceId,
    personId,
    endpoint,
    transportSecret,
    role,
    lastSeen,
    ...(incomingDominates
      ? (incoming.advertisement === undefined ? {} : { advertisement: structuredClone(incoming.advertisement) })
      : (existing.advertisement === undefined ? {} : { advertisement: structuredClone(existing.advertisement) })),
  }

  if (revokedAt !== undefined && revokedAt !== null) {
    merged.revokedAt = revokedAt
  } else if (revokedAt === null) {
    merged.revokedAt = null
  }

  return merged
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error("IndexedDB request failed"))
  })
}

export class PeerStore {
  private readonly dbName: string
  private readonly idbFactory?: IDBFactory
  private dbInstance: IDBDatabase | null = null

  constructor(dbName: string = DEFAULT_PEER_DB_NAME, idbFactory?: IDBFactory) {
    this.dbName = dbName
    this.idbFactory = idbFactory
  }

  private getIdb(): IDBFactory {
    if (this.idbFactory) {
      return this.idbFactory
    }
    if (typeof indexedDB !== "undefined" && indexedDB) {
      return indexedDB
    }
    throw new Error("IndexedDB is not available in this environment")
  }

  private openDb(): Promise<IDBDatabase> {
    const idb = this.getIdb()
    return new Promise((resolve, reject) => {
      const request = idb.open(this.dbName, 1)

      request.onblocked = () => {
        reject(new Error(`IndexedDB open blocked for database ${this.dbName}`))
      }

      request.onerror = () => {
        reject(request.error || new Error(`Failed to open IndexedDB ${this.dbName}`))
      }

      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_PEERS)) {
          const peerStore = db.createObjectStore(STORE_PEERS, {
            keyPath: ["workspaceId", "deviceId"],
          })
          peerStore.createIndex(INDEX_PEERS_WORKSPACE, "workspaceId", { unique: false })
          peerStore.createIndex(INDEX_PEERS_DEVICE, "deviceId", { unique: false })
          peerStore.createIndex(INDEX_PEERS_LAST_SEEN, "lastSeen", { unique: false })
        }
        if (!db.objectStoreNames.contains(STORE_NODE)) {
          db.createObjectStore(STORE_NODE, { keyPath: "key" })
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
   * Executes an atomic IndexedDB transaction.
   * Resolves only after tx.oncomplete fires (durability guarantee).
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

  /**
   * Retrieves the persistent local 32-byte node secret, or null if not yet created.
   */
  async getNodeSecret(): Promise<Uint8Array | null> {
    return this.runTx([STORE_NODE], "readonly", async (tx) => {
      const store = tx.objectStore(STORE_NODE)
      const record = await promisifyRequest<{ key: string; secret: Uint8Array }>(store.get(NODE_SECRET_KEY))
      if (!record || !record.secret) {
        return null
      }
      validateNodeSecret(record.secret)
      return new Uint8Array(record.secret)
    })
  }

  /**
   * Sets or overrides the persistent local 32-byte node secret.
   */
  async setNodeSecret(secret: Uint8Array): Promise<void> {
    validateNodeSecret(secret)
    await this.runTx([STORE_NODE], "readwrite", async (tx) => {
      const store = tx.objectStore(STORE_NODE)
      await promisifyRequest(
        store.put({
          key: NODE_SECRET_KEY,
          secret: new Uint8Array(secret),
          updatedAt: new Date().toISOString(),
        })
      )
    })
  }

  /**
   * Gets the persistent local 32-byte node secret, generating and persisting a new one if absent.
   */
  async getOrCreateNodeSecret(): Promise<Uint8Array> {
    const existing = await this.getNodeSecret()
    if (existing) {
      return existing
    }

    const newSecret = new Uint8Array(32)
    crypto.getRandomValues(newSecret)

    return this.runTx([STORE_NODE], "readwrite", async (tx) => {
      const store = tx.objectStore(STORE_NODE)
      const current = await promisifyRequest<{ key: string; secret: Uint8Array }>(store.get(NODE_SECRET_KEY))
      if (current && current.secret) {
        validateNodeSecret(current.secret)
        return new Uint8Array(current.secret)
      }

      await promisifyRequest(
        store.put({
          key: NODE_SECRET_KEY,
          secret: new Uint8Array(newSecret),
          createdAt: new Date().toISOString(),
        })
      )
      return new Uint8Array(newSecret)
    })
  }

  async getWorkspaceCredential(workspaceId: string): Promise<WorkspaceMeshCredential | null> {
    if (!workspaceId) throw new Error("Invalid workspaceId")
    return this.runTx([STORE_NODE], "readonly", async tx => {
      const record = await promisifyRequest<{ key: string; credential: WorkspaceMeshCredential } | undefined>(
        tx.objectStore(STORE_NODE).get(`${WORKSPACE_CREDENTIAL_PREFIX}${workspaceId}`)
      )
      if (!record) return null
      validateWorkspaceCredential(record.credential)
      return structuredClone(record.credential)
    })
  }

  async putWorkspaceCredential(credential: WorkspaceMeshCredential): Promise<void> {
    validateWorkspaceCredential(credential)
    await this.runTx([STORE_NODE], "readwrite", async tx => {
      const store = tx.objectStore(STORE_NODE)
      const key = `${WORKSPACE_CREDENTIAL_PREFIX}${credential.workspaceId}`
      const current = await promisifyRequest<{ key: string; credential: WorkspaceMeshCredential } | undefined>(store.get(key))
      if (current) {
        validateWorkspaceCredential(current.credential)
        if (current.credential.ownerPersonId !== credential.ownerPersonId) throw new Error("Workspace mesh owner cannot change")
        if (credential.epoch < current.credential.epoch) return
        if (credential.epoch === current.credential.epoch && credential.updatedAt < current.credential.updatedAt) return
      }
      await promisifyRequest(store.put({ key, credential: structuredClone(credential) }))
    })
  }

  async listWorkspaceCredentials(): Promise<WorkspaceMeshCredential[]> {
    return this.runTx([STORE_NODE], "readonly", async tx => {
      const records = await promisifyRequest<Array<{ key: string; credential?: WorkspaceMeshCredential }>>(tx.objectStore(STORE_NODE).getAll())
      const result: WorkspaceMeshCredential[] = []
      for (const record of records) {
        if (!record.key.startsWith(WORKSPACE_CREDENTIAL_PREFIX) || !record.credential) continue
        validateWorkspaceCredential(record.credential)
        result.push(structuredClone(record.credential))
      }
      return result.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
    })
  }

  /**
   * Retrieves a single workspace peer record by compound key [workspaceId, deviceId].
   */
  async getPeer(workspaceId: string, deviceId: string): Promise<WorkspacePeerRecord | null> {
    if (typeof workspaceId !== "string" || !workspaceId) {
      throw new Error("Invalid workspaceId")
    }
    if (typeof deviceId !== "string" || !deviceId) {
      throw new Error("Invalid deviceId")
    }

    return this.runTx([STORE_PEERS], "readonly", async (tx) => {
      const store = tx.objectStore(STORE_PEERS)
      const record = await promisifyRequest<WorkspacePeerRecord | undefined>(
        store.get([workspaceId, deviceId])
      )
      return record ?? null
    })
  }

  /**
   * Atomically upserts a peer record, deterministically merging with any existing record.
   */
  async upsertPeer(peer: WorkspacePeerRecord): Promise<WorkspacePeerRecord> {
    validatePeerRecord(peer)

    return this.runTx([STORE_PEERS], "readwrite", async (tx) => {
      const store = tx.objectStore(STORE_PEERS)
      const existing = await promisifyRequest<WorkspacePeerRecord | undefined>(
        store.get([peer.workspaceId, peer.deviceId])
      )

      const merged = existing ? mergePeerRecords(existing, peer) : {
        ...peer,
        transportSecret: peer.transportSecret instanceof Uint8Array
          ? new Uint8Array(peer.transportSecret)
          : peer.transportSecret,
      }

      await promisifyRequest(store.put(merged))
      return merged
    })
  }

  /**
   * Bulk deterministic merge/upsert of multiple peer records in a single transaction.
   */
  async mergePeers(peers: WorkspacePeerRecord[]): Promise<WorkspacePeerRecord[]> {
    for (const peer of peers) {
      validatePeerRecord(peer)
    }

    if (peers.length === 0) return []

    return this.runTx([STORE_PEERS], "readwrite", async (tx) => {
      const store = tx.objectStore(STORE_PEERS)
      const results: WorkspacePeerRecord[] = []

      for (const peer of peers) {
        const existing = await promisifyRequest<WorkspacePeerRecord | undefined>(
          store.get([peer.workspaceId, peer.deviceId])
        )
        const merged = existing ? mergePeerRecords(existing, peer) : {
          ...peer,
          transportSecret: peer.transportSecret instanceof Uint8Array
            ? new Uint8Array(peer.transportSecret)
            : peer.transportSecret,
        }
        await promisifyRequest(store.put(merged))
        results.push(merged)
      }

      return results
    })
  }

  /**
   * Lists peers for a given workspaceId, or across all workspaces if omitted.
   * Returns records sorted deterministically by workspaceId then deviceId.
   */
  async listPeers(workspaceId?: string): Promise<WorkspacePeerRecord[]> {
    return this.runTx([STORE_PEERS], "readonly", async (tx) => {
      const store = tx.objectStore(STORE_PEERS)
      let list: WorkspacePeerRecord[]

      if (workspaceId !== undefined) {
        if (typeof workspaceId !== "string" || !workspaceId) {
          throw new Error("Invalid workspaceId")
        }
        const index = store.index(INDEX_PEERS_WORKSPACE)
        list = await promisifyRequest<WorkspacePeerRecord[]>(index.getAll(workspaceId))
      } else {
        list = await promisifyRequest<WorkspacePeerRecord[]>(store.getAll())
      }

      return list.sort((a, b) => {
        if (a.workspaceId !== b.workspaceId) {
          return a.workspaceId.localeCompare(b.workspaceId)
        }
        return a.deviceId.localeCompare(b.deviceId)
      })
    })
  }

  /**
   * Removes a peer record by workspaceId and deviceId.
   * Returns true if existed and removed, false if not found.
   */
  async removePeer(workspaceId: string, deviceId: string): Promise<boolean> {
    if (typeof workspaceId !== "string" || !workspaceId) {
      throw new Error("Invalid workspaceId")
    }
    if (typeof deviceId !== "string" || !deviceId) {
      throw new Error("Invalid deviceId")
    }

    return this.runTx([STORE_PEERS], "readwrite", async (tx) => {
      const store = tx.objectStore(STORE_PEERS)
      const existing = await promisifyRequest<WorkspacePeerRecord | undefined>(
        store.get([workspaceId, deviceId])
      )
      if (!existing) {
        return false
      }
      await promisifyRequest(store.delete([workspaceId, deviceId]))
      return true
    })
  }

  /**
   * Clears peers for a specific workspace, or all peers if omitted.
   */
  async clearPeers(workspaceId?: string): Promise<void> {
    return this.runTx([STORE_PEERS], "readwrite", async (tx) => {
      const store = tx.objectStore(STORE_PEERS)
      if (workspaceId !== undefined) {
        if (typeof workspaceId !== "string" || !workspaceId) {
          throw new Error("Invalid workspaceId")
        }
        const index = store.index(INDEX_PEERS_WORKSPACE)
        const items = await promisifyRequest<WorkspacePeerRecord[]>(index.getAll(workspaceId))
        for (const item of items) {
          await promisifyRequest(store.delete([item.workspaceId, item.deviceId]))
        }
      } else {
        await promisifyRequest(store.clear())
      }
    })
  }

  /**
   * Clears all stores (peers and node secret). Useful for test isolation.
   */
  async clearAll(): Promise<void> {
    return this.runTx([STORE_PEERS, STORE_NODE], "readwrite", async (tx) => {
      const peerStore = tx.objectStore(STORE_PEERS)
      const nodeStore = tx.objectStore(STORE_NODE)
      await promisifyRequest(peerStore.clear())
      await promisifyRequest(nodeStore.clear())
    })
  }

  /**
   * Alias for clearAll().
   */
  async clear(): Promise<void> {
    return this.clearAll()
  }

  /**
   * Closes any open IndexedDB database connection.
   */
  close(): void {
    if (this.dbInstance) {
      try {
        this.dbInstance.close()
      } catch {}
      this.dbInstance = null
    }
  }
}

export const peerStore = new PeerStore()
