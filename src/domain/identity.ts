import {
  BrowserIdentityStore,
  canonicalizeJson,
  fromBase64Url,
  publicKeyId,
  sha256Base64Url,
  signEnvelope,
  toBase64Url,
  verifyEnvelope,
  generateIdentityRecovery,
  identitySeedFromPrivateKey,
  identitySecurityForRecovery,
  openIdentityRecoveryEnvelope,
  sealIdentitySeed,
  type IdentityRecoveryEnvelope,
  type IdentitySecurity,
  type LocalProfile as MeshLocalProfile,
  type SignedEnvelope,
} from "@meta-uber/mesh-identity"
import type {
  ActorBinding,
  ActorId,
  ChangeProof,
  DeviceCertificate,
  Hash,
  PublicIdentity,
} from "./model"

export {
  canonicalizeJson,
  fromBase64Url,
  publicKeyId,
  sha256Base64Url,
  signEnvelope,
  toBase64Url,
  verifyEnvelope,
}
export type { SignedEnvelope }
export type { IdentityRecoveryEnvelope, IdentitySecurity }

export type LocalProfile = MeshLocalProfile & {
  identity: PublicIdentity
  certificate: DeviceCertificate
}

const identityStore = new BrowserIdentityStore({
  storageKey: "match.local_profile.v1",
  signatureDomain: "MATCH/1",
})
const recoveryStorageKey = "match.identity_recovery.v1"
let recoveryEnvelopeMemory: string | null = null

function readRecoveryEnvelope(): string | null {
  try { return typeof localStorage === "undefined" ? recoveryEnvelopeMemory : localStorage.getItem(recoveryStorageKey) }
  catch { return recoveryEnvelopeMemory }
}

function writeRecoveryEnvelope(value: string) {
  recoveryEnvelopeMemory = value
  try { localStorage?.setItem(recoveryStorageKey, value) } catch { /* The downloaded file remains the durable backup. */ }
}

export function clearInMemoryProfileForReloadTest(): void {
  identityStore.clearMemory()
}

export function resetIdentityStorageForTest(): void {
  identityStore.reset()
  recoveryEnvelopeMemory = null
}

export async function bootstrapIdentity(displayName = "Match User"): Promise<LocalProfile> {
  return await identityStore.bootstrap(displayName) as LocalProfile
}

/** Creates an encrypted backup of the existing identity root; it never rotates identity. */
export async function createIdentityRecovery(
  security: IdentitySecurity = "better",
): Promise<{ recoveryKey: string; recoveryEnvelope: IdentityRecoveryEnvelope }> {
  const profile = await bootstrapIdentity()
  const key = profile.privateKeys.identityPrivateKey
  if (!key) throw new Error("This device cannot back up the workspace identity")
  const seed = await identitySeedFromPrivateKey(key, profile.identity.personId)
  const recoveryKey = generateIdentityRecovery(security)
  const recoveryEnvelope = await sealIdentitySeed(seed, profile.identity.personId, recoveryKey, security)
  const restored = await openIdentityRecoveryEnvelope(recoveryEnvelope, recoveryKey, profile.identity.displayName)
  if (restored.identity.personId !== profile.identity.personId) throw new Error("Identity backup does not match this identity")
  writeRecoveryEnvelope(JSON.stringify(recoveryEnvelope))
  return { recoveryKey, recoveryEnvelope }
}

export function savedIdentityRecoveryEnvelope(): IdentityRecoveryEnvelope | null {
  try {
    const raw = readRecoveryEnvelope()
    return raw ? JSON.parse(raw) as IdentityRecoveryEnvelope : null
  } catch { return null }
}

export async function restoreIdentityRecovery(
  envelope: IdentityRecoveryEnvelope,
  recoveryKey: string,
  displayName: string,
  replaceExisting = false,
  beforeRestore?: () => Promise<void>,
): Promise<LocalProfile> {
  if (!identitySecurityForRecovery(recoveryKey)) throw new Error("Invalid recovery words")
  const candidate = await openIdentityRecoveryEnvelope(envelope, recoveryKey, displayName)
  const current = await bootstrapIdentity(displayName)
  if (current.identity.personId !== candidate.identity.personId && !replaceExisting)
    throw new Error("Confirm identity replacement before restoring a different identity")
  await beforeRestore?.()
  return await identityStore.restoreEnvelope(envelope, recoveryKey, displayName) as LocalProfile
}

export async function adoptEnrolledIdentity(
  identity: PublicIdentity,
  certificate: DeviceCertificate,
): Promise<LocalProfile> {
  return await identityStore.adopt(identity, certificate) as LocalProfile
}

export async function createActorBinding(
  profile: LocalProfile,
  documentId: string,
  actorId: ActorId,
): Promise<ActorBinding> {
  return await signEnvelope(profile.privateKeys.devicePrivateKey, {
    kind: "actor-binding" as const,
    version: 1 as const,
    personId: profile.identity.personId,
    deviceId: profile.device.deviceId,
    documentId,
    actorId,
  }, profile.device.deviceId) as ActorBinding
}

export async function createChangeProof(
  profile: LocalProfile,
  documentId: string,
  changeHash: Hash,
  actorBindingHash: Hash,
): Promise<ChangeProof> {
  return await signEnvelope(profile.privateKeys.devicePrivateKey, {
    kind: "change-proof" as const,
    version: 1 as const,
    documentId,
    changeHash,
    actorBindingHash,
  }, profile.device.deviceId) as ChangeProof
}
