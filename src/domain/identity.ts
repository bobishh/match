import {
  BrowserIdentityStore,
  canonicalizeJson,
  fromBase64Url,
  sha256Base64Url,
  signEnvelope,
  signatureInput,
  toBase64Url,
  verifyEnvelope,
  type LocalProfile as MeshLocalProfile,
  type SignedEnvelope,
} from "../../packages/mesh-identity/src/index"
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
  sha256Base64Url,
  signEnvelope,
  signatureInput,
  toBase64Url,
  verifyEnvelope,
}
export type { SignedEnvelope }

export type LocalProfile = MeshLocalProfile & {
  identity: PublicIdentity
  certificate: DeviceCertificate
}

const identityStore = new BrowserIdentityStore({
  storageKey: "match.local_profile.v1",
  signatureDomain: "MATCH/1",
})

export function clearInMemoryProfileForReloadTest(): void {
  identityStore.clearMemory()
}

export function resetIdentityStorageForTest(): void {
  identityStore.reset()
}

export async function bootstrapIdentity(displayName = "Match User"): Promise<LocalProfile> {
  return await identityStore.bootstrap(displayName) as LocalProfile
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
