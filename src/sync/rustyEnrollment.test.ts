import { afterEach, expect, test, vi } from "vitest"
import { bootstrapIdentity, canonicalizeJson, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, toBase64Url, verifyEnvelope } from "../domain/identity"
import { approveRustyScope } from "./rustyEnrollment"
import type { BlindAccess } from "./blindClient"

afterEach(() => { vi.unstubAllGlobals(); resetIdentityStorageForTest() })

test("Given a trusted device, when connecting or removing Rusty, then device proof and pinned policy receipt cover exact scope and token commitments", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
  const servicePublicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey)))
  const serviceId = await sha256Base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey)))
  const access: BlindAccess = { origin: "http://localhost:8080", scopeId: "opaque-scope", servicePublicKey, readToken: "read-token", writeToken: "write-token", policyRevision: 1 }
  let badBinding = false, revision = 0, uploads = 0
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    expect(init.headers).not.toHaveProperty("Authorization")
    const body = JSON.parse(String(init.body))
    expect(JSON.stringify(body)).not.toContain("contentKey")
    if (url.endsWith("/challenge")) {
      return Response.json({ challenge: await signEnvelope(service.privateKey, {
        kind: "rusty-enrollment-challenge", version: 1, challengeId: "challenge", nonce: "nonce", serviceId,
        publicOrigin: access.origin, scopeId: badBinding ? "other-scope" : access.scopeId,
        personId: profile.identity.personId, deviceId: profile.device.deviceId, deviceKeyId: profile.device.deviceId,
        expectedRevision: revision, issuedAt: Date.now(), expiresAt: Date.now() + 120_000,
      }, serviceId, "RUSTY/2") })
    }
    uploads++
    expect(await verifyEnvelope(body.authorization, profile.certificate.payload.devicePublicKey)).toBe(true)
    expect(body.authorization.payload).toMatchObject({ readTokenHash: await sha256Base64Url(new TextEncoder().encode(access.readToken)), revoked: body.revoked })
    return Response.json({ receipt: await signEnvelope(service.privateKey, {
      kind: "rusty-scope-policy-receipt", version: 1, serviceId, scopeId: access.scopeId,
      personId: profile.identity.personId, revision: ++revision, revoked: body.revoked, challengeId: "challenge",
      authorizationHash: await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(body.authorization))),
    }, serviceId, "RUSTY/2") })
  }))
  expect(await approveRustyScope(access, profile)).toBe(1)
  expect(await approveRustyScope(access, profile, true)).toBe(2)
  badBinding = true
  await expect(approveRustyScope(access, profile)).rejects.toThrow(/challenge/i)
  expect(uploads).toBe(2)
})
