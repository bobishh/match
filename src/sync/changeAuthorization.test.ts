import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, signEnvelope, type LocalProfile } from "../domain/identity"
import { createWorkspaceDoc } from "../domain/seeds"
import { createWorkspaceGrant } from "../domain/proofs"
import { createWorkspaceOwnershipTransfer, createWorkspaceDeparture, createWorkspaceDeviceRevocation, createWorkspaceRevocation } from "./meshRecords"
import { executeCommand, type Command } from "../domain/commands"
import { exportAuthorizations, validateIncomingChanges, validateIncomingChangesWithProofStatus, validateIncomingChangeAuthorizations, pendingHistoryRepair, repairPendingHistory, workspaceRole, workspaceWritesBlocked } from "./changeAuthorization"
import { assertWorkspaceTransition } from "../domain/permissions"
import { isItem, type WorkspaceDocumentV2 } from "../domain/model"

const peerStoreState = vi.hoisted(() => ({ credential: null as any, authority: null as any }))
vi.mock("./peerStore", () => ({ peerStore: {
  getWorkspaceCredential: async () => peerStoreState.credential,
  getWorkspaceAuthority: async () => peerStoreState.authority,
  putWorkspaceAuthority: async (authority: any) => { peerStoreState.authority = authority },
  listPeers: async () => [],
} }))
beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})
let owner: LocalProfile, member: LocalProfile
beforeEach(async () => {
  peerStoreState.credential = null
  peerStoreState.authority = null
  resetIdentityStorageForTest(); owner = await bootstrapIdentity("Owner")
  resetIdentityStorageForTest(); member = await bootstrapIdentity("Member")
})
async function fixture(command: (board: string, column: string) => Command, role: "visitor" | "editor") {
  const local = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Permissions", owner.identity.personId, "blank"))
  const board = Object.values(local.entities).find(e => e.kind === "board")!
  const column = Object.values(local.entities).find(e => e.kind === "column")!
  const result = await executeCommand(local, command(board.id, column.id), member)
  if (!result.ok) throw new Error(result.error.message)
  const signed = await signEnvelope(member.privateKeys.devicePrivateKey, {
    kind: "workspace-changes" as const, version: 1 as const, workspaceId: local.id,
    personId: member.identity.personId, deviceId: member.device.deviceId, hashes: [result.value.receipt.changeHash],
  }, member.device.deviceId)
  const record = { signed, publicKey: member.identity.publicKey, certificates: [member.certificate],
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate],
    grant: await createWorkspaceGrant(owner, local.id, member.identity.personId, role) }
  return { local, remote: result.value.newDoc, record }
}
function authorizationBundle(doc: Automerge.Doc<WorkspaceDocumentV2>, records: unknown[], current = owner) {
  const authority = { personId: owner.identity.personId, publicKey: owner.identity.publicKey, certificates: [owner.certificate] }
  return { version: 1, records, authority: { genesisOwner: authority, genesisEpoch: 1, currentOwner: current === owner
    ? authority : { personId: current.identity.personId, publicKey: current.identity.publicKey, certificates: [current.certificate] },
  currentEpoch: 1,
  ownershipTransfers: [], successionClaims: [], revocations: [], deviceRevocations: [], departures: [] } }
}
it("rejects visitor writes even with a valid device signature and owner-issued visitor grant", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Forbidden" }), "visitor")
  await expect(validateIncomingChanges(local, remote, authorizationBundle(local, [record]))).rejects.toThrow(/Visitors/)
  expect(() => assertWorkspaceTransition("visitor", local, remote)).toThrow(/Visitors/)
})

it("defaults an omitted optional departures list before calling Rust", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Forbidden" }), "visitor")
  const bundle = authorizationBundle(local, [record])
  delete (bundle.authority as any).departures
  await expect(validateIncomingChanges(local, remote, bundle)).rejects.toThrow(/Visitors/)
})

it("admits a valid editor bundle when optional departures are omitted", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Allowed" }), "editor")
  const bundle = authorizationBundle(local, [record])
  delete (bundle.authority as any).departures
  await expect(validateIncomingChanges(local, remote, bundle)).resolves.toBeUndefined()
})

it("rejects malformed present departures evidence before Rust", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Malformed" }), "editor")
  const bundle = authorizationBundle(local, [record])
  ;(bundle.authority as any).departures = null
  await expect(validateIncomingChanges(local, remote, bundle)).rejects.toThrow("Invalid workspace authority departures")
})
it("accepts signed editor item changes with a delegated-device grant, including when forwarded by another peer", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Allowed" }), "editor")
  await expect(validateIncomingChanges(local, remote, authorizationBundle(local, [record]))).resolves.toBeUndefined()
  expect(() => assertWorkspaceTransition("editor", local, remote)).not.toThrow()
})
it("accepts an owner-root grant and rejects a forged root grant", async () => {
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Root grants", owner.identity.personId, "blank"))
  const payload = {
    kind: "workspace-grant" as const, version: 1 as const, grantId: crypto.randomUUID(), workspaceId: doc.id,
    personId: member.identity.personId, role: "editor" as const, accessEpoch: 1,
  }
  const rootGrant = await signEnvelope(owner.privateKeys.identityPrivateKey!, payload, owner.identity.personId)
  peerStoreState.authority = {
    workspaceId: doc.id, ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate], ownerHistory: [], localGrant: rootGrant, epoch: 1, catalog: {},
  }
  await expect(workspaceRole(doc, member)).resolves.toBe("editor")

  const forgedGrant = await signEnvelope(member.privateKeys.identityPrivateKey!, payload, member.identity.personId)
  peerStoreState.authority.localGrant = forgedGrant
  await expect(workspaceRole(doc, member)).resolves.toBe("visitor")
})

it("derives local owner, editor, visitor, revocation, departure, renewal, and device removal from Rust", async () => {
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Access decision", owner.identity.personId, "blank"))
  peerStoreState.authority = {
    workspaceId: doc.id, ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate], ownerHistory: [], epoch: 1, catalog: {},
  }
  await expect(workspaceRole(doc, owner)).resolves.toBe("owner")

  const editorGrant = await createWorkspaceGrant(owner, doc.id, member.identity.personId, "editor", 1)
  peerStoreState.authority.localGrant = editorGrant
  await expect(workspaceRole(doc, member)).resolves.toBe("editor")
  peerStoreState.authority.localGrant = await createWorkspaceGrant(owner, doc.id, member.identity.personId, "visitor", 1)
  await expect(workspaceRole(doc, member)).resolves.toBe("visitor")

  peerStoreState.authority.localGrant = editorGrant
  peerStoreState.authority.catalog = { revocations: [await createWorkspaceRevocation(owner, doc.id,
    member.identity.personId, 2, Automerge.getHeads(doc))] }
  await expect(workspaceRole(doc, member)).resolves.toBe("visitor")
  peerStoreState.authority.localGrant = await createWorkspaceGrant(owner, doc.id, member.identity.personId, "editor", 3)
  await expect(workspaceRole(doc, member)).resolves.toBe("editor")

  peerStoreState.authority.localGrant = editorGrant
  peerStoreState.authority.catalog = { departures: [await createWorkspaceDeparture(member, doc.id, 2, Automerge.getHeads(doc), [member.certificate])] }
  await expect(workspaceRole(doc, member)).resolves.toBe("visitor")
  peerStoreState.authority.localGrant = await createWorkspaceGrant(owner, doc.id, member.identity.personId, "editor", 3)
  await expect(workspaceRole(doc, member)).resolves.toBe("editor")

  peerStoreState.authority.catalog = { deviceRevocations: [await createWorkspaceDeviceRevocation(owner, doc.id,
    member.identity.personId, member.device.deviceId, Automerge.getHeads(doc), [owner.certificate])] }
  await expect(workspaceRole(doc, member)).resolves.toBe("visitor")
})
it("accepts transferred-owner history on a clean replica only when the supplied authority chain verifies", async () => {
  resetIdentityStorageForTest(); const successor = await bootstrapIdentity("Successor")
  const local = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Transferred", owner.identity.personId, "blank"))
  const column = Object.values(local.entities).find(entity => entity.kind === "column")!
  const transfer = await createWorkspaceOwnershipTransfer(owner, local.id, {
    personId: successor.identity.personId, publicKey: successor.identity.publicKey, certificates: [successor.certificate],
  }, Automerge.getHeads(local), 2)
  const genesisSigned = await signEnvelope(owner.privateKeys.devicePrivateKey, {
    kind: "workspace-changes" as const, version: 1 as const, workspaceId: local.id,
    personId: owner.identity.personId, deviceId: owner.device.deviceId,
    hashes: Automerge.getAllChanges(local).map(change => Automerge.decodeChange(change).hash),
  }, owner.device.deviceId)
  const result = await executeCommand(local, { kind: "createItem", parentId: column.id, title: "Successor write" }, successor)
  if (!result.ok) throw new Error(result.error.message)
  const signed = await signEnvelope(successor.privateKeys.devicePrivateKey, {
    kind: "workspace-changes" as const, version: 1 as const, workspaceId: local.id,
    personId: successor.identity.personId, deviceId: successor.device.deviceId, hashes: [result.value.receipt.changeHash],
  }, successor.device.deviceId)
  const authority = { personId: owner.identity.personId, publicKey: owner.identity.publicKey, certificates: [owner.certificate] }
  peerStoreState.authority = {
    version: 1, workspaceId: local.id, genesisOwnerPersonId: owner.identity.personId,
    ownerPersonId: successor.identity.personId, ownerPublicKey: successor.identity.publicKey,
    ownerCertificates: [successor.certificate], ownerHistory: [authority], localGrant: undefined,
    epoch: 2, updatedAt: new Date().toISOString(), catalog: { ownershipTransfers: [transfer] },
  }
  await expect(workspaceRole(local, successor)).resolves.toBe("owner")
  const bundle = {
    version: 1, records: [
      { signed: genesisSigned, publicKey: owner.identity.publicKey, certificates: [owner.certificate] },
      { signed, publicKey: successor.identity.publicKey, certificates: [successor.certificate] },
    ],
    authority: { genesisOwner: authority, genesisEpoch: 1,
      currentOwner: { personId: successor.identity.personId, publicKey: successor.identity.publicKey, certificates: [successor.certificate] },
      currentEpoch: 2,
      ownershipTransfers: [transfer], successionClaims: [], revocations: [], deviceRevocations: [], departures: [] },
  }

  await expect(validateIncomingChanges(undefined, result.value.newDoc, bundle)).resolves.toBeUndefined()
  await expect(validateIncomingChanges(undefined, result.value.newDoc, { ...bundle,
    records: [bundle.records[0], { ...bundle.records[1], signed: { ...signed, signature: `${signed.signature}forged` } }] })).rejects.toThrow(/signature/i)
  await expect(validateIncomingChanges(undefined, result.value.newDoc, { ...bundle,
    authority: { ...bundle.authority, ownershipTransfers: [{ ...transfer, signature: `${transfer.signature}forged` }] } })).rejects.toThrow(/signature/i)
})
it("reports a proof change only once when the same authorization is replayed", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Idempotent" }), "editor")
  await expect(validateIncomingChangesWithProofStatus(local, remote, authorizationBundle(local, [record]))).resolves.toBe(true)
  await expect(validateIncomingChangesWithProofStatus(remote, remote, authorizationBundle(remote, [record]))).resolves.toBe(false)
})
it("keeps a later local owner boundary when admitting a peer's older history", async () => {
  resetIdentityStorageForTest(); const successor = await bootstrapIdentity("Successor")
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Boundary", owner.identity.personId, "blank"))
  const transfer = await createWorkspaceOwnershipTransfer(owner, doc.id, {
    personId: successor.identity.personId, publicKey: successor.identity.publicKey, certificates: [successor.certificate],
  }, Automerge.getHeads(doc), 2)
  peerStoreState.authority = { version: 1, workspaceId: doc.id, genesisOwnerPersonId: owner.identity.personId,
    ownerPersonId: successor.identity.personId, ownerPublicKey: successor.identity.publicKey,
    ownerCertificates: [successor.certificate], ownerHistory: [{ personId: owner.identity.personId,
      publicKey: owner.identity.publicKey, certificates: [owner.certificate] }], epoch: 2,
    updatedAt: new Date().toISOString(), catalog: { ownershipTransfers: [transfer] } }
  const signed = await signEnvelope(owner.privateKeys.devicePrivateKey, {
    kind: "workspace-changes" as const, version: 1 as const, workspaceId: doc.id,
    personId: owner.identity.personId, deviceId: owner.device.deviceId,
    hashes: Automerge.getAllChanges(doc).map(change => Automerge.decodeChange(change).hash),
  }, owner.device.deviceId)
  await expect(validateIncomingChanges(doc, doc, authorizationBundle(doc, [{ signed,
    publicKey: owner.identity.publicKey, certificates: [owner.certificate] }]))).resolves.toBeUndefined()
})
it("does not persist a proof while validating an incoming workspace", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Pure" }), "editor")
  await expect(validateIncomingChangeAuthorizations(local, remote, authorizationBundle(local, [record]))).resolves.toHaveLength(1)
  await expect(validateIncomingChangesWithProofStatus(local, remote, authorizationBundle(local, [record]))).resolves.toBe(true)
})
it("reports a proof change once when a replay enriches certificates around the same change signature", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Enriched" }), "editor")
  await expect(validateIncomingChangesWithProofStatus(local, remote, authorizationBundle(local, [record]))).resolves.toBe(true)
  const enriched = { ...record, ownerCertificates: [...record.ownerCertificates, member.certificate] }
  await expect(validateIncomingChangesWithProofStatus(remote, remote, authorizationBundle(remote, [enriched]))).resolves.toBe(true)
  await expect(validateIncomingChangesWithProofStatus(remote, remote, authorizationBundle(remote, [record]))).resolves.toBe(false)
  const [stored] = await exportAuthorizations(Automerge.save(remote))
  expect(stored.ownerCertificates).toHaveLength(2)
})
it("accepts a historical editor grant when its signed authorization carries a missing owner device certificate", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Forwarded" }), "editor")
  peerStoreState.credential = {
    workspaceId: local.id,
    ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [],
    localGrant: undefined,
    ownerHistory: [],
    catalog: {},
  }

  const bundle = authorizationBundle(local, [record])
  bundle.authority.genesisOwner.certificates = []
  bundle.authority.currentOwner.certificates = []
  await expect(validateIncomingChanges(local, remote, bundle)).resolves.toBeUndefined()
})
it("accepts an editor changing only workspace title casing", async () => {
  const { local, remote, record } = await fixture(() => ({ kind: "renameWorkspace", title: "twang" }), "editor")
  await expect(validateIncomingChanges(local, remote, authorizationBundle(local, [record]))).resolves.toBeUndefined()
  expect(() => assertWorkspaceTransition("editor", local, remote)).not.toThrow()
  expect(remote.title).toBe("twang")
})

it("rejects editor board-structure changes through the same policy used for local commands", async () => {
  const { local, remote, record } = await fixture(boardId => ({ kind: "createColumn", boardId, title: "Forbidden" }), "editor")
  await expect(validateIncomingChanges(local, remote, authorizationBundle(local, [record]))).rejects.toThrow(/Only the owner/)
  expect(() => assertWorkspaceTransition("editor", local, remote)).toThrow(/Only the owner/)
})
it("rejects a valid signature over a different change hash", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Original" }), "editor")
  const forged = Automerge.change(Automerge.clone(remote), draft => { draft.title = "Forged" })
  await expect(validateIncomingChanges(local, forged, authorizationBundle(local, [record]))).rejects.toThrow(/Unsigned/)
})
it("rejects a forged owner-issued role", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Forbidden" }), "visitor")
  record.grant.payload.role = "editor"
  await expect(validateIncomingChanges(local, remote, authorizationBundle(local, [record]))).rejects.toThrow(/Visitors|signature/)
})

it("Given a forged durable authority and a valid active credential, when role is recovered, then the forged authority cannot grant editor access", async () => {
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Forged authority", owner.identity.personId, "blank"))
  const localGrant = await createWorkspaceGrant(owner, doc.id, member.identity.personId, "editor")
  peerStoreState.credential = {
    workspaceId: doc.id, ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate], localGrant, ownerHistory: [], catalog: {}, epoch: 1,
  }
  peerStoreState.authority = {
    ...peerStoreState.credential, ownerPersonId: "forged-owner", ownerPublicKey: "forged-key",
    ownerHistory: [{ personId: owner.identity.personId, publicKey: owner.identity.publicKey, certificates: [owner.certificate] }],
  }

  await expect(workspaceRole(doc, member)).resolves.toBe("visitor")
})

it("Given a current owner authority with a historical owner grant, when role is recovered, then the legitimate historical grant remains editor access", async () => {
  resetIdentityStorageForTest(); const successor = await bootstrapIdentity("Successor")
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Historical authority", owner.identity.personId, "blank"))
  const localGrant = await createWorkspaceGrant(owner, doc.id, member.identity.personId, "editor")
  const transfer = await createWorkspaceOwnershipTransfer(owner, doc.id, {
    personId: successor.identity.personId, publicKey: successor.identity.publicKey, certificates: [successor.certificate],
  }, Automerge.getHeads(doc), 2)
  peerStoreState.authority = {
    workspaceId: doc.id, ownerPersonId: successor.identity.personId, ownerPublicKey: successor.identity.publicKey,
    ownerCertificates: [successor.certificate], localGrant, epoch: 2, catalog: {},
    ownerHistory: [{ personId: owner.identity.personId, publicKey: owner.identity.publicKey, certificates: [owner.certificate] }],
  }
  peerStoreState.authority.catalog = { ownershipTransfers: [transfer] }

  await expect(workspaceRole(doc, member)).resolves.toBe("editor")
})

it("Given two manual transfers from one owner at one epoch, when authorization checks the workspace, then writes stay frozen", async () => {
  const remote = Automerge.from(createWorkspaceDoc("workspace", "Frozen", owner.identity.personId, "blank"))
  peerStoreState.credential = {
    workspaceId: remote.id, ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate], ownerHistory: [], localGrant: undefined, epoch: 1,
    catalog: { ownershipTransfers: [
      { payload: { epoch: 2, fromOwnerPersonId: "owner", toOwnerPersonId: "alice" } },
      { payload: { epoch: 2, fromOwnerPersonId: "owner", toOwnerPersonId: "bob" } },
    ] },
  }

  await expect(validateIncomingChanges(undefined, remote, [])).rejects.toThrow(/conflicting ownership records/i)
})

it("Given one local ownership transfer before mesh startup, when write access is checked, then Rust runtime is not required", async () => {
  peerStoreState.credential = {
    epoch: 1,
    catalog: { ownershipTransfers: [
      { payload: { epoch: 2, fromOwnerPersonId: "owner", toOwnerPersonId: "alice" } },
    ] },
  }

  await expect(workspaceWritesBlocked("workspace")).resolves.toBe(false)
})

it("Given split owners wrote on separate partitions, when the branches meet, then neither branch is admitted under ambiguous authority", async () => {
  resetIdentityStorageForTest(); const first = await bootstrapIdentity("First successor")
  resetIdentityStorageForTest(); const second = await bootstrapIdentity("Second successor")
  const base = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Partitioned", owner.identity.personId, "blank"))
  const column = Object.values(base.entities).find(entity => entity.kind === "column")!
  const write = async (profile: LocalProfile, title: string) => {
    const result = await executeCommand(base, { kind: "createItem", parentId: column.id, title }, profile)
    if (!result.ok) throw new Error(result.error.message)
    return result.value.newDoc
  }
  const [branchA, branchB] = await Promise.all([write(first, "A write"), write(second, "B write")])
  const merged = Automerge.merge(branchA, branchB)
  const heads = Automerge.getHeads(base)
  const transfers = await Promise.all([first, second].map(target => createWorkspaceOwnershipTransfer(owner, base.id, {
    personId: target.identity.personId, publicKey: target.identity.publicKey, certificates: [target.certificate],
  }, heads, 2)))
  peerStoreState.credential = {
    workspaceId: base.id, ownerPersonId: first.identity.personId, ownerPublicKey: first.identity.publicKey,
    ownerCertificates: [first.certificate], ownerHistory: [{ personId: owner.identity.personId,
      publicKey: owner.identity.publicKey, certificates: [owner.certificate] }], epoch: 2,
    catalog: { ownershipTransfers: transfers },
  }

  const titles = Object.values(merged.entities).filter(isItem).map(entity => entity.title)
  expect(titles).toEqual(expect.arrayContaining(["A write", "B write"]))
  await expect(validateIncomingChanges(branchA, merged, [])).rejects.toThrow(/conflicting ownership records/i)
})


it("lets only the owner sign verified discriminator cleanup, without accepting a disguised content edit", async () => {
  let local = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Repair", owner.identity.personId, "blank"))
  const column = Object.values(local.entities).find(e => e.kind === "column")!
  const added = await executeCommand(local, {kind:"createItem",parentId:column.id,title:"Keep this"}, owner)
  if (!added.ok) throw new Error(added.error.message)
  local = Automerge.change(added.value.newDoc, d => { (Object.values(d.entities).find(isItem) as any).kind = "task" })
  const remote = Automerge.change(Automerge.clone(local), {message:"Remove item discriminators"}, d => {
    delete (Object.values(d.entities).find(isItem) as any).kind
  })
  await expect(validateIncomingChanges(local, remote, authorizationBundle(local, []))).rejects.toThrow("Unsigned workspace change rejected")
  expect(pendingHistoryRepair(local.id)).toBe(1)
  await expect(repairPendingHistory(local.id, member)).rejects.toThrow(/owner/i)
  const repaired = await repairPendingHistory(local.id, owner)
  await expect(validateIncomingChanges(local, Automerge.load(repaired.bytes), authorizationBundle(local, repaired.authorization))).resolves.toBeUndefined()
  expect(Automerge.getHeads(Automerge.load(repaired.bytes))).toEqual(Automerge.getHeads(remote))
  const malicious = Automerge.change(Automerge.clone(local), {message:"Remove item discriminators"}, d => {
    delete (Object.values(d.entities).find(isItem) as any).kind
    d.title = "Changed behind your back"
  })
  await expect(validateIncomingChanges(local, malicious, authorizationBundle(local, []))).rejects.toThrow("Unsigned workspace change rejected")
  expect(pendingHistoryRepair(local.id)).toBe(0)
  await expect(repairPendingHistory(local.id, owner)).rejects.toThrow(/No repairable/)
})
