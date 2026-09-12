export type PersonId = string
export type DeviceId = string

export type SignedEnvelope<T> = {
  payload: T
  signerKeyId: PersonId | DeviceId
  signature: string
}

export type PublicIdentity = {
  personId: PersonId
  publicKey: string
  displayName: string
}

export type DeviceCertificate = SignedEnvelope<{
  kind: "device-certificate"
  version: 1
  personId: PersonId
  deviceId: DeviceId
  devicePublicKey: string
  issuerCertificateHash: string | null
  canEnrollDevices: true
}>

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

export type IdentityStoreOptions = {
  storageKey: string
  signatureDomain?: string
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">
}

type SerializedProfile = {
  identity: PublicIdentity
  device: LocalProfile["device"]
  certificate: DeviceCertificate
  privateKeys: {
    identityPrivateKeyPkcs8?: string
    devicePrivateKeyPkcs8: string
  }
}

export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Non-finite number cannot be canonicalized")
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalizeJson).join(",") + "]"
  const object = value as Record<string, unknown>
  return "{" + Object.keys(object).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalizeJson(object[key])}`).join(",") + "}"
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromBase64Url(value: string): Uint8Array {
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/")
  while (base64.length % 4 !== 0) base64 += "="
  const binary = atob(base64)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

export async function sha256Base64Url(data: Uint8Array): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", data)))
}

export function signatureInput(payloadKind: string, canonicalPayload: string, domain = "MATCH/1"): Uint8Array {
  const encoder = new TextEncoder()
  const prefix = encoder.encode(`${domain}/${payloadKind}\0`)
  const payload = encoder.encode(canonicalPayload)
  const result = new Uint8Array(prefix.length + payload.length)
  result.set(prefix)
  result.set(payload, prefix.length)
  return result
}

export async function signEnvelope<T extends { kind: string }>(
  privateKey: CryptoKey,
  payload: T,
  signerKeyId: PersonId | DeviceId,
  domain = "MATCH/1",
): Promise<SignedEnvelope<T>> {
  const input = signatureInput(payload.kind, canonicalizeJson(payload), domain)
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, input)
  return { payload, signerKeyId, signature: toBase64Url(new Uint8Array(signature)) }
}

export async function verifyEnvelope<T extends { kind: string }>(
  envelope: SignedEnvelope<T>,
  publicKeyRawOrCrypto: string | CryptoKey,
  domain = "MATCH/1",
): Promise<boolean> {
  const key = typeof publicKeyRawOrCrypto === "string"
    ? await crypto.subtle.importKey("raw", fromBase64Url(publicKeyRawOrCrypto), { name: "Ed25519" }, true, ["verify"])
    : publicKeyRawOrCrypto
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    fromBase64Url(envelope.signature),
    signatureInput(envelope.payload.kind, canonicalizeJson(envelope.payload), domain),
  )
}

export class BrowserIdentityStore {
  private profile: LocalProfile | null = null
  private booting: Promise<LocalProfile> | null = null
  private readonly memory = new Map<string, string>()
  private readonly domain: string

  constructor(private readonly options: IdentityStoreOptions) {
    this.domain = options.signatureDomain ?? "MATCH/1"
  }

  private storage() {
    if (this.options.storage) return this.options.storage
    try {
      return typeof localStorage === "undefined" ? undefined : localStorage
    } catch {
      return undefined
    }
  }

  private get(key: string): string | null {
    try { return this.storage()?.getItem(key) ?? this.memory.get(key) ?? null }
    catch { return this.memory.get(key) ?? null }
  }

  private set(key: string, value: string, strict = false) {
    try { this.storage()?.setItem(key, value) }
    catch (error) { if (strict) throw error }
    this.memory.set(key, value)
  }

  private remove(key: string) {
    try { this.storage()?.removeItem(key) } catch {}
    this.memory.delete(key)
  }

  clearMemory() {
    this.profile = null
    this.booting = null
  }

  reset() {
    this.clearMemory()
    this.remove(this.options.storageKey)
  }

  private async load(): Promise<LocalProfile | null> {
    try {
      const raw = this.get(this.options.storageKey)
      if (!raw) return null
      const saved = JSON.parse(raw) as SerializedProfile
      if (!saved.identity || !saved.device || !saved.certificate || !saved.privateKeys?.devicePrivateKeyPkcs8) return null
      const devicePrivateKey = await crypto.subtle.importKey(
        "pkcs8", fromBase64Url(saved.privateKeys.devicePrivateKeyPkcs8),
        { name: "Ed25519" }, true, ["sign"],
      )
      const identityPrivateKey = saved.privateKeys.identityPrivateKeyPkcs8
        ? await crypto.subtle.importKey(
          "pkcs8", fromBase64Url(saved.privateKeys.identityPrivateKeyPkcs8),
          { name: "Ed25519" }, true, ["sign"],
        )
        : undefined
      return {
        identity: saved.identity,
        device: saved.device,
        certificate: saved.certificate,
        privateKeys: { identityPrivateKey, devicePrivateKey },
      }
    } catch {
      return null
    }
  }

  private async persist(profile: LocalProfile, strict = false) {
    try {
      const serialized: SerializedProfile = {
        identity: profile.identity,
        device: profile.device,
        certificate: profile.certificate,
        privateKeys: {
          identityPrivateKeyPkcs8: profile.privateKeys.identityPrivateKey
            ? toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", profile.privateKeys.identityPrivateKey)))
            : undefined,
          devicePrivateKeyPkcs8: toBase64Url(
            new Uint8Array(await crypto.subtle.exportKey("pkcs8", profile.privateKeys.devicePrivateKey)),
          ),
        },
      }
      this.set(this.options.storageKey, JSON.stringify(serialized), strict)
    } catch (error) {
      if (strict) throw error
    }
  }

  async bootstrap(displayName = "Mesh user"): Promise<LocalProfile> {
    if (this.profile) return this.profile
    if (this.booting) return this.booting
    this.booting = (async () => {
      const restored = await this.load()
      if (restored) return (this.profile = restored)
      let identityKeys: CryptoKeyPair
      let deviceKeys: CryptoKeyPair
      try {
        identityKeys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair
        deviceKeys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair
      } catch (error) {
        throw new Error(`Unsupported crypto algorithm or environment: ${error instanceof Error ? error.message : error}`)
      }
      const identityPublic = new Uint8Array(await crypto.subtle.exportKey("raw", identityKeys.publicKey))
      const devicePublic = new Uint8Array(await crypto.subtle.exportKey("raw", deviceKeys.publicKey))
      const personId = await sha256Base64Url(identityPublic)
      const deviceId = await sha256Base64Url(devicePublic)
      const identity: PublicIdentity = { personId, publicKey: toBase64Url(identityPublic), displayName }
      const certificate = await signEnvelope(identityKeys.privateKey, {
        kind: "device-certificate" as const,
        version: 1 as const,
        personId,
        deviceId,
        devicePublicKey: toBase64Url(devicePublic),
        issuerCertificateHash: null,
        canEnrollDevices: true as const,
      }, personId, this.domain)
      const profile: LocalProfile = {
        identity,
        device: { deviceId, publicKey: toBase64Url(devicePublic), displayName: `${displayName}'s device` },
        certificate,
        privateKeys: { identityPrivateKey: identityKeys.privateKey, devicePrivateKey: deviceKeys.privateKey },
      }
      await this.persist(profile)
      if (!this.profile) this.profile = profile
      return this.profile
    })()
    try { return await this.booting } finally { this.booting = null }
  }

  async adopt(identity: PublicIdentity, certificate: DeviceCertificate): Promise<LocalProfile> {
    const current = await this.bootstrap()
    const previous = this.get(this.options.storageKey)
    if (previous) this.set(`${this.options.storageKey}.backup.${current.identity.personId}`, previous, true)
    const profile: LocalProfile = {
      identity,
      certificate,
      device: current.device,
      privateKeys: current.identity.personId === identity.personId
        ? current.privateKeys
        : { devicePrivateKey: current.privateKeys.devicePrivateKey },
    }
    await this.persist(profile, true)
    this.profile = profile
    return profile
  }
}
