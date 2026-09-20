import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, signEnvelope, type LocalProfile } from "../domain/identity"
import { createWorkspaceDoc } from "../domain/seeds"
import { createWorkspaceGrant } from "../domain/proofs"
import { createWorkspaceOwnershipTransfer } from "./meshRecords"
import { executeCommand, type Command } from "../domain/commands"
import { validateIncomingChanges, pendingHistoryRepair, repairPendingHistory } from "./changeAuthorization"
import { assertWorkspaceTransition } from "../domain/permissions"
import { isItem } from "../domain/model"

const peerStoreState = vi.hoisted(() => ({ credential: null as any }))
vi.mock("./peerStore", () => ({ peerStore: { getWorkspaceCredential: async () => peerStoreState.credential, listPeers: async () => [] } }))
beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})
let owner: LocalProfile, member: LocalProfile
beforeEach(async () => {
  peerStoreState.credential = null
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
it("rejects visitor writes even with a valid device signature and owner-issued visitor grant", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Forbidden" }), "visitor")
  await expect(validateIncomingChanges(local, remote, [record])).rejects.toThrow(/Visitors/)
  expect(() => assertWorkspaceTransition("visitor", local, remote)).toThrow(/Visitors/)
})
it("accepts signed editor item changes, including when forwarded by another peer", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Allowed" }), "editor")
  await expect(validateIncomingChanges(local, remote, [record])).resolves.toBeUndefined()
  expect(() => assertWorkspaceTransition("editor", local, remote)).not.toThrow()
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

  await expect(validateIncomingChanges(local, remote, [record])).resolves.toBeUndefined()
})
it("accepts an editor changing only workspace title casing", async () => {
  const { local, remote, record } = await fixture(() => ({ kind: "renameWorkspace", title: "twang" }), "editor")
  await expect(validateIncomingChanges(local, remote, [record])).resolves.toBeUndefined()
  expect(() => assertWorkspaceTransition("editor", local, remote)).not.toThrow()
  expect(remote.title).toBe("twang")
})

it("rejects editor board-structure changes through the same policy used for local commands", async () => {
  const { local, remote, record } = await fixture(boardId => ({ kind: "createColumn", boardId, title: "Forbidden" }), "editor")
  await expect(validateIncomingChanges(local, remote, [record])).rejects.toThrow(/Only the owner/)
  expect(() => assertWorkspaceTransition("editor", local, remote)).toThrow(/Only the owner/)
})
it("rejects a valid signature over a different change hash", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Original" }), "editor")
  const forged = Automerge.change(Automerge.clone(remote), draft => { draft.title = "Forged" })
  await expect(validateIncomingChanges(local, forged, [record])).rejects.toThrow(/Unsigned/)
})
it("rejects tampering with an owner-issued role", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Forbidden" }), "visitor")
  record.grant.payload.role = "editor"
  await expect(validateIncomingChanges(local, remote, [record])).rejects.toThrow(/signature/)
})

it("Given two manual transfers from one owner at one epoch, when authorization checks the workspace, then writes stay frozen", async () => {
  peerStoreState.credential = {
    epoch: 1,
    catalog: { ownershipTransfers: [
      { payload: { epoch: 2, fromOwnerPersonId: "owner", toOwnerPersonId: "alice" } },
      { payload: { epoch: 2, fromOwnerPersonId: "owner", toOwnerPersonId: "bob" } },
    ] },
  }

  const remote = Automerge.from(createWorkspaceDoc("workspace", "Frozen", owner.identity.personId, "blank"))
  await expect(validateIncomingChanges(undefined, remote, [])).rejects.toThrow(/conflicting ownership records/i)
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
  await expect(validateIncomingChanges(local, remote, [])).rejects.toThrow("Unsigned workspace change rejected")
  expect(pendingHistoryRepair(local.id)).toBe(1)
  await expect(repairPendingHistory(local.id, member)).rejects.toThrow(/owner/i)
  const repaired = await repairPendingHistory(local.id, owner)
  await expect(validateIncomingChanges(local, Automerge.load(repaired.bytes), repaired.authorization)).resolves.toBeUndefined()
  expect(Automerge.getHeads(Automerge.load(repaired.bytes))).toEqual(Automerge.getHeads(remote))
  const malicious = Automerge.change(Automerge.clone(local), {message:"Remove item discriminators"}, d => {
    delete (Object.values(d.entities).find(isItem) as any).kind
    d.title = "Changed behind your back"
  })
  await expect(validateIncomingChanges(local, malicious, [])).rejects.toThrow("Unsigned workspace change rejected")
  expect(pendingHistoryRepair(local.id)).toBe(0)
  await expect(repairPendingHistory(local.id, owner)).rejects.toThrow(/No repairable/)
})
