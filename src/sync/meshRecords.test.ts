import { describe, it, expect, beforeEach } from "vitest"
import {
  bootstrapIdentity,
  resetIdentityStorageForTest,
  signEnvelope,
  type LocalProfile,
} from "../domain/identity"
import {
  certHashDefault,
  createDelegatedCertificate,
  createWorkspaceGrant,
} from "../domain/proofs"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import {
  createPeerAdvertisement,
  createWorkspaceMemberBundle,
  verifyDeviceChain,
  verifyWorkspaceMemberBundle,
  verifyPeerAdvertisement,
  keyId,
  MAX_PEER_ADVERTISEMENT_SIZE,
  createWorkspaceRevocation,
  verifyWorkspaceRevocation,
  createWorkspaceOwnershipTransfer,
  verifyWorkspaceOwnershipTransfer,
} from "./meshRecords"

describe("Mesh records cryptographic admission (src/sync/meshRecords.ts)", () => {
  const workspaceId = "ws_mesh_alpha"

  beforeEach(() => {
    resetIdentityStorageForTest()
  })

  describe("ownership transfer", () => {
    it("Given an owner and editor, when ownership transfers, then the signed record promotes editor and demotes former owner", async () => {
      const owner = await createProfile("Current Owner")
      const editor = await createProfile("Next Owner")
      const transfer = await createWorkspaceOwnershipTransfer(owner, workspaceId, {
        personId: editor.identity.personId,
        publicKey: editor.identity.publicKey,
        certificates: [editor.certificate],
      }, ["head-before-transfer"], 2)

      await expect(verifyWorkspaceOwnershipTransfer(transfer, workspaceId, {
        personId: owner.identity.personId,
        publicKey: owner.identity.publicKey,
        certificates: [owner.certificate],
      }, 1)).resolves.toEqual(transfer)
      expect(transfer.payload.toOwnerGrant.payload.role).toBe("owner")
      expect(transfer.payload.formerOwnerGrant.payload.role).toBe("editor")
    })

    it("Given a forged transfer, when verified, then ownership stays untrusted", async () => {
      const owner = await createProfile("Current Owner")
      const editor = await createProfile("Next Owner")
      const transfer = await createWorkspaceOwnershipTransfer(owner, workspaceId, {
        personId: editor.identity.personId,
        publicKey: editor.identity.publicKey,
        certificates: [editor.certificate],
      }, ["head-before-transfer"], 2)
      transfer.payload.toOwnerPersonId = owner.identity.personId

      await expect(verifyWorkspaceOwnershipTransfer(transfer, workspaceId, {
        personId: owner.identity.personId,
        publicKey: owner.identity.publicKey,
        certificates: [owner.certificate],
      }, 1)).rejects.toThrow(/ownership transfer/i)
    })
  })

  async function createProfile(displayName: string): Promise<LocalProfile> {
    resetIdentityStorageForTest()
    return await bootstrapIdentity(displayName)
  }

  async function createSecondaryDevice(
    owner: LocalProfile,
    deviceName: string,
    delegator?: { privateKey: CryptoKey; deviceId: string; cert: DeviceCertificate }
  ): Promise<{
    deviceId: string
    publicKey: string
    privateKey: CryptoKey
    certificate: DeviceCertificate
  }> {
    const keyPair = (await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair

    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))
    const { sha256Base64Url, toBase64Url } = await import("../domain/identity")
    const deviceId = await sha256Base64Url(rawPub)
    const publicKey = toBase64Url(rawPub)

    const delegatorKey = delegator ? delegator.privateKey : owner.privateKeys.devicePrivateKey
    const delegatorId = delegator ? delegator.deviceId : owner.device.deviceId
    const parentCert = delegator ? delegator.cert : owner.certificate

    const cert = await createDelegatedCertificate(
      delegatorKey,
      delegatorId,
      owner.identity.personId,
      deviceId,
      publicKey,
      await certHashDefault(parentCert)
    )

    return {
      deviceId,
      publicKey,
      privateKey: keyPair.privateKey,
      certificate: cert,
    }
  }

  describe("1. Reusable verifyDeviceChain", () => {
    it("verifies single root device certificate chain and returns device public key", async () => {
      const owner = await createProfile("Alice Root")
      const devKey = await verifyDeviceChain(
        owner.identity.publicKey,
        owner.device.deviceId,
        [owner.certificate]
      )
      expect(devKey).toBe(owner.device.publicKey)
    })

    it("verifies multi-hop delegated device certificate chain (depth 2)", async () => {
      const owner = await createProfile("Alice Delegator")
      const secondary = await createSecondaryDevice(owner, "Alice Laptop")

      const devKey = await verifyDeviceChain(
        owner.identity.publicKey,
        secondary.deviceId,
        [owner.certificate, secondary.certificate]
      )
      expect(devKey).toBe(secondary.publicKey)
    })

    it("verifies 3-tier multi-hop delegation chain (root -> dev1 -> dev2)", async () => {
      const owner = await createProfile("Alice MultiHop")
      const dev1 = await createSecondaryDevice(owner, "Alice Laptop")
      const dev2 = await createSecondaryDevice(owner, "Alice Phone", {
        privateKey: dev1.privateKey,
        deviceId: dev1.deviceId,
        cert: dev1.certificate,
      })

      const devKey = await verifyDeviceChain(
        owner.identity.publicKey,
        dev2.deviceId,
        [owner.certificate, dev1.certificate, dev2.certificate]
      )
      expect(devKey).toBe(dev2.publicKey)
    })

    it("supports options object parameter signature", async () => {
      const owner = await createProfile("Alice Options")
      const devKey = await verifyDeviceChain({
        personId: owner.identity.personId,
        publicKey: owner.identity.publicKey,
        deviceId: owner.device.deviceId,
        certificates: [owner.certificate],
      })
      expect(devKey).toBe(owner.device.publicKey)
    })

    it("supports 4 positional arguments (personId, publicKey, deviceId, certificates)", async () => {
      const owner = await createProfile("Alice Positional 4")
      const devKey = await verifyDeviceChain(
        owner.identity.personId,
        owner.identity.publicKey,
        owner.device.deviceId,
        [owner.certificate]
      )
      expect(devKey).toBe(owner.device.publicKey)
    })

    it("supports array-first argument signature (certificates, publicKey, deviceId)", async () => {
      const owner = await createProfile("Alice Array First")
      const devKey = await verifyDeviceChain(
        [owner.certificate],
        owner.identity.publicKey,
        owner.device.deviceId
      )
      expect(devKey).toBe(owner.device.publicKey)
    })

    it("rejects when target device certificate is missing", async () => {
      const owner = await createProfile("Alice Missing")
      await expect(
        verifyDeviceChain(owner.identity.publicKey, "non_existent_device", [owner.certificate])
      ).rejects.toThrow(/missing/i)
    })

    it("rejects when intermediate issuer certificate is missing in delegated chain", async () => {
      const owner = await createProfile("Alice Incomplete")
      const secondary = await createSecondaryDevice(owner, "Alice Laptop")

      await expect(
        verifyDeviceChain(owner.identity.publicKey, secondary.deviceId, [secondary.certificate])
      ).rejects.toThrow(/missing/i)
    })

    it("rejects when root signature is tampered", async () => {
      const owner = await createProfile("Alice Tampered")
      const tamperedRoot: DeviceCertificate = {
        ...owner.certificate,
        signature: owner.certificate.signature.slice(0, -4) + "AAAA",
      }

      await expect(
        verifyDeviceChain(owner.identity.publicKey, owner.device.deviceId, [tamperedRoot])
      ).rejects.toThrow(/signature/i)
    })

    it("rejects when delegated certificate signature is tampered", async () => {
      const owner = await createProfile("Alice Tampered Delegated")
      const secondary = await createSecondaryDevice(owner, "Alice Phone")
      const tamperedDelegated: DeviceCertificate = {
        ...secondary.certificate,
        signature: secondary.certificate.signature.slice(0, -4) + "AAAA",
      }

      await expect(
        verifyDeviceChain(
          owner.identity.publicKey,
          secondary.deviceId,
          [owner.certificate, tamperedDelegated]
        )
      ).rejects.toThrow(/signature/i)
    })

    it("rejects when identity public key does not match personId", async () => {
      const alice = await createProfile("Alice One")
      const bob = await createProfile("Bob Two")

      await expect(
        verifyDeviceChain({
          personId: alice.identity.personId,
          publicKey: bob.identity.publicKey,
          deviceId: alice.device.deviceId,
          certificates: [alice.certificate],
        })
      ).rejects.toThrow(/match/i)
    })

    it("rejects cyclical certificate chain", async () => {
      const owner = await createProfile("Alice Cycle")
      const cyclicCert: DeviceCertificate = {
        ...owner.certificate,
        payload: {
          ...owner.certificate.payload,
          issuerCertificateHash: "self_hash",
        },
      }
      const selfHash = await certHashDefault(cyclicCert)
      cyclicCert.payload.issuerCertificateHash = selfHash

      await expect(
        verifyDeviceChain(owner.identity.publicKey, owner.device.deviceId, [cyclicCert])
      ).rejects.toThrow()
    })

    it("rejects when issuer certificate lacks canEnrollDevices capability", async () => {
      const owner = await createProfile("Alice No Enroll")

      const noEnrollCert: DeviceCertificate = {
        ...owner.certificate,
        payload: {
          ...owner.certificate.payload,
          canEnrollDevices: false as any,
        },
      }

      const keyPair = (await crypto.subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"]
      )) as CryptoKeyPair
      const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))
      const { sha256Base64Url, toBase64Url } = await import("../domain/identity")
      const secondaryDeviceId = await sha256Base64Url(rawPub)
      const secondaryPublicKey = toBase64Url(rawPub)

      const secondaryCert = await createDelegatedCertificate(
        owner.privateKeys.devicePrivateKey,
        owner.device.deviceId,
        owner.identity.personId,
        secondaryDeviceId,
        secondaryPublicKey,
        await certHashDefault(noEnrollCert)
      )

      await expect(
        verifyDeviceChain(
          owner.identity.publicKey,
          secondaryDeviceId,
          [noEnrollCert, secondaryCert]
        )
      ).rejects.toThrow(/canEnrollDevices/i)
    })

    it("rejects when delegated certificate signerKeyId does not match issuer deviceId", async () => {
      const owner = await createProfile("Alice Wrong Signer")
      const secondary = await createSecondaryDevice(owner, "Secondary Device")

      const mismatchedSigner: DeviceCertificate = {
        ...secondary.certificate,
        signerKeyId: "different_device_id",
      }

      await expect(
        verifyDeviceChain(
          owner.identity.publicKey,
          secondary.deviceId,
          [owner.certificate, mismatchedSigner]
        )
      ).rejects.toThrow(/signerKeyId/i)
    })
  })

  describe("2. Owner PeerAdvertisement admission", () => {
    it("admits owner peer advertisement without grant", async () => {
      const owner = await createProfile("Workspace Owner Alice")
      const bundle = await createPeerAdvertisement(owner, workspaceId, "iroh://alice-node-1")

      const verified = await verifyWorkspaceMemberBundle(
        bundle,
        workspaceId,
        owner.identity.publicKey
      )

      expect(verified.role).toBe("owner")
      expect(verified.payload.workspaceId).toBe(workspaceId)
      expect(verified.payload.personId).toBe(owner.identity.personId)
      expect(verified.payload.deviceId).toBe(owner.device.deviceId)
      expect(verified.payload.endpoint).toBe("iroh://alice-node-1")
      expect(verified.grant).toBeUndefined()
    })

    it("supports verifyPeerAdvertisement alias", async () => {
      const owner = await createProfile("Owner Alias Test")
      const bundle = await createWorkspaceMemberBundle(owner, workspaceId, "iroh://alice-node-alias")

      const verified = await verifyPeerAdvertisement(
        bundle,
        workspaceId,
        owner.identity.publicKey
      )

      expect(verified.role).toBe("owner")
    })

    it("admits owner peer advertisement created by secondary delegated device", async () => {
      const owner = await createProfile("Owner Primary")
      const secondary = await createSecondaryDevice(owner, "Owner Secondary Device")

      const secondaryProfile: LocalProfile = {
        identity: owner.identity,
        device: {
          deviceId: secondary.deviceId,
          publicKey: secondary.publicKey,
          displayName: "Owner Secondary Device",
        },
        certificate: secondary.certificate,
        privateKeys: {
          devicePrivateKey: secondary.privateKey,
        },
      }

      const bundle = await createPeerAdvertisement(secondaryProfile, {
        workspaceId,
        endpoint: "iroh://alice-secondary",
        certificates: [owner.certificate, secondary.certificate],
      })

      const verified = await verifyWorkspaceMemberBundle(
        bundle,
        workspaceId,
        owner.identity.publicKey
      )

      expect(verified.role).toBe("owner")
      expect(verified.payload.deviceId).toBe(secondary.deviceId)
      expect(verified.payload.personId).toBe(owner.identity.personId)
    })

    it("supports creation with options object containing profile", async () => {
      const owner = await createProfile("Owner Options Call")
      const bundle = await createPeerAdvertisement({
        profile: owner,
        workspaceId,
        endpoint: "iroh://opt-call",
      })
      const verified = await verifyWorkspaceMemberBundle(bundle, workspaceId, owner.identity.publicKey)
      expect(verified.role).toBe("owner")
    })
  })

  describe("3. Editor PeerAdvertisement admission with WorkspaceGrant", () => {
    it("admits editor with root-signed grant when signerKeyId is owner device ID", async () => {
      const owner = await createProfile("Workspace Owner Alice")
      const editor = await createProfile("Guest Editor Bob")

      // Existing invitations sign with root identity key, but label signerKeyId as deviceId
      const grantPayload = {
        kind: "workspace-grant" as const,
        version: 1 as const,
        grantId: crypto.randomUUID(),
        workspaceId,
        personId: editor.identity.personId,
        role: "editor" as const,
      }
      const rootSignedGrant = (await signEnvelope(
        owner.privateKeys.identityPrivateKey!,
        grantPayload,
        owner.device.deviceId
      )) as unknown as WorkspaceGrant

      const bundle = await createWorkspaceMemberBundle(editor, {
        workspaceId,
        endpoint: "iroh://bob-editor",
        grant: rootSignedGrant,
        ownerPublicKey: owner.identity.publicKey,
      })

      const verified = await verifyWorkspaceMemberBundle(
        bundle,
        workspaceId,
        owner.identity.publicKey
      )

      expect(verified.role).toBe("editor")
      expect(verified.payload.personId).toBe(editor.identity.personId)
      expect(verified.grant).toBeDefined()
      expect(verified.grant?.payload.grantId).toBe(grantPayload.grantId)
    })

    it("admits editor with grant signed by owner delegated device key with owner cert chain", async () => {
      const owner = await createProfile("Workspace Owner Alice")
      const ownerSecondary = await createSecondaryDevice(owner, "Owner Laptop")
      const editor = await createProfile("Guest Editor Bob")

      // Grant signed by owner's secondary device key
      const grantPayload = {
        kind: "workspace-grant" as const,
        version: 1 as const,
        grantId: crypto.randomUUID(),
        workspaceId,
        personId: editor.identity.personId,
        role: "editor" as const,
      }
      const deviceSignedGrant = (await signEnvelope(
        ownerSecondary.privateKey,
        grantPayload,
        ownerSecondary.deviceId
      )) as unknown as WorkspaceGrant

      const bundle = await createWorkspaceMemberBundle(editor, {
        workspaceId,
        endpoint: "iroh://bob-editor-2",
        grant: deviceSignedGrant,
        ownerPublicKey: owner.identity.publicKey,
        ownerCertificates: [owner.certificate, ownerSecondary.certificate],
      })

      const verified = await verifyWorkspaceMemberBundle(
        bundle,
        workspaceId,
        owner.identity.publicKey
      )

      expect(verified.role).toBe("editor")
      expect(verified.grant?.signerKeyId).toBe(ownerSecondary.deviceId)
    })

    it("Given a stale owner chain, when a peer carries the enrolled owner certificate, then its grant verifies", async () => {
      const owner = await createProfile("Workspace Owner Alice")
      const ownerSecondary = await createSecondaryDevice(owner, "Owner Phone")
      const editor = await createProfile("Guest Editor Bob")
      const grant = await signEnvelope(ownerSecondary.privateKey, {
        kind: "workspace-grant" as const,
        version: 1 as const,
        grantId: crypto.randomUUID(),
        workspaceId,
        personId: editor.identity.personId,
        role: "editor" as const,
      }, ownerSecondary.deviceId) as WorkspaceGrant
      const bundle = await createWorkspaceMemberBundle(editor, {
        workspaceId,
        endpoint: "iroh://bob-with-fresh-owner-chain",
        grant,
        ownerPublicKey: owner.identity.publicKey,
        ownerCertificates: [owner.certificate, ownerSecondary.certificate],
      })

      const verified = await verifyWorkspaceMemberBundle(bundle, {
        workspaceId,
        ownerPersonId: owner.identity.personId,
        ownerPublicKey: owner.identity.publicKey,
        ownerCertificates: [owner.certificate],
      })

      expect(verified.role).toBe("editor")
      expect(verified.ownerCertificates?.map(item => item.payload.deviceId)).toContain(ownerSecondary.deviceId)
    })

    it("admits editor whose advertisement is from a secondary device", async () => {
      const owner = await createProfile("Workspace Owner Alice")
      const editor = await createProfile("Guest Editor Bob")
      const editorSecondary = await createSecondaryDevice(editor, "Bob Phone")

      const grant = await createWorkspaceGrant(
        owner,
        workspaceId,
        editor.identity.personId,
        "editor"
      )

      const editorSecProfile: LocalProfile = {
        identity: editor.identity,
        device: {
          deviceId: editorSecondary.deviceId,
          publicKey: editorSecondary.publicKey,
          displayName: "Bob Phone",
        },
        certificate: editorSecondary.certificate,
        privateKeys: {
          devicePrivateKey: editorSecondary.privateKey,
        },
      }

      const bundle = await createWorkspaceMemberBundle(editorSecProfile, {
        workspaceId,
        endpoint: "iroh://bob-phone",
        certificates: [editor.certificate, editorSecondary.certificate],
        grant,
        ownerPublicKey: owner.identity.publicKey,
        ownerCertificates: [owner.certificate],
      })

      const verified = await verifyWorkspaceMemberBundle(
        bundle,
        workspaceId,
        owner.identity.publicKey
      )

      expect(verified.role).toBe("editor")
      expect(verified.payload.deviceId).toBe(editorSecondary.deviceId)
    })

    it("admits bundle using signed property alias instead of advertisement", async () => {
      const owner = await createProfile("Owner Alice")
      const bundle = await createPeerAdvertisement(owner, workspaceId, "iroh://signed-alias")
      const aliasBundle = {
        signed: bundle.advertisement,
        publicKey: bundle.publicKey,
        certificates: bundle.certificates,
      }

      const verified = await verifyWorkspaceMemberBundle(aliasBundle, workspaceId, owner.identity.publicKey)
      expect(verified.role).toBe("owner")
    })
  })

  describe("4. Non-owner grant enforcement and invalid grant rejection", () => {
    it("rejects non-owner advertisement without workspace grant", async () => {
      const owner = await createProfile("Owner Alice")
      const stranger = await createProfile("Stranger Bob")

      const bundle = await createPeerAdvertisement(stranger, workspaceId, "iroh://stranger")

      await expect(
        verifyWorkspaceMemberBundle(bundle, workspaceId, owner.identity.publicKey)
      ).rejects.toThrow(/grant/i)
    })

    it("rejects grant issued for different workspace", async () => {
      const owner = await createProfile("Owner Alice")
      const editor = await createProfile("Editor Bob")

      const grantOtherWs = await createWorkspaceGrant(
        owner,
        "ws_other_beta",
        editor.identity.personId,
        "editor"
      )

      const bundle = await createWorkspaceMemberBundle(editor, {
        workspaceId,
        endpoint: "iroh://bob",
        grant: grantOtherWs,
        ownerPublicKey: owner.identity.publicKey,
      })

      await expect(
        verifyWorkspaceMemberBundle(bundle, workspaceId, owner.identity.publicKey)
      ).rejects.toThrow(/workspace grant/i)
    })

    it("rejects grant issued for different personId", async () => {
      const owner = await createProfile("Owner Alice")
      const editor = await createProfile("Editor Bob")
      const charlie = await createProfile("Charlie")

      // Grant issued to Charlie, used by Bob
      const grantForCharlie = await createWorkspaceGrant(
        owner,
        workspaceId,
        charlie.identity.personId,
        "editor"
      )

      const bundle = await createWorkspaceMemberBundle(editor, {
        workspaceId,
        endpoint: "iroh://bob",
        grant: grantForCharlie,
        ownerPublicKey: owner.identity.publicKey,
      })

      await expect(
        verifyWorkspaceMemberBundle(bundle, workspaceId, owner.identity.publicKey)
      ).rejects.toThrow(/workspace grant/i)
    })

    it("rejects grant signed by untrusted 3rd party rather than owner", async () => {
      const owner = await createProfile("Owner Alice")
      const imposter = await createProfile("Imposter Mallory")
      const editor = await createProfile("Editor Bob")

      // Imposter attempts to sign a grant for Bob
      const fakeGrant = await createWorkspaceGrant(
        imposter,
        workspaceId,
        editor.identity.personId,
        "editor"
      )

      const bundle = await createWorkspaceMemberBundle(editor, {
        workspaceId,
        endpoint: "iroh://bob",
        grant: fakeGrant,
        ownerPublicKey: owner.identity.publicKey,
        ownerCertificates: [imposter.certificate],
      })

      await expect(
        verifyWorkspaceMemberBundle(bundle, workspaceId, owner.identity.publicKey)
      ).rejects.toThrow(/grant signature/i)
    })

    it("rejects grant with invalid role", async () => {
      const owner = await createProfile("Owner Alice")
      const editor = await createProfile("Editor Bob")

      const grant = await createWorkspaceGrant(owner, workspaceId, editor.identity.personId, "editor")
      ;(grant.payload as any).role = "invalid_role"

      const bundle = await createWorkspaceMemberBundle(editor, {
        workspaceId,
        endpoint: "iroh://bob",
        grant,
        ownerPublicKey: owner.identity.publicKey,
      })

      await expect(
        verifyWorkspaceMemberBundle(bundle, workspaceId, owner.identity.publicKey)
      ).rejects.toThrow(/workspace grant/i)
    })
  })

  describe("5. Timestamp rules: within 5m future, max 30d stale", () => {
    it("admits timestamp within 4 minutes in future", async () => {
      const owner = await createProfile("Owner Alice")
      const now = Date.now()
      const futureDate = new Date(now + 4 * 60 * 1000).toISOString()

      const bundle = await createPeerAdvertisement(owner, {
        workspaceId,
        endpoint: "iroh://future-4m",
        issuedAt: futureDate,
      })

      const verified = await verifyWorkspaceMemberBundle(
        bundle,
        { workspaceId, ownerPublicKey: owner.identity.publicKey, now }
      )
      expect(verified).toBeDefined()
    })

    it("rejects timestamp exceeding 5 minutes in future", async () => {
      const owner = await createProfile("Owner Alice")
      const now = Date.now()
      const futureDate = new Date(now + 6 * 60 * 1000).toISOString()

      const bundle = await createPeerAdvertisement(owner, {
        workspaceId,
        endpoint: "iroh://future-6m",
        issuedAt: futureDate,
      })

      await expect(
        verifyWorkspaceMemberBundle(
          bundle,
          { workspaceId, ownerPublicKey: owner.identity.publicKey, now }
        )
      ).rejects.toThrow(/future/i)
    })

    it("admits timestamp within 29 days stale", async () => {
      const owner = await createProfile("Owner Alice")
      const now = Date.now()
      const past29Days = new Date(now - 29 * 24 * 60 * 60 * 1000).toISOString()

      const bundle = await createPeerAdvertisement(owner, {
        workspaceId,
        endpoint: "iroh://past-29d",
        issuedAt: past29Days,
      })

      const verified = await verifyWorkspaceMemberBundle(
        bundle,
        { workspaceId, ownerPublicKey: owner.identity.publicKey, now }
      )
      expect(verified).toBeDefined()
    })

    it("rejects timestamp older than 30 days stale", async () => {
      const owner = await createProfile("Owner Alice")
      const now = Date.now()
      const past31Days = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString()

      const bundle = await createPeerAdvertisement(owner, {
        workspaceId,
        endpoint: "iroh://past-31d",
        issuedAt: past31Days,
      })

      await expect(
        verifyWorkspaceMemberBundle(
          bundle,
          { workspaceId, ownerPublicKey: owner.identity.publicKey, now }
        )
      ).rejects.toThrow(/stale|expired/i)
    })

    it("rejects non-canonical or invalid ISO timestamp format", async () => {
      const owner = await createProfile("Owner Alice")

      const bundle = await createPeerAdvertisement(owner, workspaceId, "iroh://bad-date")
      ;(bundle.advertisement.payload as any).issuedAt = "2026-09-11 12:00:00"

      await expect(
        verifyWorkspaceMemberBundle(bundle, workspaceId, owner.identity.publicKey)
      ).rejects.toThrow(/timestamp/i)
    })
  })

  describe("6. Bounded serialized size", () => {
    it("rejects peer advertisement exceeding bounded size limit", async () => {
      const owner = await createProfile("Owner Alice")
      const bundle = await createPeerAdvertisement(owner, workspaceId, "iroh://endpoint")

      // Attach oversized padding
      const oversized = {
        ...bundle,
        extraGarbage: "X".repeat(MAX_PEER_ADVERTISEMENT_SIZE + 1024),
      }

      await expect(
        verifyWorkspaceMemberBundle(oversized, workspaceId, owner.identity.publicKey)
      ).rejects.toThrow(/too large/i)
    })

    it("respects custom maxByteLength option", async () => {
      const owner = await createProfile("Owner Alice")
      const bundle = await createPeerAdvertisement(owner, workspaceId, "iroh://small")

      await expect(
        verifyWorkspaceMemberBundle(bundle, {
          workspaceId,
          ownerPublicKey: owner.identity.publicKey,
          maxByteLength: 100,
        })
      ).rejects.toThrow(/too large/i)
    })
  })

  describe("7. Signature and payload integrity", () => {
    it("rejects when endpoint has been tampered in payload", async () => {
      const owner = await createProfile("Owner Alice")
      const bundle = await createPeerAdvertisement(owner, workspaceId, "iroh://original")

      // Tamper endpoint without updating signature
      bundle.advertisement.payload.endpoint = "iroh://tampered"

      await expect(
        verifyWorkspaceMemberBundle(bundle, workspaceId, owner.identity.publicKey)
      ).rejects.toThrow(/signature/i)
    })

    it("rejects when workspaceId does not match expected workspace", async () => {
      const owner = await createProfile("Owner Alice")
      const bundle = await createPeerAdvertisement(owner, "ws_different", "iroh://node")

      await expect(
        verifyWorkspaceMemberBundle(bundle, workspaceId, owner.identity.publicKey)
      ).rejects.toThrow(/workspace/i)
    })

    it("rejects when identity public key is replaced", async () => {
      const owner = await createProfile("Owner Alice")
      const stranger = await createProfile("Stranger")

      const bundle = await createPeerAdvertisement(owner, workspaceId, "iroh://node")
      bundle.publicKey = stranger.identity.publicKey

      await expect(
        verifyWorkspaceMemberBundle(bundle, workspaceId, owner.identity.publicKey)
      ).rejects.toThrow(/identity/i)
    })

    it("rejects when deviceId is tampered in payload", async () => {
      const owner = await createProfile("Owner Alice")
      const bundle = await createPeerAdvertisement(owner, workspaceId, "iroh://node")

      bundle.advertisement.payload.deviceId = "tampered_device_id"

      await expect(
        verifyWorkspaceMemberBundle(bundle, workspaceId, owner.identity.publicKey)
      ).rejects.toThrow()
    })

    it("rejects when signerKeyId does not match deviceId", async () => {
      const owner = await createProfile("Owner Alice")
      const bundle = await createPeerAdvertisement(owner, workspaceId, "iroh://node")

      bundle.advertisement.signerKeyId = "mismatched_signer"

      await expect(
        verifyWorkspaceMemberBundle(bundle, workspaceId, owner.identity.publicKey)
      ).rejects.toThrow(/signerKeyId/i)
    })
  })

  describe("8. keyId utility", () => {
    it("computes exact sha256 base64url of raw 32-byte public key", async () => {
      const owner = await createProfile("KeyId Test")
      const computedId = await keyId(owner.identity.publicKey)
      expect(computedId).toBe(owner.identity.personId)
    })

    it("rejects non-string or invalid length public keys", async () => {
      await expect(keyId("")).rejects.toThrow()
      await expect(keyId("bm90XzMyX2J5dGVz")).rejects.toThrow(/32 bytes/)
    })
  })

  describe("9. owner-authoritative revocation", () => {
    it("accepts an owner-signed monotonic tombstone", async () => {
      const owner = await createProfile("Owner")
      const record = await createWorkspaceRevocation(owner, workspaceId, "person_removed", 2)
      await expect(verifyWorkspaceRevocation(record, workspaceId, owner.identity.personId,
        owner.identity.publicKey, [owner.certificate])).resolves.toEqual(record)
    })

    it("rejects a tombstone signed by another identity", async () => {
      const owner = await createProfile("Owner")
      const attacker = await createProfile("Attacker")
      const record = await createWorkspaceRevocation(attacker, workspaceId, "person_removed", 2)
      await expect(verifyWorkspaceRevocation(record, workspaceId, owner.identity.personId,
        owner.identity.publicKey, [owner.certificate])).rejects.toThrow()
    })
  })
})
