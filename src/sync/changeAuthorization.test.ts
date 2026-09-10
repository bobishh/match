import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, signEnvelope, type LocalProfile } from "../domain/identity"
import { createWorkspaceDoc } from "../domain/seeds"
import { createWorkspaceGrant } from "../domain/proofs"
import { executeCommand, type Command } from "../domain/commands"
import { validateIncomingChanges } from "./changeAuthorization"
import { assertWorkspaceTransition } from "../domain/permissions"

vi.mock("./peerStore", () => ({ peerStore: { getWorkspaceCredential: async () => null, listPeers: async () => [] } }))
beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})
let owner: LocalProfile, member: LocalProfile
beforeEach(async () => {
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
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createTask", parentId, title: "Forbidden" }), "visitor")
  await expect(validateIncomingChanges(local, remote, [record])).rejects.toThrow(/Visitors/)
  expect(() => assertWorkspaceTransition("visitor", local, remote)).toThrow(/Visitors/)
})
it("accepts signed editor task changes, including when forwarded by another peer", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createTask", parentId, title: "Allowed" }), "editor")
  await expect(validateIncomingChanges(local, remote, [record])).resolves.toBeUndefined()
  expect(() => assertWorkspaceTransition("editor", local, remote)).not.toThrow()
})
for (const action of ["renameWorkspace", "createColumn"] as const) {
  it(`rejects editor ${action} through the same policy used for local commands`, async () => {
    const { local, remote, record } = await fixture(boardId => action === "renameWorkspace"
      ? { kind: action, title: "Forbidden" } : { kind: action, boardId, title: "Forbidden" }, "editor")
    await expect(validateIncomingChanges(local, remote, [record])).rejects.toThrow(/Only the owner/)
    expect(() => assertWorkspaceTransition("editor", local, remote)).toThrow(/Only the owner/)
  })
}
it("rejects a valid signature over a different change hash", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createTask", parentId, title: "Original" }), "editor")
  const forged = Automerge.change(Automerge.clone(remote), draft => { draft.title = "Forged" })
  await expect(validateIncomingChanges(local, forged, [record])).rejects.toThrow(/Unsigned/)
})
it("rejects tampering with an owner-issued role", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createTask", parentId, title: "Forbidden" }), "visitor")
  record.grant.payload.role = "editor"
  await expect(validateIncomingChanges(local, remote, [record])).rejects.toThrow(/signature/)
})
