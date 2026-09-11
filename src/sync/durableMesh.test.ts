import { describe, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, sha256Base64Url, toBase64Url, type LocalProfile } from "../domain/identity"
import { certHashDefault, createDelegatedCertificate, createWorkspaceGrant } from "../domain/proofs"
import { verifyWorkspaceGrant } from "./meshRecords"
import { DurableMesh } from "./durableMesh"

describe("DurableMesh peer catalog gossip", () => {
  it("Given one invalid peer record, when a catalog merges, then later valid peers still import", async () => {
    const credential = { workspaceId: "workspace-1" }
    const mesh = new DurableMesh({
      transport: {} as never,
      workspaceStore: {} as never,
      workspace: {} as never,
      getProfile: async () => ({} as never),
      store: { getWorkspaceCredential: async () => credential } as never,
    })
    const imported: string[] = []
    const internal = mesh as any
    internal.mergeOwnershipTransfers = async () => credential
    internal.mergeRevocations = async () => {}
    internal.putVerifiedBundle = vi.fn(async (_credential: unknown, bundle: { id: string }) => {
      if (bundle.id === "poisoned") throw new Error("Invalid workspace grant signature")
      imported.push(bundle.id)
    })
    internal.notify = async () => {}

    await mesh.mergeWorkspace("workspace-1", {
      version: 1,
      peers: [{ id: "poisoned" }, { id: "owner-phone" }],
      revocations: [],
    })

    expect(imported).toEqual(["owner-phone"])
    await mesh.dispose()
  })

  it("Given an enrolled owner device, when it opens an existing workspace, then its certificate can verify new grants", async () => {
    resetIdentityStorageForTest()
    const owner = await bootstrapIdentity("Owner")
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair
    const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)))
    const deviceId = await sha256Base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)))
    const certificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
      owner.identity.personId, deviceId, publicKey, await certHashDefault(owner.certificate))
    const enrolledOwner: LocalProfile = {
      identity: owner.identity,
      device: { deviceId, publicKey, displayName: "Owner phone" },
      certificate,
      privateKeys: { devicePrivateKey: keyPair.privateKey },
    }
    let credential = {
      version: 1 as const,
      workspaceId: "workspace-1",
      ownerPersonId: owner.identity.personId,
      ownerPublicKey: owner.identity.publicKey,
      ownerCertificates: [owner.certificate],
      transportSecret: "mesh-secret",
      epoch: 1,
      updatedAt: new Date(0).toISOString(),
    }
    const store = {
      getWorkspaceCredential: async () => structuredClone(credential),
      putWorkspaceCredential: async (next: typeof credential) => { credential = structuredClone(next) },
    }
    const mesh = new DurableMesh({
      transport: {} as never,
      workspaceStore: {} as never,
      workspace: {} as never,
      getProfile: async () => enrolledOwner,
      store: store as never,
    })
    const internal = mesh as any
    internal.putVerifiedBundle = vi.fn(async () => {})
    internal.notify = vi.fn(async () => {})

    await mesh.ensureOwnerWorkspaces(["workspace-1"], "owner-phone-endpoint", enrolledOwner)
    const grant = await createWorkspaceGrant(enrolledOwner, "workspace-1", "editor-person", "editor")

    await expect(verifyWorkspaceGrant(grant, {
      workspaceId: "workspace-1",
      personId: "editor-person",
      ownerPersonId: owner.identity.personId,
      ownerPublicKey: owner.identity.publicKey,
      ownerCertificates: credential.ownerCertificates,
    })).resolves.toBe("editor")
    expect(credential.ownerCertificates.map(item => item.payload.deviceId)).toContain(deviceId)
    await mesh.dispose()
  })
})
