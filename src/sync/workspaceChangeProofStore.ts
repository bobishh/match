import { canonicalizeJson, type SignedEnvelope } from "../domain/identity"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"

export type WorkspaceChangeAuthorization = {
  signed: SignedEnvelope<{ kind: "workspace-changes"; version: 1; workspaceId: string; hashes: string[]; personId: string; deviceId: string }>
  publicKey: string
  certificates: DeviceCertificate[]
  grant?: WorkspaceGrant
  ownerPublicKey: string
  ownerCertificates: DeviceCertificate[]
}

let dbPromise: Promise<IDBDatabase> | undefined
const memory = new Map<string, WorkspaceChangeAuthorization[]>()

function database() {
  return dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("match-write-authorizations-v1")
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("records")) request.result.createObjectStore("records")
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function records(workspaceId: string): Promise<WorkspaceChangeAuthorization[]> {
  if (typeof indexedDB === "undefined") return memory.get(workspaceId) ?? []
  const db = await database()
  return new Promise((resolve, reject) => {
    const request = db.transaction("records").objectStore("records").get(workspaceId)
    request.onsuccess = () => resolve(request.result ?? [])
    request.onerror = () => reject(request.error)
  })
}

function canonicalChoice<T>(left: T, right: T): T {
  return canonicalizeJson(left) <= canonicalizeJson(right) ? left : right
}

function mergeCertificates(left: DeviceCertificate[] | undefined, right: DeviceCertificate[] | undefined): DeviceCertificate[] {
  const merged = new Map<string, DeviceCertificate>()
  for (const certificate of [...(left ?? []), ...(right ?? [])]) {
    const current = merged.get(certificate.signature)
    merged.set(certificate.signature, current ? canonicalChoice(current, certificate) : certificate)
  }
  return [...merged.values()].sort((a, b) => a.signature.localeCompare(b.signature))
}

function mergeRequiredText(left: string | undefined, right: string | undefined): string {
  if (!left) return right ?? ""
  if (!right) return left
  return canonicalChoice(left, right)
}

function mergeAuthorization(current: WorkspaceChangeAuthorization, incoming: WorkspaceChangeAuthorization): WorkspaceChangeAuthorization {
  return { signed: canonicalChoice(current.signed, incoming.signed), publicKey: canonicalChoice(current.publicKey, incoming.publicKey),
    certificates: mergeCertificates(current.certificates, incoming.certificates),
    ...(current.grant || incoming.grant ? { grant: current.grant && incoming.grant ? canonicalChoice(current.grant, incoming.grant) : current.grant ?? incoming.grant } : {}),
    ownerPublicKey: mergeRequiredText(current.ownerPublicKey, incoming.ownerPublicKey),
    ownerCertificates: mergeCertificates(current.ownerCertificates, incoming.ownerCertificates) }
}

function merged(existing: WorkspaceChangeAuthorization[], incoming: WorkspaceChangeAuthorization[]) {
  const result = new Map<string, WorkspaceChangeAuthorization>()
  for (const record of [...existing, ...incoming]) {
    const current = result.get(record.signed.signature)
    result.set(record.signed.signature, current ? mergeAuthorization(current, record) : record)
  }
  return [...result.values()].sort((left, right) => left.signed.signature.localeCompare(right.signed.signature))
}

export async function putRecords(workspaceId: string, incoming: WorkspaceChangeAuthorization[]): Promise<boolean> {
  if (typeof indexedDB === "undefined") {
    const existing = memory.get(workspaceId) ?? []
    const next = merged(existing, incoming)
    const changed = canonicalizeJson(existing) !== canonicalizeJson(next)
    if (changed) memory.set(workspaceId, next)
    return changed
  }
  const db = await database()
  return new Promise<boolean>((resolve, reject) => {
    let changed = false
    const transaction = db.transaction("records", "readwrite")
    const store = transaction.objectStore("records")
    const get = store.get(workspaceId)
    get.onsuccess = () => {
      const existing = get.result ?? [] as WorkspaceChangeAuthorization[]
      const next = merged(existing, incoming)
      changed = canonicalizeJson(existing) !== canonicalizeJson(next)
      if (changed) store.put(next, workspaceId)
    }
    transaction.oncomplete = () => resolve(changed)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}
