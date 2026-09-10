import type {
  DeviceCertificate,
  ActorBinding,
  ChangeProof,
  WorkspaceGrant,
  WorkspaceGenesis,
  PersonId,
  DeviceId,
  WorkspaceId,
  Heads,
  Hash,
} from "./model"
import {
  canonicalizeJson,
  sha256Base64Url,
  signEnvelope,
  verifyEnvelope,
  type LocalProfile,
} from "./identity"

export type ChainValidationResult =
  | { ok: true }
  | { ok: false; error: string }

export type StoredProofsV1 = {
  grants: WorkspaceGrant[]
  certificates: DeviceCertificate[]
  actorBindings: ActorBinding[]
  changeProofs: ChangeProof[]
}

export type ChainValidationOptions = {
  hashFn?: (cert: DeviceCertificate) => string | Promise<string>
  skipSigVerify?: boolean
}

export async function certHashDefault(cert: DeviceCertificate): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeJson(cert))
  return sha256Base64Url(bytes)
}

export async function validateCertificateChain(
  cert: DeviceCertificate,
  identityPublicKey: string,
  certPool: DeviceCertificate[],
  options: ChainValidationOptions = {}
): Promise<ChainValidationResult> {
  const getHash = options.hashFn ?? certHashDefault
  let current = cert
  const visited = new Set<string>()
  let depth = 0

  while (current) {
    depth++
    if (depth > 32) {
      return { ok: false, error: "Certificate chain depth exceeds limit 32" }
    }

    const currentHash = await getHash(current)
    if (visited.has(currentHash)) {
      return { ok: false, error: "Cycle detected in certificate chain" }
    }
    visited.add(currentHash)

    // Check if this certificate is root-issued
    if (current.payload.issuerCertificateHash === null) {
      if (!options.skipSigVerify) {
        const valid = await verifyEnvelope(current, identityPublicKey)
        if (!valid) {
          return { ok: false, error: "Root certificate signature invalid" }
        }
      }
      return { ok: true }
    }

    // Delegated certificate: find issuer by hash
    const issuerHash = current.payload.issuerCertificateHash
    if (visited.has(issuerHash)) {
      return { ok: false, error: "Cycle detected in certificate chain" }
    }

    let issuer: DeviceCertificate | undefined
    for (const candidate of certPool) {
      const candidateHash = await getHash(candidate)
      if (candidateHash === issuerHash) {
        issuer = candidate
        break
      }
    }

    if (!issuer) {
      return { ok: false, error: `Missing issuer certificate for hash ${issuerHash}` }
    }

    // Invariants
    if (issuer.payload.personId !== current.payload.personId) {
      return { ok: false, error: "Issuer personId does not match subject personId" }
    }
    if (!issuer.payload.canEnrollDevices) {
      return { ok: false, error: "Issuer certificate lacks canEnrollDevices capability" }
    }

    // Verify current cert's signature with issuer's device key
    if (!options.skipSigVerify) {
      const valid = await verifyEnvelope(current, issuer.payload.devicePublicKey)
      if (!valid) {
        return { ok: false, error: "Certificate signature invalid under issuer key" }
      }
    }

    current = issuer
  }

  return { ok: true }
}

export async function createDelegatedCertificate(
  delegatorDevicePrivateKey: CryptoKey,
  delegatorDeviceId: DeviceId,
  personId: PersonId,
  subjectDeviceId: DeviceId,
  subjectDevicePublicKey: string,
  issuerCertificateHash: Hash
): Promise<DeviceCertificate> {
  const payload = {
    kind: "device-certificate" as const,
    version: 1 as const,
    personId,
    deviceId: subjectDeviceId,
    devicePublicKey: subjectDevicePublicKey,
    issuerCertificateHash,
    canEnrollDevices: true as const,
  }

  return (await signEnvelope(
    delegatorDevicePrivateKey,
    payload,
    delegatorDeviceId
  )) as unknown as DeviceCertificate
}

export async function createWorkspaceGenesis(
  profile: LocalProfile,
  workspaceId: WorkspaceId,
  initialHeads: Heads,
  legacyCheckpoint = false
): Promise<WorkspaceGenesis> {
  const payload = {
    kind: "workspace-genesis" as const,
    version: 1 as const,
    workspaceId,
    ownerPersonId: profile.identity.personId,
    initialHeads,
    legacyCheckpoint,
  }

  const signerKey = profile.privateKeys.identityPrivateKey ?? profile.privateKeys.devicePrivateKey
  const signerId = profile.privateKeys.identityPrivateKey ? profile.identity.personId : profile.device.deviceId

  return (await signEnvelope(signerKey, payload, signerId)) as unknown as WorkspaceGenesis
}

export async function verifyWorkspaceGenesis(
  genesis: WorkspaceGenesis,
  publicKey: string
): Promise<boolean> {
  return verifyEnvelope(genesis, publicKey)
}

export async function createWorkspaceGrant(
  profile: LocalProfile,
  workspaceId: WorkspaceId,
  subjectPersonId: PersonId,
  role: "owner" | "editor"
): Promise<WorkspaceGrant> {
  const payload = {
    kind: "workspace-grant" as const,
    version: 1 as const,
    grantId: crypto.randomUUID(),
    workspaceId,
    personId: subjectPersonId,
    role,
  }

  return (await signEnvelope(
    profile.privateKeys.devicePrivateKey,
    payload,
    profile.device.deviceId
  )) as unknown as WorkspaceGrant
}

export async function verifyWorkspaceGrant(
  grant: WorkspaceGrant,
  publicKey: string
): Promise<boolean> {
  return verifyEnvelope(grant, publicKey)
}

export async function verifyActorBinding(
  binding: ActorBinding,
  devicePublicKey: string
): Promise<boolean> {
  return verifyEnvelope(binding, devicePublicKey)
}

const PROOF_STORE_BACKING = new Map<string, string>()

function getProofStoreRaw(key: string): string | null {
  if (typeof localStorage !== "undefined") {
    try { return localStorage.getItem(key) } catch {}
  }
  return PROOF_STORE_BACKING.get(key) ?? null
}

function setProofStoreRaw(key: string, val: string): void {
  if (typeof localStorage !== "undefined") {
    try { localStorage.setItem(key, val) } catch {}
  }
  PROOF_STORE_BACKING.set(key, val)
}

export class ProofStore {
  private actorBindings = new Map<string, ActorBinding>()
  private changeProofs = new Map<string, ChangeProof>()
  private certificates = new Map<string, DeviceCertificate>()
  private genesis = new Map<string, WorkspaceGenesis>()
  private grants = new Map<string, WorkspaceGrant>()

  constructor(persist = true) {
    if (persist) {
      this.load()
    }
  }

  private load() {
    const raw = getProofStoreRaw("match.v1.proof_store")
    if (raw) {
      try {
        const data = JSON.parse(raw)
        if (data.actorBindings) this.actorBindings = new Map(Object.entries(data.actorBindings))
        if (data.changeProofs) this.changeProofs = new Map(Object.entries(data.changeProofs))
        if (data.certificates) this.certificates = new Map(Object.entries(data.certificates))
        if (data.genesis) this.genesis = new Map(Object.entries(data.genesis))
        if (data.grants) this.grants = new Map(Object.entries(data.grants))
      } catch {}
    }
  }

  private save() {
    try {
      const data = {
        actorBindings: Object.fromEntries(this.actorBindings),
        changeProofs: Object.fromEntries(this.changeProofs),
        certificates: Object.fromEntries(this.certificates),
        genesis: Object.fromEntries(this.genesis),
        grants: Object.fromEntries(this.grants),
      }
      setProofStoreRaw("match.v1.proof_store", JSON.stringify(data))
    } catch {}
  }

  async putActorBinding(hash: string, binding: ActorBinding): Promise<void> {
    this.actorBindings.set(hash, binding)
    this.save()
  }

  async getActorBinding(hash: string): Promise<ActorBinding | null> {
    return this.actorBindings.get(hash) ?? null
  }

  async putChangeProof(hash: string, proof: ChangeProof): Promise<void> {
    this.changeProofs.set(hash, proof)
    this.save()
  }

  async getChangeProof(hash: string): Promise<ChangeProof | null> {
    return this.changeProofs.get(hash) ?? null
  }

  async listChangeProofs(): Promise<ChangeProof[]> {
    return Array.from(this.changeProofs.values())
  }

  async putCertificate(hash: string, cert: DeviceCertificate): Promise<void> {
    this.certificates.set(hash, cert)
    this.save()
  }

  async getCertificate(hash: string): Promise<DeviceCertificate | null> {
    return this.certificates.get(hash) ?? null
  }

  async listCertificates(): Promise<DeviceCertificate[]> {
    return Array.from(this.certificates.values())
  }

  async putGenesis(workspaceId: string, gen: WorkspaceGenesis): Promise<void> {
    this.genesis.set(workspaceId, gen)
    this.save()
  }

  async getGenesis(workspaceId: string): Promise<WorkspaceGenesis | null> {
    return this.genesis.get(workspaceId) ?? null
  }

  async putGrant(grantId: string, grant: WorkspaceGrant): Promise<void> {
    this.grants.set(grantId, grant)
    this.save()
  }

  async getGrant(grantId: string): Promise<WorkspaceGrant | null> {
    return this.grants.get(grantId) ?? null
  }

  async listGrants(workspaceId?: string): Promise<WorkspaceGrant[]> {
    const list = Array.from(this.grants.values())
    if (!workspaceId) return list
    return list.filter((g) => g.payload.workspaceId === workspaceId)
  }
}

export const defaultProofStore = new ProofStore()
