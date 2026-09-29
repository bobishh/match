import { inspectPairingFrame } from "@meta-uber/mesh-pairing"
import { createLiveWorkspaceSession } from "@meta-uber/mesh-runtime"
import { fromBase64Url } from "../domain/identity"
import { workspaceProofTransfer } from "./workspaceProofTransfer"
import type { WorkspaceSetStore, OwnerWorkspaceOfferFrame } from "./workspaceSet"
import type { DuplexStream, SyncConnection } from "./transport"

type Source = ReturnType<typeof workspaceProofTransfer>
type Pending = { manifest: string; source: Source }
const pending = new WeakMap<SyncConnection, Map<string, Pending>>()

export async function publishOwnerWorkspaceOffer(connection: SyncConnection, secret: string, bytes: Uint8Array,
  frame: OwnerWorkspaceOfferFrame): Promise<void> {
  const protocol = createLiveWorkspaceSession("owner-offer", secret)
  try {
    let outgoing = protocol.encode(frame, bytes)
    for (let round = 0; round <= 4096; round++) {
      const response = await exchangeOwnerFrame(connection, outgoing, round === 0 ? 600_000 : 20_000)
      if (inspectPairingFrame(response).type !== "mesh-proof-request-v1") {
        protocol.verifySavedReceipt(response, bytes)
        return
      }
      if (round === 4096) throw new Error("Owner proof reply limit exceeded")
      let page: Uint8Array | undefined
      const handled = await serveOwnerOfferProofs(connection, secret, {
        send: async value => { page = value }, closeSend: async () => {},
        read: async () => { throw new Error("Owner proof source cannot read") },
      }, response)
      if (!handled || !page) throw new Error("Native requested proofs outside approved owner offer")
      outgoing = page
    }
    throw new Error("Owner proof reply limit exceeded")
  } finally { protocol.free?.() }
}

async function exchangeOwnerFrame(connection: SyncConnection, frame: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([(async () => {
      const stream = await connection.openStream()
      await stream.send(frame)
      await stream.closeSend()
      return stream.read()
    })(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Owner delivery is unconfirmed; retry the same offer")), timeoutMs)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

/** Called only after the authenticated owner/future-board policy approves an
 * outgoing offer. Requests can read only its exact frozen manifest on this
 * connection and existing transport secret, never an arbitrary workspace. */
export async function registerOwnerOfferProofs(connection: SyncConnection, secret: string,
  bytes: Uint8Array, store: WorkspaceSetStore): Promise<() => void> {
  const offer = JSON.parse(new TextDecoder().decode(bytes)) as {
    workspaceId: string; workspace: { id: string; bytes: string; authorization?: { kind?: string; transferId?: string } }
  }
  const manifest = offer.workspace.authorization
  if (manifest?.kind !== "workspace-authorization-manifest") return () => {}
  if (offer.workspace.id !== offer.workspaceId || !manifest.transferId || !store.readAuthorization) {
    throw new Error("Invalid approved owner proof source")
  }
  const document = fromBase64Url(offer.workspace.bytes)
  const authorization = await store.readAuthorization(document, offer.workspaceId)
  const source = workspaceProofTransfer({ ...store,
    read: async id => {
      if (id !== offer.workspaceId) throw new Error("Proof workspace outside approved owner offer")
      return document
    },
    readAuthorization: async () => authorization,
  }, [offer.workspaceId])
  const key = `${secret}\0${manifest.transferId}`
  const entries = pending.get(connection) ?? new Map<string, Pending>()
  if (entries.has(key)) throw new Error("Owner proof transfer already pending")
  const entry = { manifest: canonical(manifest), source }
  entries.set(key, entry)
  pending.set(connection, entries)
  return () => {
    if (entries.get(key) === entry) entries.delete(key)
    source.closeProofSources()
  }
}

export async function serveOwnerOfferProofs(connection: SyncConnection, secret: string,
  stream: DuplexStream, frame: Uint8Array): Promise<boolean> {
  const header = inspectPairingFrame(frame)
  if (header.type !== "mesh-proof-request-v1") return false
  if (header.secret !== secret || frame.length > 256 * 1024) throw new Error("Unauthorized owner proof request")
  const request = JSON.parse(new TextDecoder().decode(frame.subarray(frame.indexOf(10) + 1))) as {
    manifest?: { transferId?: string }
  }
  const entry = pending.get(connection)?.get(`${secret}\0${request.manifest?.transferId}`)
  if (!entry) return false
  if (canonical(request.manifest) !== entry.manifest) throw new Error("Owner proof request changed approved manifest")
  return entry.source.serveProofPage(frame, stream, secret)
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
}
