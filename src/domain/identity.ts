import type {
  PersonId,
  DeviceId,
  ActorId,
  Hash,
  PublicIdentity,
  RegisteredDevice,
  DeviceCertificate,
  ActorBinding,
  ChangeProof,
} from "./model"

export type SignedEnvelope<T> = {
  payload: T
  signerKeyId: PersonId | DeviceId
  signature: string
}

export type LocalProfile = {
  identity: PublicIdentity
  device: {
    deviceId: DeviceId
    publicKey: string
    displayName: string
  }
  certificate: DeviceCertificate
  privateKeys: {
    identityPrivateKey?: CryptoKey
    devicePrivateKey: CryptoKey
  }
}

// RFC 8785 JSON Canonicalization Scheme
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error("Non-finite number cannot be canonicalized")
      }
      return String(value)
    }
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return "[" + value.map(canonicalizeJson).join(",") + "]"
  }

  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`)
  return "{" + entries.join(",") + "}"
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromBase64Url(str: string): Uint8Array {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/")
  while (base64.length % 4 !== 0) {
    base64 += "="
  }
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export async function sha256Base64Url(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data)
  return toBase64Url(new Uint8Array(digest))
}

export function signatureInput(payloadKind: string, canonicalPayload: string): Uint8Array {
  const prefix = `MATCH/1/${payloadKind}\0`
  const enc = new TextEncoder()
  const prefixBytes = enc.encode(prefix)
  const payloadBytes = enc.encode(canonicalPayload)
  const result = new Uint8Array(prefixBytes.length + payloadBytes.length)
  result.set(prefixBytes, 0)
  result.set(payloadBytes, prefixBytes.length)
  return result
}

export async function signEnvelope<T extends { kind: string }>(
  privateKey: CryptoKey,
  payload: T,
  signerKeyId: PersonId | DeviceId
): Promise<SignedEnvelope<T>> {
  const canonical = canonicalizeJson(payload)
  const sigBytes = signatureInput(payload.kind, canonical)
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, sigBytes)
  return {
    payload,
    signerKeyId,
    signature: toBase64Url(new Uint8Array(signature)),
  }
}

export async function verifyEnvelope<T extends { kind: string }>(
  envelope: SignedEnvelope<T>,
  publicKeyRawOrCrypto: string | CryptoKey
): Promise<boolean> {
  let key: CryptoKey
  if (typeof publicKeyRawOrCrypto === "string") {
    const rawKey = fromBase64Url(publicKeyRawOrCrypto)
    key = await crypto.subtle.importKey("raw", rawKey, { name: "Ed25519" }, true, ["verify"])
  } else {
    key = publicKeyRawOrCrypto
  }

  const canonical = canonicalizeJson(envelope.payload)
  const sigBytes = signatureInput(envelope.payload.kind, canonical)
  const signature = fromBase64Url(envelope.signature)
  return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, sigBytes)
}

// Durable profile store
const IDENTITY_STORAGE_KEY = "match.local_profile.v1"
const fallbackMemoryStorage = new Map<string, string>()

function getStorageItem(key: string): string | null {
  if (typeof localStorage !== "undefined") {
    try {
      return localStorage.getItem(key)
    } catch {}
  }
  return fallbackMemoryStorage.get(key) ?? null
}

function setStorageItem(key: string, value: string, strict = false): void {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(key, value)
    } catch (error) { if (strict) throw error }
  }
  fallbackMemoryStorage.set(key, value)
}

function removeStorageItem(key: string): void {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(key)
    } catch {}
  }
  fallbackMemoryStorage.delete(key)
}

type SerializedProfile = {
  identity: PublicIdentity
  device: {
    deviceId: DeviceId
    publicKey: string
    displayName: string
  }
  certificate: DeviceCertificate
  privateKeys: {
    identityPrivateKeyPkcs8?: string
    devicePrivateKeyPkcs8: string
  }
}

let storedProfile: LocalProfile | null = null
let bootstrapPromise: Promise<LocalProfile> | null = null

export function clearInMemoryProfileForReloadTest(): void {
  storedProfile = null
  bootstrapPromise = null
}

export function resetIdentityStorageForTest(): void {
  storedProfile = null
  bootstrapPromise = null
  removeStorageItem(IDENTITY_STORAGE_KEY)
}

async function loadStoredProfile(): Promise<LocalProfile | null> {
  try {
    const raw = getStorageItem(IDENTITY_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SerializedProfile
    if (!parsed.identity || !parsed.device || !parsed.privateKeys?.devicePrivateKeyPkcs8) {
      return null
    }

    const devicePrivateKey = (await crypto.subtle.importKey(
      "pkcs8",
      fromBase64Url(parsed.privateKeys.devicePrivateKeyPkcs8),
      { name: "Ed25519" },
      true,
      ["sign"]
    )) as CryptoKey

    let identityPrivateKey: CryptoKey | undefined = undefined
    if (parsed.privateKeys.identityPrivateKeyPkcs8) {
      identityPrivateKey = (await crypto.subtle.importKey(
        "pkcs8",
        fromBase64Url(parsed.privateKeys.identityPrivateKeyPkcs8),
        { name: "Ed25519" },
        true,
        ["sign"]
      )) as CryptoKey
    }

    return {
      identity: parsed.identity,
      device: parsed.device,
      certificate: parsed.certificate,
      privateKeys: {
        identityPrivateKey,
        devicePrivateKey,
      },
    }
  } catch (e) {
    console.warn("Failed to load stored profile", e)
    return null
  }
}

async function persistProfile(profile: LocalProfile, strict = false): Promise<void> {
  try {
    const devicePkcs8 = toBase64Url(
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", profile.privateKeys.devicePrivateKey))
    )
    let identityPkcs8: string | undefined = undefined
    if (profile.privateKeys.identityPrivateKey) {
      identityPkcs8 = toBase64Url(
        new Uint8Array(await crypto.subtle.exportKey("pkcs8", profile.privateKeys.identityPrivateKey))
      )
    }

    const serialized: SerializedProfile = {
      identity: profile.identity,
      device: profile.device,
      certificate: profile.certificate,
      privateKeys: {
        identityPrivateKeyPkcs8: identityPkcs8,
        devicePrivateKeyPkcs8: devicePkcs8,
      },
    }
    setStorageItem(IDENTITY_STORAGE_KEY, JSON.stringify(serialized), strict)
  } catch (e) {
    if (strict) throw e
    console.warn("Failed to persist profile", e)
  }
}

export async function bootstrapIdentity(displayName = "Match User"): Promise<LocalProfile> {
  if (storedProfile) return storedProfile
  if (bootstrapPromise) return bootstrapPromise

  bootstrapPromise = (async () => {
    // 1. Try to restore from durable storage
    const restored = await loadStoredProfile()
    if (restored) {
      storedProfile = restored
      return restored
    }

    let identityKeyPair: CryptoKeyPair
    let deviceKeyPair: CryptoKeyPair

    try {
      identityKeyPair = (await crypto.subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"]
      )) as CryptoKeyPair

      deviceKeyPair = (await crypto.subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"]
      )) as CryptoKeyPair
    } catch (err: unknown) {
      throw new Error(`Unsupported crypto algorithm or environment: ${(err as Error)?.message || err}`)
    }

    const rawIdentityPub = new Uint8Array(await crypto.subtle.exportKey("raw", identityKeyPair.publicKey))
    const rawDevicePub = new Uint8Array(await crypto.subtle.exportKey("raw", deviceKeyPair.publicKey))

    const personId = await sha256Base64Url(rawIdentityPub)
    const deviceId = await sha256Base64Url(rawDevicePub)

    const identity: PublicIdentity = {
      personId,
      publicKey: toBase64Url(rawIdentityPub),
      displayName,
    }

    const devicePubBase64 = toBase64Url(rawDevicePub)

    const certificatePayload = {
      kind: "device-certificate" as const,
      version: 1 as const,
      personId,
      deviceId,
      devicePublicKey: devicePubBase64,
      issuerCertificateHash: null,
      canEnrollDevices: true as const,
    }

    const certificate = (await signEnvelope(
      identityKeyPair.privateKey,
      certificatePayload,
      personId
    )) as unknown as DeviceCertificate

    const profile: LocalProfile = {
      identity,
      device: {
        deviceId,
        publicKey: devicePubBase64,
        displayName: `${displayName}'s device`,
      },
      certificate,
      privateKeys: {
        identityPrivateKey: identityKeyPair.privateKey,
        devicePrivateKey: deviceKeyPair.privateKey,
      },
    }

    await persistProfile(profile)

    // Atomic assignment (if another bootstrap completed first, keep the first)
    if (!storedProfile) {
      storedProfile = profile
    }
    return storedProfile
  })()

  const result = await bootstrapPromise
  bootstrapPromise = null
  return result
}

// Enrollment retains the device key; the identity root private key never leaves its device.
export async function adoptEnrolledIdentity(identity: PublicIdentity, certificate: DeviceCertificate): Promise<LocalProfile> {
  const current = await bootstrapIdentity()
  const previous = getStorageItem(IDENTITY_STORAGE_KEY)
  if (previous) setStorageItem(`${IDENTITY_STORAGE_KEY}.backup.${current.identity.personId}`, previous, true)
  const profile: LocalProfile = {
    identity, certificate, device: current.device,
    privateKeys: current.identity.personId === identity.personId ? current.privateKeys : { devicePrivateKey: current.privateKeys.devicePrivateKey },
  }
  await persistProfile(profile, true)
  storedProfile = profile
  return profile
}

export async function createActorBinding(
  profile: LocalProfile,
  documentId: string,
  actorId: ActorId
): Promise<ActorBinding> {
  const payload = {
    kind: "actor-binding" as const,
    version: 1 as const,
    personId: profile.identity.personId,
    deviceId: profile.device.deviceId,
    documentId,
    actorId,
  }

  return (await signEnvelope(
    profile.privateKeys.devicePrivateKey,
    payload,
    profile.device.deviceId
  )) as unknown as ActorBinding
}

export async function createChangeProof(
  profile: LocalProfile,
  documentId: string,
  changeHash: Hash,
  actorBindingHash: Hash
): Promise<ChangeProof> {
  const payload = {
    kind: "change-proof" as const,
    version: 1 as const,
    documentId,
    changeHash,
    actorBindingHash,
  }

  return (await signEnvelope(
    profile.privateKeys.devicePrivateKey,
    payload,
    profile.device.deviceId
  )) as unknown as ChangeProof
}
