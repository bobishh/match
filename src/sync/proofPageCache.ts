// Untrusted transfer staging. Document admission rechecks every cached record.
// Cache eviction affects retry cost only; durable authority is never removed.
const MAX_CACHE_BYTES = 64 * 1024 * 1024
const MAX_PAGE_BYTES = 256 * 1024
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000
type Meta = { id: string; workspaceId: string; addedAt: number; byteLength: number }
const memory = new Map<string, { meta: Meta; bytes: Uint8Array }>()
let opening: Promise<IDBDatabase> | undefined

function database(): Promise<IDBDatabase> {
  return opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("match-proof-page-cache-v1", 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore("pages", { keyPath: "id" })
      request.result.createObjectStore("metadata", { keyPath: "id" })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { opening = undefined; reject(request.error) }
  })
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("Proof staging aborted"))
  })
}
export async function readProofPage(workspaceId: string, key: string): Promise<Uint8Array | undefined> {
  const id = `${workspaceId}:${key}`
  if (typeof indexedDB === "undefined") return memory.get(id)?.bytes.slice()
  const transaction = (await database()).transaction("pages", "readonly")
  const completion = done(transaction)
  const page = await result(transaction.objectStore("pages").get(id)) as { bytes: Uint8Array } | undefined
  await completion
  return page?.bytes
}
export async function writeProofPage(workspaceId: string, key: string, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > MAX_PAGE_BYTES) throw new Error("Proof staging page exceeds size limit")
  const id = `${workspaceId}:${key}`
  const meta: Meta = { id, workspaceId, byteLength: bytes.byteLength, addedAt: Date.now() }
  if (typeof indexedDB === "undefined") {
    memory.set(id, { meta, bytes: bytes.slice() })
    let total = [...memory.values()].reduce((sum, page) => sum + page.meta.byteLength, 0)
    for (const [oldId, page] of memory) {
      if (total <= MAX_CACHE_BYTES && page.meta.addedAt >= meta.addedAt - MAX_CACHE_AGE_MS) continue
      memory.delete(oldId)
      total -= page.meta.byteLength
    }
    return
  }
  const transaction = (await database()).transaction(["pages", "metadata"], "readwrite")
  const completion = done(transaction)
  const metadata = transaction.objectStore("metadata")
  const entries = await result(metadata.getAll()) as Meta[]
  let total = bytes.byteLength + entries.filter(entry => entry.id !== id).reduce((sum, entry) => sum + entry.byteLength, 0)
  for (const entry of entries.sort((left, right) => left.addedAt - right.addedAt)) {
    if (entry.id === id || (total <= MAX_CACHE_BYTES && entry.addedAt >= meta.addedAt - MAX_CACHE_AGE_MS)) continue
    transaction.objectStore("pages").delete(entry.id)
    metadata.delete(entry.id)
    total -= entry.byteLength
  }
  transaction.objectStore("pages").put({ id, bytes: bytes.slice() })
  metadata.put(meta)
  await completion
}
export async function clearProofPages(workspaceId: string): Promise<void> {
  if (typeof indexedDB === "undefined") {
    for (const [id, page] of memory) if (page.meta.workspaceId === workspaceId) memory.delete(id)
    return
  }
  const transaction = (await database()).transaction(["pages", "metadata"], "readwrite")
  const completion = done(transaction)
  const metadata = transaction.objectStore("metadata")
  for (const entry of await result(metadata.getAll()) as Meta[]) {
    if (entry.workspaceId !== workspaceId) continue
    metadata.delete(entry.id)
    transaction.objectStore("pages").delete(entry.id)
  }
  await completion
}
