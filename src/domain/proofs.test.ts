import { describe, expect, it, beforeEach } from "vitest"
import {
  canonicalizeJson,
  signEnvelope,
  verifyEnvelope,
  bootstrapIdentity,
  resetIdentityStorageForTest,
  sha256Base64Url,
  createActorBinding,
} from "./identity"
import {
  validateCertificateChain,
  createDelegatedCertificate,
  createWorkspaceGenesis,
  createWorkspaceGrant,
  verifyActorBinding,
  verifyWorkspaceGrant,
  verifyWorkspaceGenesis,
  ProofStore,
} from "./proofs"
import type { DeviceCertificate } from "./model"

describe("Cryptographic proofs, authority, and certificate chains (Task 2.2)", () => {
  beforeEach(() => {
    resetIdentityStorageForTest()
  })

  it("Given grants for two workspaces, when one leaves the mesh, then only that workspace grants are removed", async () => {
    const owner = await bootstrapIdentity("Owner")
    const store = new ProofStore()
    const alpha = await createWorkspaceGrant(owner, "ws_alpha", "member", "editor")
    const beta = await createWorkspaceGrant(owner, "ws_beta", "member", "visitor")
    await store.putGrant(alpha.payload.grantId, alpha)
    await store.putGrant(beta.payload.grantId, beta)

    await store.removeWorkspaceGrants("ws_alpha")

    expect(await store.listGrants("ws_alpha")).toEqual([])
    expect(await store.listGrants("ws_beta")).toEqual([beta])
  })

  it("canonicalizes JSON according to RFC 8785 and rejects non-finite numbers", () => {
    const a = { z: 1, a: "hello", m: [3, 2, 1] }
    const b = { a: "hello", m: [3, 2, 1], z: 1 }
    expect(canonicalizeJson(a)).toBe(canonicalizeJson(b))
    expect(canonicalizeJson(a)).toBe('{"a":"hello","m":[3,2,1],"z":1}')

    expect(() => canonicalizeJson({ invalid: Infinity })).toThrow(/non-finite/i)
    expect(() => canonicalizeJson({ invalid: NaN })).toThrow(/non-finite/i)
  })

  it("verifies signatures and detects tampering", async () => {
    const profile = await bootstrapIdentity("Tamper Test")
    const payload = { kind: "test-payload", version: 1, message: "original" }
    const signed = await signEnvelope(profile.privateKeys.devicePrivateKey, payload, profile.device.deviceId)

    // Valid signature
    expect(await verifyEnvelope(signed, profile.device.publicKey)).toBe(true)

    // Tampered payload
    const tamperedPayload = { ...signed, payload: { ...payload, message: "tampered" } }
    expect(await verifyEnvelope(tamperedPayload, profile.device.publicKey)).toBe(false)

    // Tampered signature
    const tamperedSig = { ...signed, signature: signed.signature.slice(0, -4) + "AAAA" }
    expect(await verifyEnvelope(tamperedSig, profile.device.publicKey)).toBe(false)
  })

  it("validates root-issued device certificates", async () => {
    const profile = await bootstrapIdentity("Alice")
    const valid = await validateCertificateChain(profile.certificate, profile.identity.publicKey, [])
    expect(valid.ok).toBe(true)
  })

  it("validates delegated device certificates across chains", async () => {
    const profile = await bootstrapIdentity("Alice")

    // Device 2
    const dev2KeyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair
    const dev2RawPub = new Uint8Array(await crypto.subtle.exportKey("raw", dev2KeyPair.publicKey))
    const dev2Id = await sha256Base64Url(dev2RawPub)
    const dev2Pub = btoa(String.fromCharCode(...dev2RawPub)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

    // Calculate cert 1 hash
    const cert1Bytes = new TextEncoder().encode(canonicalizeJson(profile.certificate))
    const cert1Hash = await sha256Base64Url(cert1Bytes)

    // Device 1 (authorized to enroll) delegates to Device 2
    const cert2 = await createDelegatedCertificate(
      profile.privateKeys.devicePrivateKey,
      profile.device.deviceId,
      profile.identity.personId,
      dev2Id,
      dev2Pub,
      cert1Hash
    )

    // Validate chain: cert2 -> cert1 -> identity
    const valid = await validateCertificateChain(cert2, profile.identity.publicKey, [profile.certificate])
    expect(valid.ok).toBe(true)
  })

  it("detects and rejects cycles in certificate chains", async () => {
    const profile = await bootstrapIdentity("Alice")

    // Create a circular chain: cert A -> cert B -> cert A
    const fakeCertA: DeviceCertificate = {
      payload: {
        kind: "device-certificate",
        version: 1,
        personId: profile.identity.personId,
        deviceId: "dev_A",
        devicePublicKey: profile.device.publicKey,
        issuerCertificateHash: "hash_B",
        canEnrollDevices: true,
      },
      signerKeyId: "dev_B",
      signature: profile.certificate.signature,
    }

    const fakeCertB: DeviceCertificate = {
      payload: {
        kind: "device-certificate",
        version: 1,
        personId: profile.identity.personId,
        deviceId: "dev_B",
        devicePublicKey: profile.device.publicKey,
        issuerCertificateHash: "hash_A",
        canEnrollDevices: true,
      },
      signerKeyId: "dev_A",
      signature: profile.certificate.signature,
    }

    const pool = [fakeCertA, fakeCertB]
    const res = await validateCertificateChain(fakeCertA, profile.identity.publicKey, pool, {
      hashFn: (c) => (c === fakeCertA ? "hash_A" : "hash_B"),
      skipSigVerify: true,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toMatch(/cycle/i)
    }
  })

  it("rejects chains exceeding maximum depth 32", async () => {
    const profile = await bootstrapIdentity("Alice")
    // Build a mock chain with 33 levels
    const pool: DeviceCertificate[] = []
    let prevHash: string | null = null

    for (let i = 0; i < 35; i++) {
      const cert: DeviceCertificate = {
        payload: {
          kind: "device-certificate",
          version: 1,
          personId: profile.identity.personId,
          deviceId: `dev_${i}`,
          devicePublicKey: profile.device.publicKey,
          issuerCertificateHash: prevHash,
          canEnrollDevices: true,
        },
        signerKeyId: i === 0 ? profile.identity.personId : `dev_${i - 1}`,
        signature: profile.certificate.signature,
      }
      pool.push(cert)
      prevHash = `hash_${i}`
    }

    const deepestCert = pool[pool.length - 1]
    const res = await validateCertificateChain(deepestCert, profile.identity.publicKey, pool, {
      hashFn: (c) => `hash_${c.payload.deviceId.replace("dev_", "")}`,
      skipSigVerify: true,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toMatch(/depth/i)
    }
  })

  it("creates and verifies workspace genesis and grants", async () => {
    const profile = await bootstrapIdentity("Alice")
    const genesis = await createWorkspaceGenesis(profile, "ws_123", ["head_1"])
    const validGenesis = await verifyWorkspaceGenesis(genesis, profile.identity.publicKey)
    expect(validGenesis).toBe(true)

    // Issue grant to Bob
    const grant = await createWorkspaceGrant(profile, "ws_123", "person_bob", "editor")
    const validGrant = await verifyWorkspaceGrant(grant, profile.device.publicKey)
    expect(validGrant).toBe(true)
    expect(grant.payload.role).toBe("editor")
  })

  it("stores and queries proofs in ProofStore", async () => {
    const profile = await bootstrapIdentity("Alice")
    const store = new ProofStore()

    const binding = await createActorBinding(profile, "ws_123", "actor_1")
    const bindingBytes = new TextEncoder().encode(canonicalizeJson(binding))
    const bindingHash = await sha256Base64Url(bindingBytes)

    await store.putActorBinding(bindingHash, binding)
    const retrieved = await store.getActorBinding(bindingHash)
    expect(retrieved).toBeDefined()
    expect(retrieved?.payload.actorId).toBe("actor_1")
  })
})
