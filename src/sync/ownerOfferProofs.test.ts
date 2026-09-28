import { beforeAll, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { encodePairingFrame, decodePairingFrame, inspectPairingFrame } from "@meta-uber/mesh-pairing"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, signEnvelope } from "../domain/identity"
import { createWorkspaceDoc } from "../domain/seeds"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { computeWorkspaceAdmission, type IncomingAuthorizationBundle } from "./workspaceAdmissionCore"
import { liveAutomergeWorkspaceSync, workspaceSet } from "./workspaceSet"
import { registerOwnerOfferProofs, serveOwnerOfferProofs } from "./ownerOfferProofs"
import { clearProofPages } from "./proofPageCache"
import { publishConfirmedToSessions } from "./durableMeshOwnershipScope"
import type { SyncConnection } from "./transport"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

async function fixture(corruption?: "missing" | "forged") {
  resetIdentityStorageForTest()
  const owner = await bootstrapIdentity("Owner")
  let doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Future", owner.identity.personId, "blank"))
  const records: unknown[] = []
  for (let index = 0; index < 100; index++) {
    if (index) doc = Automerge.change(doc, draft => { draft.title = `Future ${index}` })
    const hash = Automerge.decodeChange(Automerge.getLastLocalChange(doc)!).hash
    const signed = await signEnvelope(owner.privateKeys.devicePrivateKey, {
      kind: "workspace-changes", version: 1, workspaceId: doc.id,
      personId: owner.identity.personId, deviceId: owner.device.deviceId, hashes: [hash],
    }, owner.device.deviceId)
    records.push({ signed, publicKey: owner.identity.publicKey, certificates: [owner.certificate] })
  }
  const authorityOwner = { personId: owner.identity.personId, publicKey: owner.identity.publicKey, certificates: [owner.certificate] }
  const authorization = { version: 1, records, authority: { genesisOwner: authorityOwner, genesisEpoch: 1,
    currentOwner: authorityOwner, currentEpoch: 1, ownershipTransfers: [], successionClaims: [],
    revocations: [], deviceRevocations: [], departures: [] } }
  const document = Automerge.save(doc)
  const store = { read: async () => document, readAuthorization: async () => authorization, merge: vi.fn(), activate: vi.fn() }
  const snapshot = await workspaceSet(store, [doc.id]).snapshot()
  const [workspace] = meshRustRuntime().state.decodeWorkspaceSet(snapshot, [doc.id])
  expect(workspace!.authorization).toHaveProperty("kind", "workspace-authorization-manifest")
  const offer = new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: doc.id, workspace }))
  const requests: Uint8Array[] = []
  const connection = { close: vi.fn(async () => {}), acceptStream: vi.fn(), openStream: async () => {
    let request!: Uint8Array
    return { send: async (bytes: Uint8Array) => { request = bytes; requests.push(bytes) }, closeSend: async () => {},
      read: async () => {
        let response!: Uint8Array
        expect(await serveOwnerOfferProofs(connection, "old-secret", {
          read: vi.fn(), send: async bytes => { response = bytes }, closeSend: async () => {},
        }, request)).toBe(true)
        if (corruption) {
          const page = JSON.parse(new TextDecoder().decode(decodePairingFrame(response, "mesh-proof-page-v1", "old-secret")))
          if (corruption === "missing") page.records = []
          else page.records[0].signed.signature = "forged-signature"
          response = encodePairingFrame("mesh-proof-page-v1", "old-secret", new TextEncoder().encode(JSON.stringify(page)))
        }
        return response
      } }
  } } as SyncConnection
  const release = await registerOwnerOfferProofs(connection, "old-secret", offer, store)
  const merge = vi.fn(async () => {})
  const validate = vi.fn(async (id: string, bytes: Uint8Array, proof: unknown) => {
    const result = computeWorkspaceAdmission({ workspaceId: id, remote: bytes,
      authorization: proof as IncomingAuthorizationBundle, knownAuthority: null, now: Date.now() }, meshRustRuntime().state)
    if (result.unsignedHashes.length) throw new Error(result.unsignedError)
    expect(result.admittedHashes).toHaveLength(100)
  })
  const target = workspaceSet({ read: async () => { throw new Error("Not enrolled") }, merge, validate, activate: vi.fn() }, [doc.id])
  return { id: doc.id, snapshot, offer, connection, source: workspaceSet(store, [doc.id]), target, merge, validate, release, requests }
}

it("Given approved future-board offer, pages bypass current scope and ACK waits for durable admission", async () => {
  const f = await fixture()
  let commit!: () => void
  f.merge.mockImplementation(() => new Promise<void>(resolve => { commit = resolve }))
  const inbound = { send: vi.fn(), closeSend: vi.fn(async () => {}), read: async () => encodePairingFrame("mesh-owner-workspace-offer", "old-secret", f.offer) }
  let sent = false
  f.connection.acceptStream = async () => { if (!sent) { sent = true; return inbound }; return new Promise<never>(() => {}) }
  const session = liveAutomergeWorkspaceSync(f.connection, "old-secret", {
    read: async () => new Uint8Array(), merge: vi.fn(), activate: vi.fn(),
  }, "existing-board", "local", "remote", undefined, {
    ownerWorkspaceOfferFrame: "mesh-owner-workspace-offer",
    onOwnerWorkspaceOffer: async () => f.target.receive(await f.target.resolveProofs(f.snapshot, f.connection, "old-secret"), false),
  })
  await vi.waitFor(() => expect(f.merge).toHaveBeenCalledOnce())
  expect(f.validate).toHaveBeenCalledOnce()
  expect(inbound.send).not.toHaveBeenCalled()
  expect(f.requests.every(frame => frame.length <= 256 * 1024)).toBe(true)
  commit()
  await vi.waitFor(() => expect(inbound.send).toHaveBeenCalledOnce())
  expect(inspectPairingFrame(inbound.send.mock.calls[0]![0]).type).toBe("mesh-durable-ack")
  f.release()
  expect(await serveOwnerOfferProofs(f.connection, "old-secret", inbound, f.requests[0]!)).toBe(false)
  await session.close()
  await clearProofPages(f.id)
})

it.each(["missing", "forged"] as const)("Given %s owner proof page, no durable write or ACK", async corruption => {
  const f = await fixture(corruption)
  const inbound = { send: vi.fn(), closeSend: vi.fn(async () => {}), read: async () => encodePairingFrame("mesh-owner-workspace-offer", "old-secret", f.offer) }
  let sent = false
  f.connection.acceptStream = async () => { if (!sent) { sent = true; return inbound }; return new Promise<never>(() => {}) }
  const session = liveAutomergeWorkspaceSync(f.connection, "old-secret", {
    read: async () => new Uint8Array(), merge: vi.fn(), activate: vi.fn(),
  }, "existing-board", "local", "remote", undefined, {
    ownerWorkspaceOfferFrame: "mesh-owner-workspace-offer",
    onOwnerWorkspaceOffer: async () => f.target.receive(await f.target.resolveProofs(f.snapshot, f.connection, "old-secret"), false),
  })
  await vi.waitFor(() => expect(inbound.closeSend).toHaveBeenCalled())
  expect(inbound.send).not.toHaveBeenCalled()
  expect(f.merge).not.toHaveBeenCalled()
  f.release()
  await session.close()
  await clearProofPages(f.id)
})

it("Given unapproved connection or changed manifest, dispatcher never serves arbitrary scope", async () => {
  const f = await fixture()
  await f.target.resolveProofs(f.snapshot, f.connection, "old-secret")
  const stream = { send: vi.fn(), read: vi.fn(), closeSend: vi.fn() }
  expect(await serveOwnerOfferProofs({} as SyncConnection, "old-secret", stream, f.requests[0]!)).toBe(false)
  const request = JSON.parse(new TextDecoder().decode(decodePairingFrame(f.requests[0]!, "mesh-proof-request-v1", "old-secret")))
  request.manifest.workspaceId = "unapproved-board"
  const changed = encodePairingFrame("mesh-proof-request-v1", "old-secret", new TextEncoder().encode(JSON.stringify(request)))
  await expect(serveOwnerOfferProofs(f.connection, "old-secret", stream, changed)).rejects.toThrow("changed approved manifest")
  expect(stream.send).not.toHaveBeenCalled()
  f.release()
  await clearProofPages(f.id)
})

it("Given legacy peer, complete mid-size v1 remains compatible and manifest fetch stays unnegotiated", async () => {
  const f = await fixture()
  const legacy = await f.source.snapshot(undefined, false)
  const entry = meshRustRuntime().state.decodeWorkspaceSet(legacy, [f.id])[0]!
  expect(entry.authorization).toMatchObject({ version: 1 })
  expect((entry.authorization as { records: unknown[] }).records).toHaveLength(100)
  await expect(f.target.resolveProofs(f.snapshot, f.connection, "old-secret", false)).rejects.toThrow("did not negotiate")
  expect(f.requests).toHaveLength(0)
  const evict = vi.fn()
  await expect(publishConfirmedToSessions([{ connection: f.connection, proofPagingSupported: false, evict } as never],
    "old-secret", f.snapshot, "failed")).rejects.toThrow("does not support proof paging")
  expect(evict).not.toHaveBeenCalled()
  expect(f.requests).toHaveLength(0)
  f.release()
  await clearProofPages(f.id)
})
