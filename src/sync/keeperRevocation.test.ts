import { beforeAll, describe, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createWorkspaceDoc } from "../domain/seeds"
import { initializeAutomerge } from "../crdt"
import { createWorkspaceGrant } from "../domain/proofs"
import { DurableMesh } from "./durableMesh"
import type { WorkspaceMeshCredential, WorkspacePeerRecord } from "./peerStore"
import { clearMeshTrace, meshTraceSnapshot } from "./meshTrace"

beforeAll(async () => {
  await Automerge.initializeWasm(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm"))
  await initializeAutomerge()
})

describe("keeper revocation projection", () => {
  it("Given an active keeper, when owner revokes access, then persisted peer state hides it after reload", async () => {
    clearMeshTrace()
    resetIdentityStorageForTest()
    const owner = await bootstrapIdentity("Owner")
    const keeperId = `keeper-${crypto.randomUUID()}`
    const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Board", owner.identity.personId, "blank"))
    const grant = await createWorkspaceGrant(owner, doc.id, keeperId, "editor", 1)
    let credential: WorkspaceMeshCredential = {
      workspaceId: doc.id,
      ownerPersonId: owner.identity.personId,
      ownerPublicKey: owner.identity.publicKey,
      ownerCertificates: [owner.certificate],
      epoch: 1,
      catalog: {},
    } as WorkspaceMeshCredential
    let peers: WorkspacePeerRecord[] = [{
      workspaceId: doc.id,
      personId: keeperId,
      deviceId: "keeper-device",
      endpoint: "keeper-endpoint",
      transportSecret: "transport-secret",
      role: "editor",
      advertisement: { grant },
      lastSeen: new Date(0).toISOString(),
    } as unknown as WorkspacePeerRecord]
    const store = {
      getWorkspaceCredential: async () => credential,
      putWorkspaceCredential: async (next: WorkspaceMeshCredential) => { credential = next },
      listWorkspaceCredentials: async () => [credential],
      listWorkspaceAuthorities: async () => [],
      listPeers: async () => peers,
      upsertPeer: async (peer: WorkspacePeerRecord) => {
        peers = [...peers.filter(current => current.deviceId !== peer.deviceId), peer]
      },
    }
    const onChange = vi.fn()
    const mesh = new DurableMesh({
      transport: {} as never,
      workspaceStore: { read: async () => Automerge.save(doc), reclassify: async () => {} } as never,
      workspace: {} as never,
      getProfile: async () => owner,
      store: store as never,
      onChange,
    })
    vi.spyOn(mesh, "nextAccessEpoch").mockResolvedValueOnce(2).mockResolvedValueOnce(4)
    const internal = mesh as unknown as {
      refreshSuccessionPolicy: (workspaceId: string) => Promise<void>
      publishWorkspace: (workspaceId: string) => Promise<void>
    }
    vi.spyOn(internal, "refreshSuccessionPolicy").mockResolvedValue(undefined)
    vi.spyOn(internal, "publishWorkspace").mockResolvedValue(undefined)

    try {
      await mesh.revokePerson(doc.id, keeperId)

      expect(credential.catalog).toMatchObject({ revocations: [{ payload: { personId: keeperId } }] })
      expect(peers[0]?.revokedAt).toBeTruthy()
      expect(onChange).toHaveBeenCalledWith([], expect.arrayContaining([
        expect.objectContaining({ personId: keeperId, revokedAt: expect.any(String) }),
      ]), [], [], expect.any(String))

      const renewedGrant = await createWorkspaceGrant(owner, doc.id, keeperId, "editor", 3)
      peers = [{ ...peers[0]!, advertisement: { grant: renewedGrant }, revokedAt: null,
        lastSeen: new Date(Date.now() + 1_000).toISOString() }]
      await mesh.revokePerson(doc.id, keeperId)

      expect(credential.catalog).toMatchObject({ revocations: [
        { payload: { personId: keeperId, epoch: 2 } },
        { payload: { personId: keeperId, epoch: 4 } },
      ] })
      expect(meshTraceSnapshot().find(event => event.event === "authority.revoke.generation-check"))
        .toMatchObject({ existingRevocationEpoch: 2, maxActiveGrantEpoch: 3, activePeerCount: 1, covered: false })
      expect(meshTraceSnapshot().find(event => event.event === "authority.revoke.generation-created"
        && (event as unknown as { existingRevocationEpoch?: number }).existingRevocationEpoch === 2))
        .toMatchObject({ newRevocationEpoch: 4 })
      expect(peers[0]?.revokedAt).toBeTruthy()
      expect(onChange).toHaveBeenLastCalledWith([], expect.arrayContaining([
        expect.objectContaining({ personId: keeperId, revokedAt: expect.any(String) }),
      ]), [], [], expect.any(String))

      const reloaded = new DurableMesh({
        transport: {} as never,
        workspaceStore: {} as never,
        workspace: {} as never,
        getProfile: async () => owner,
        store: store as never,
      })
      try {
        await expect(reloaded.views(doc.id)).resolves.toEqual([
          expect.objectContaining({ personId: keeperId, revokedAt: peers[0]?.revokedAt }),
        ])
      } finally {
        await reloaded.dispose()
      }
    } finally {
      await mesh.dispose()
      Automerge.free(doc)
    }
  })
})
