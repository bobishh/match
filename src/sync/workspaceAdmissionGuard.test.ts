import { readFile } from "node:fs/promises"
import { beforeAll, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createWorkspaceDoc } from "../domain/seeds"
import { validateIncomingChangeAuthorizations } from "./changeAuthorization"
import type { WorkspaceAdmissionResult } from "./workspaceAdmissionCore"

const state = vi.hoisted(() => ({ authority: null as any, admit: vi.fn() }))
vi.mock("./workspaceAdmissionClient", () => ({ runWorkspaceAdmission: (...args: unknown[]) => state.admit(...args) }))
vi.mock("./peerStore", () => ({ peerStore: {
  getWorkspaceAuthority: async () => state.authority,
  getWorkspaceCredential: async () => null,
} }))

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

it("rejects a worker result when durable authority changed while admission was pending", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Authority race", profile.identity.personId, "blank"))
  const owner = { personId: profile.identity.personId, publicKey: profile.identity.publicKey, certificates: [profile.certificate] }
  const authority = { genesisOwner: owner, currentOwner: owner, genesisEpoch: 1, currentEpoch: 1,
    ownershipTransfers: [], successionClaims: [], revocations: [], deviceRevocations: [], departures: [] }
  state.authority = null
  let finish!: (result: WorkspaceAdmissionResult) => void
  state.admit.mockReturnValue(new Promise<WorkspaceAdmissionResult>(resolve => { finish = resolve }))
  const validation = validateIncomingChangeAuthorizations(undefined, doc, { version: 1, records: [], authority })
  const rejected = expect(validation).rejects.toThrow("Workspace authority changed during validation")
  await vi.waitFor(() => expect(state.admit).toHaveBeenCalledOnce())
  state.authority = { version: 1, workspaceId: doc.id, ownerPersonId: owner.personId,
    ownerPublicKey: owner.publicKey, ownerCertificates: owner.certificates, epoch: 2, catalog: {} }
  finish({ neededHashes: [], admittedHashes: [], verifiedAuthorizations: [], unsignedHashes: [], unsignedError: "", repairableCleanup: false })
  await rejected
  Automerge.free(doc)
})
