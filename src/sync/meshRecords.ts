import {
  fromBase64Url,
  sha256Base64Url,
  signEnvelope,
  verifyEnvelope,
  type LocalProfile,
  type SignedEnvelope,
} from "../domain/identity"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import { certHashDefault, createWorkspaceGrant } from "../domain/proofs"

export const MAX_PEER_ADVERTISEMENT_SIZE = 65536 // 64 KiB
export const MAX_ENDPOINT_LENGTH = 2048
export const MAX_STRING_LENGTH = 256
export const MAX_FUTURE_TOLERANCE_MS = 5 * 60 * 1000 // 5 minutes
export const MAX_STALE_TOLERANCE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
export const MAX_CERT_CHAIN_LENGTH = 32

export type PeerAdvertisementPayload = {
  kind: "peer-advertisement"
  version: 1
  workspaceId: string
  personId: string
  deviceId: string
  endpoint: string
  issuedAt: string // ISO 8601 string
}

export type PeerAdvertisement = SignedEnvelope<PeerAdvertisementPayload>

export type WorkspaceRevocationPayload = {
  kind: "workspace-revocation"
  version: 1
  workspaceId: string
  ownerPersonId: string
  personId: string
  epoch: number
  revokedAt: string
}

export type WorkspaceRevocation = SignedEnvelope<WorkspaceRevocationPayload>

export type WorkspaceAuthority = {
  personId: string
  publicKey: string
  certificates: DeviceCertificate[]
}

export type WorkspaceOwnershipTransferPayload = {
  kind: "workspace-ownership-transfer"
  version: 1
  workspaceId: string
  fromOwnerPersonId: string
  toOwnerPersonId: string
  toOwnerPublicKey: string
  toOwnerCertificates: DeviceCertificate[]
  toOwnerGrant: WorkspaceGrant
  formerOwnerGrant: WorkspaceGrant
  workspaceHeads: string[]
  epoch: number
  transferredAt: string
}

export type WorkspaceOwnershipTransfer = SignedEnvelope<WorkspaceOwnershipTransferPayload>

export type WorkspaceMemberBundle = {
  advertisement: PeerAdvertisement
  signed?: PeerAdvertisement
  payload?: PeerAdvertisementPayload
  signerKeyId?: string
  signature?: string
  publicKey: string
  certificates: DeviceCertificate[]
  grant?: WorkspaceGrant
  ownerPublicKey?: string
  ownerCertificates?: DeviceCertificate[]
  role?: "owner" | "editor" | "visitor"
}

export type CreatePeerAdvertisementOptions = {
  profile?: LocalProfile
  workspaceId: string
  endpoint: string
  certificates?: DeviceCertificate[]
  grant?: WorkspaceGrant
  ownerPublicKey?: string
  ownerCertificates?: DeviceCertificate[]
  issuedAt?: string
}

export type VerifyDeviceChainOptions = {
  personId?: string
  publicKey: string
  deviceId: string
  certificates: DeviceCertificate[]
}

export type VerifyWorkspaceMemberBundleOptions = {
  workspaceId?: string
  ownerPersonId?: string
  ownerPublicKey?: string
  ownerCertificates?: DeviceCertificate[]
  ownerHistory?: WorkspaceAuthority[]
  maxByteLength?: number
  now?: number | Date | string
}

export type VerifiedWorkspaceMember = Omit<
  WorkspaceMemberBundle,
  "payload" | "signed" | "signerKeyId" | "signature"
> & {
  advertisement: PeerAdvertisement
  signed: PeerAdvertisement
  payload: PeerAdvertisementPayload
  signerKeyId: string
  signature: string
  devicePublicKey: string
  role: "owner" | "editor" | "visitor"
}

export async function keyId(key: string): Promise<string> {
  if (typeof key !== "string" || !key) {
    throw new Error("Invalid public key: must be a non-empty string")
  }
  const bytes = fromBase64Url(key)
  if (bytes.byteLength !== 32) {
    throw new Error(`Invalid public key: expected 32 bytes, got ${bytes.byteLength}`)
  }
  return sha256Base64Url(bytes)
}

/**
 * Reusable certificate chain validator that validates that target deviceId is
 * transitively rooted in the provided identity public key via a valid sequence
 * of DeviceCertificates.
 *
 * Returns the target device's public key (base64url) on success.
 */
export async function verifyDeviceChain(
  arg1: string | DeviceCertificate[] | VerifyDeviceChainOptions,
  arg2?: string | DeviceCertificate[],
  arg3?: string | DeviceCertificate[],
  arg4?: DeviceCertificate[]
): Promise<string> {
  let personId: string | undefined
  let publicKey: string
  let deviceId: string
  let certificates: DeviceCertificate[]

  if (typeof arg1 === "object" && !Array.isArray(arg1)) {
    personId = arg1.personId
    publicKey = arg1.publicKey
    deviceId = arg1.deviceId
    certificates = arg1.certificates
  } else if (Array.isArray(arg1)) {
    certificates = arg1
    publicKey = arg2 as string
    deviceId = arg3 as string
  } else if (
    typeof arg1 === "string" &&
    typeof arg2 === "string" &&
    typeof arg3 === "string" &&
    Array.isArray(arg4)
  ) {
    personId = arg1
    publicKey = arg2
    deviceId = arg3
    certificates = arg4
  } else if (typeof arg1 === "string" && typeof arg2 === "string" && Array.isArray(arg3)) {
    publicKey = arg1
    deviceId = arg2
    certificates = arg3
  } else {
    throw new Error("Invalid arguments to verifyDeviceChain")
  }

  if (!publicKey || typeof publicKey !== "string") {
    throw new Error("Invalid public key")
  }
  if (!deviceId || typeof deviceId !== "string") {
    throw new Error("Invalid device ID")
  }
  if (
    !Array.isArray(certificates) ||
    certificates.length === 0 ||
    certificates.length > MAX_CERT_CHAIN_LENGTH
  ) {
    throw new Error(`Invalid certificate chain: expected between 1 and ${MAX_CERT_CHAIN_LENGTH} certificates`)
  }

  // Verify identity hash
  const derivedPersonId = await keyId(publicKey)
  if (personId && personId !== derivedPersonId) {
    throw new Error(`Identity does not match its key: expected ${personId}, derived ${derivedPersonId}`)
  }
  personId = derivedPersonId

  // Build lookup by certificate hash
  const byHash = new Map<string, DeviceCertificate>()
  for (const cert of certificates) {
    const hash = await certHashDefault(cert)
    byHash.set(hash, cert)
  }

  // Find target device certificate
  const first = certificates.find((c) => c?.payload?.deviceId === deviceId)
  if (!first) {
    throw new Error(`Missing device certificate for ${deviceId}`)
  }

  let cert: DeviceCertificate | undefined = first
  const seenDeviceIds = new Set<string>()
  const seenCertHashes = new Set<string>()
  let depth = 0

  while (cert) {
    depth++
    if (depth > MAX_CERT_CHAIN_LENGTH) {
      throw new Error(`Certificate chain exceeds depth limit ${MAX_CERT_CHAIN_LENGTH}`)
    }

    const currentCertHash = await certHashDefault(cert)
    if (seenCertHashes.has(currentCertHash)) {
      throw new Error("Cycle detected in certificate chain")
    }
    seenCertHashes.add(currentCertHash)

    const p = cert.payload
    if (
      !p ||
      p.kind !== "device-certificate" ||
      p.version !== 1 ||
      p.personId !== personId ||
      typeof p.devicePublicKey !== "string"
    ) {
      throw new Error("Invalid device certificate payload")
    }

    // Verify exact device hash
    if ((await keyId(p.devicePublicKey)) !== p.deviceId) {
      throw new Error(`Device key does not match deviceId ${p.deviceId}`)
    }

    if (seenDeviceIds.has(p.deviceId)) {
      throw new Error(`Cycle detected: duplicate deviceId ${p.deviceId}`)
    }
    seenDeviceIds.add(p.deviceId)

    // Check if root certificate
    if (p.issuerCertificateHash === null) {
      if (cert.signerKeyId !== personId) {
        throw new Error(`Root certificate signerKeyId ${cert.signerKeyId} does not match personId ${personId}`)
      }
      const valid = await verifyEnvelope(cert, publicKey)
      if (!valid) {
        throw new Error("Invalid root certificate signature")
      }
      return first.payload.devicePublicKey
    }

    // Delegated certificate: walk to issuer
    const issuerHash = p.issuerCertificateHash
    const issuer = byHash.get(issuerHash)
    if (!issuer) {
      throw new Error(`Missing issuer certificate for hash ${issuerHash}`)
    }
    if (!issuer.payload.canEnrollDevices) {
      throw new Error("Issuer certificate lacks canEnrollDevices capability")
    }
    if (cert.signerKeyId !== issuer.payload.deviceId) {
      throw new Error("Delegated certificate signerKeyId does not match issuer deviceId")
    }
    const valid = await verifyEnvelope(cert, issuer.payload.devicePublicKey)
    if (!valid) {
      throw new Error("Invalid delegated certificate signature")
    }

    cert = issuer
  }

  throw new Error("Incomplete certificate chain")
}

/**
 * Creates a signed PeerAdvertisement and bundles it with identity public key,
 * certificate chain, and optional WorkspaceGrant.
 */
export async function createPeerAdvertisement(
  profileOrOptions: LocalProfile | (CreatePeerAdvertisementOptions & { profile: LocalProfile }),
  workspaceIdOrOptions?: string | CreatePeerAdvertisementOptions,
  endpoint?: string,
  extraOptions?: Partial<CreatePeerAdvertisementOptions>
): Promise<WorkspaceMemberBundle> {
  let profile: LocalProfile
  let workspaceId: string
  let ep: string
  let certificates: DeviceCertificate[] | undefined
  let grant: WorkspaceGrant | undefined
  let ownerPublicKey: string | undefined
  let ownerCertificates: DeviceCertificate[] | undefined
  let issuedAt: string | undefined

  if (
    typeof profileOrOptions === "object" &&
    "profile" in profileOrOptions &&
    profileOrOptions.profile
  ) {
    const opts = profileOrOptions as CreatePeerAdvertisementOptions & { profile: LocalProfile }
    profile = opts.profile
    workspaceId = opts.workspaceId
    ep = opts.endpoint
    certificates = opts.certificates
    grant = opts.grant
    ownerPublicKey = opts.ownerPublicKey
    ownerCertificates = opts.ownerCertificates
    issuedAt = opts.issuedAt
  } else {
    profile = profileOrOptions as LocalProfile
    if (typeof workspaceIdOrOptions === "object" && workspaceIdOrOptions !== null) {
      workspaceId = workspaceIdOrOptions.workspaceId
      ep = workspaceIdOrOptions.endpoint
      certificates = workspaceIdOrOptions.certificates
      grant = workspaceIdOrOptions.grant
      ownerPublicKey = workspaceIdOrOptions.ownerPublicKey
      ownerCertificates = workspaceIdOrOptions.ownerCertificates
      issuedAt = workspaceIdOrOptions.issuedAt
    } else {
      workspaceId = workspaceIdOrOptions as string
      ep = endpoint as string
      if (extraOptions) {
        certificates = extraOptions.certificates
        grant = extraOptions.grant
        ownerPublicKey = extraOptions.ownerPublicKey
        ownerCertificates = extraOptions.ownerCertificates
        issuedAt = extraOptions.issuedAt
      }
    }
  }

  if (!profile?.identity?.personId || !profile?.device?.deviceId || !profile?.privateKeys?.devicePrivateKey) {
    throw new Error("Invalid LocalProfile: missing required identity or device keys")
  }
  if (!workspaceId || typeof workspaceId !== "string") {
    throw new Error("Invalid workspaceId: must be a non-empty string")
  }
  if (!ep || typeof ep !== "string") {
    throw new Error("Invalid endpoint: must be a non-empty string")
  }

  const payload: PeerAdvertisementPayload = {
    kind: "peer-advertisement",
    version: 1,
    workspaceId,
    personId: profile.identity.personId,
    deviceId: profile.device.deviceId,
    endpoint: ep,
    issuedAt: issuedAt ?? new Date().toISOString(),
  }

  const advertisement = (await signEnvelope(
    profile.privateKeys.devicePrivateKey,
    payload,
    profile.device.deviceId
  )) as unknown as PeerAdvertisement

  const certChain = certificates ?? [profile.certificate]

  const bundle: WorkspaceMemberBundle = {
    advertisement,
    signed: advertisement,
    payload: advertisement.payload,
    signerKeyId: advertisement.signerKeyId,
    signature: advertisement.signature,
    publicKey: profile.identity.publicKey,
    certificates: certChain,
    grant,
    ownerPublicKey,
    ownerCertificates,
  }

  return bundle
}

export const createWorkspaceMemberBundle = createPeerAdvertisement

/**
 * Verifies a workspace member bundle or peer advertisement:
 * - Bounded serialized size
 * - Exact identity hash
 * - Device certificate chain
 * - Advertisement signature
 * - Workspace / owner / grant role (owner needs no grant)
 * - Root signature or owner device chain for grants
 * - Canonical ISO timestamp within 5 minutes future and max 30 days stale
 */
export async function verifyWorkspaceMemberBundle(
  rawBundle: unknown,
  workspaceIdOrOptions?: string | VerifyWorkspaceMemberBundleOptions,
  ownerPersonIdOrPublicKeyOrOptions?: string | VerifyWorkspaceMemberBundleOptions,
  optionsOrOwnerPublicKey?: string | VerifyWorkspaceMemberBundleOptions,
  maybeOptions?: VerifyWorkspaceMemberBundleOptions
): Promise<VerifiedWorkspaceMember> {
  let opts: VerifyWorkspaceMemberBundleOptions = {}

  if (typeof workspaceIdOrOptions === "object" && workspaceIdOrOptions !== null) {
    opts = workspaceIdOrOptions
  } else if (
    typeof ownerPersonIdOrPublicKeyOrOptions === "object" &&
    ownerPersonIdOrPublicKeyOrOptions !== null
  ) {
    opts = ownerPersonIdOrPublicKeyOrOptions
    if (typeof workspaceIdOrOptions === "string") opts.workspaceId = workspaceIdOrOptions
  } else if (typeof optionsOrOwnerPublicKey === "object" && optionsOrOwnerPublicKey !== null) {
    opts = optionsOrOwnerPublicKey
    if (typeof workspaceIdOrOptions === "string") opts.workspaceId = workspaceIdOrOptions
  } else if (typeof maybeOptions === "object" && maybeOptions !== null) {
    opts = maybeOptions
    if (typeof workspaceIdOrOptions === "string") opts.workspaceId = workspaceIdOrOptions
  } else {
    if (typeof workspaceIdOrOptions === "string") opts.workspaceId = workspaceIdOrOptions
  }

  let ownerKeyOrId: string | undefined
  if (typeof ownerPersonIdOrPublicKeyOrOptions === "string") {
    ownerKeyOrId = ownerPersonIdOrPublicKeyOrOptions
  }
  let secondaryOwnerKeyOrId: string | undefined
  if (typeof optionsOrOwnerPublicKey === "string") {
    secondaryOwnerKeyOrId = optionsOrOwnerPublicKey
  }

  // 1. Check bounded serialized size
  const maxByteLength = opts.maxByteLength ?? MAX_PEER_ADVERTISEMENT_SIZE
  const serialized = JSON.stringify(rawBundle)
  if (!serialized || new TextEncoder().encode(serialized).byteLength > maxByteLength) {
    throw new Error("Peer advertisement too large")
  }

  if (!rawBundle || typeof rawBundle !== "object") {
    throw new Error("Invalid peer advertisement bundle: must be an object")
  }

  const bundle = rawBundle as Record<string, unknown>
  const advertisement = (
    bundle.advertisement ??
    bundle.signed ??
    (bundle.payload && bundle.signature ? bundle : undefined)
  ) as PeerAdvertisement | undefined

  if (!advertisement || typeof advertisement !== "object") {
    throw new Error("Missing peer advertisement in bundle")
  }

  const p = advertisement.payload
  if (
    !p ||
    typeof p !== "object" ||
    p.kind !== "peer-advertisement" ||
    p.version !== 1 ||
    typeof p.workspaceId !== "string" ||
    !p.workspaceId ||
    p.workspaceId.length > MAX_STRING_LENGTH ||
    typeof p.personId !== "string" ||
    !p.personId ||
    p.personId.length > MAX_STRING_LENGTH ||
    typeof p.deviceId !== "string" ||
    !p.deviceId ||
    p.deviceId.length > MAX_STRING_LENGTH ||
    typeof p.endpoint !== "string" ||
    !p.endpoint ||
    p.endpoint.length > MAX_ENDPOINT_LENGTH
  ) {
    throw new Error("Invalid peer advertisement payload")
  }

  // 2. Check workspace ID match
  const expectedWorkspaceId = opts.workspaceId
  if (expectedWorkspaceId && p.workspaceId !== expectedWorkspaceId) {
    throw new Error(`Workspace ID ${p.workspaceId} does not match expected workspace ${expectedWorkspaceId}`)
  }

  // 3. Check signer key ID matches device ID
  if (advertisement.signerKeyId !== p.deviceId) {
    throw new Error(`Advertisement signerKeyId ${advertisement.signerKeyId} does not match deviceId ${p.deviceId}`)
  }

  // 4. Validate timestamp: canonical ISO 8601, within 5m future, max 30d stale
  if (
    typeof p.issuedAt !== "string" ||
    !Number.isFinite(Date.parse(p.issuedAt)) ||
    new Date(p.issuedAt).toISOString() !== p.issuedAt
  ) {
    throw new Error("Invalid issuedAt timestamp: must be canonical ISO 8601 string")
  }

  const issuedTime = Date.parse(p.issuedAt)
  const nowTime =
    typeof opts.now === "number"
      ? opts.now
      : opts.now instanceof Date
        ? opts.now.getTime()
        : typeof opts.now === "string"
          ? Date.parse(opts.now)
          : Date.now()

  if (issuedTime > nowTime + MAX_FUTURE_TOLERANCE_MS) {
    throw new Error("Peer advertisement timestamp is in the future (> 5 minutes)")
  }
  if (issuedTime < nowTime - MAX_STALE_TOLERANCE_MS) {
    throw new Error("Peer advertisement timestamp is stale (> 30 days)")
  }

  // 5. Exact identity hash verification
  const memberPublicKey = (bundle.publicKey ?? (bundle.authority as any)?.publicKey) as string | undefined
  if (!memberPublicKey || typeof memberPublicKey !== "string") {
    throw new Error("Missing member identity public key")
  }

  const memberPersonId = await keyId(memberPublicKey)
  if (memberPersonId !== p.personId) {
    throw new Error(`Identity does not match its key: expected ${p.personId}, derived ${memberPersonId}`)
  }

  // 6. Device certificate chain verification
  const certificates = (bundle.certificates ?? (bundle.authority as any)?.certificates) as
    | DeviceCertificate[]
    | undefined
  if (!Array.isArray(certificates) || certificates.length === 0) {
    throw new Error("Missing device certificates in bundle")
  }

  const devicePublicKey = await verifyDeviceChain({
    personId: p.personId,
    publicKey: memberPublicKey,
    deviceId: p.deviceId,
    certificates,
  })

  // 7. Advertisement signature verification
  const adSignatureValid = await verifyEnvelope(advertisement, devicePublicKey)
  if (!adSignatureValid) {
    throw new Error("Invalid advertisement signature")
  }

  // 8. Determine ownerPublicKey and ownerPersonId
  let ownerPublicKey =
    opts.ownerPublicKey ??
    (bundle.ownerPublicKey as string | undefined) ??
    ((bundle.authority as any)?.publicKey as string | undefined)
  let ownerPersonId = opts.ownerPersonId

  if (ownerKeyOrId) {
    if (secondaryOwnerKeyOrId) {
      try {
        if ((await keyId(secondaryOwnerKeyOrId)) === ownerKeyOrId) {
          ownerPersonId = ownerKeyOrId
          ownerPublicKey = secondaryOwnerKeyOrId
        } else if ((await keyId(ownerKeyOrId)) === secondaryOwnerKeyOrId) {
          ownerPersonId = secondaryOwnerKeyOrId
          ownerPublicKey = ownerKeyOrId
        }
      } catch {}
    }

    if (!ownerPublicKey) {
      try {
        const derived = await keyId(ownerKeyOrId)
        ownerPublicKey = ownerKeyOrId
        if (!ownerPersonId) ownerPersonId = derived
      } catch {
        if (!ownerPersonId) ownerPersonId = ownerKeyOrId
      }
    }
  }

  if (ownerPublicKey && !ownerPersonId) {
    ownerPersonId = await keyId(ownerPublicKey)
  }

  // 9. Role and Grant verification
  const grant = (bundle.grant ?? (bundle.authority as any)?.grant) as WorkspaceGrant | undefined
  const isOwner = ownerPersonId ? p.personId === ownerPersonId : !grant

  let role: "owner" | "editor" | "visitor" = "owner"

  if (isOwner) {
    // Owner needs no grant
    role = "owner"
    if (!ownerPersonId) ownerPersonId = p.personId
    if (!ownerPublicKey) ownerPublicKey = memberPublicKey
  } else {
    const authorities: WorkspaceAuthority[] = [{
      personId: ownerPersonId!,
      publicKey: ownerPublicKey!,
      certificates: opts.ownerCertificates ?? bundle.ownerCertificates as DeviceCertificate[] ?? (bundle.authority as any)?.certificates ?? [],
    }, ...(opts.ownerHistory ?? [])]
    let verifiedRole: "owner" | "editor" | "visitor" | undefined
    for (const authority of authorities) {
      try {
        verifiedRole = await verifyWorkspaceGrant(grant, {
          workspaceId: expectedWorkspaceId ?? p.workspaceId, personId: p.personId,
          ownerPersonId: authority.personId, ownerPublicKey: authority.publicKey,
          ownerCertificates: authority.certificates,
        })
        break
      } catch {}
    }
    if (!verifiedRole) throw new Error("Invalid workspace grant signature")
    role = verifiedRole
  }

  return {
    advertisement,
    signed: advertisement,
    payload: advertisement.payload,
    signerKeyId: advertisement.signerKeyId,
    signature: advertisement.signature,
    publicKey: memberPublicKey,
    certificates,
    devicePublicKey,
    role,
    grant,
    ownerPublicKey,
    ownerCertificates: opts.ownerCertificates ?? (bundle.ownerCertificates as DeviceCertificate[]),
  }
}

export const verifyPeerAdvertisement = verifyWorkspaceMemberBundle

export async function createWorkspaceRevocation(profile: LocalProfile, workspaceId: string, personId: string, epoch: number,
  revokedAt = new Date().toISOString()): Promise<WorkspaceRevocation> {
  if (!workspaceId || !personId || personId === profile.identity.personId || !Number.isSafeInteger(epoch) || epoch < 2 ||
    !Number.isFinite(Date.parse(revokedAt)) || new Date(revokedAt).toISOString() !== revokedAt) throw new Error("Invalid workspace revocation")
  const key = profile.privateKeys.identityPrivateKey ?? profile.privateKeys.devicePrivateKey
  const signer = profile.privateKeys.identityPrivateKey ? profile.identity.personId : profile.device.deviceId
  return signEnvelope(key, {
    kind: "workspace-revocation", version: 1, workspaceId, ownerPersonId: profile.identity.personId,
    personId, epoch, revokedAt,
  }, signer)
}

export async function verifyWorkspaceRevocation(raw: unknown, workspaceId: string, ownerPersonId: string,
  ownerPublicKey: string, ownerCertificates: DeviceCertificate[], now = Date.now()): Promise<WorkspaceRevocation> {
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > 32768) throw new Error("Workspace revocation too large")
  const record = raw as WorkspaceRevocation
  const p = record?.payload
  if (!p || p.kind !== "workspace-revocation" || p.version !== 1 || p.workspaceId !== workspaceId ||
    p.ownerPersonId !== ownerPersonId || typeof p.personId !== "string" || !p.personId || p.personId === ownerPersonId ||
    !Number.isSafeInteger(p.epoch) || p.epoch < 2 || typeof p.revokedAt !== "string" ||
    !Number.isFinite(Date.parse(p.revokedAt)) || new Date(p.revokedAt).toISOString() !== p.revokedAt ||
    Date.parse(p.revokedAt) > now + MAX_FUTURE_TOLERANCE_MS || await keyId(ownerPublicKey) !== ownerPersonId) {
    throw new Error("Invalid workspace revocation")
  }
  if (record.signerKeyId === ownerPersonId && await verifyEnvelope(record, ownerPublicKey)) return record
  const deviceKey = await verifyDeviceChain({ personId: ownerPersonId, publicKey: ownerPublicKey,
    deviceId: record.signerKeyId, certificates: ownerCertificates })
  if (!await verifyEnvelope(record, deviceKey)) throw new Error("Invalid workspace revocation signature")
  return record
}


export async function verifyWorkspaceGrant(grant: WorkspaceGrant | undefined, scope: {
  workspaceId: string; personId: string; ownerPersonId: string; ownerPublicKey: string; ownerCertificates: DeviceCertificate[]
}): Promise<"owner" | "editor" | "visitor"> {
  if (!grant) throw new Error("Missing workspace grant for non-owner member")
  const p = grant.payload
  if (!p || p.kind !== "workspace-grant" || p.version !== 1 || p.workspaceId !== scope.workspaceId ||
    p.personId !== scope.personId || !["owner", "editor", "visitor"].includes(p.role)) throw new Error("Invalid workspace grant")
  if (!scope.ownerPublicKey || await keyId(scope.ownerPublicKey) !== scope.ownerPersonId) throw new Error("Invalid workspace owner")
  if (await verifyEnvelope(grant, scope.ownerPublicKey)) return p.role
  try {
    const key = await verifyDeviceChain({ personId: scope.ownerPersonId, publicKey: scope.ownerPublicKey,
      deviceId: grant.signerKeyId, certificates: scope.ownerCertificates })
    if (await verifyEnvelope(grant, key)) return p.role
  } catch {}
  throw new Error("Invalid workspace grant signature")
}

export async function createWorkspaceOwnershipTransfer(
  profile: LocalProfile,
  workspaceId: string,
  target: { personId: string; publicKey: string; certificates: DeviceCertificate[] },
  workspaceHeads: string[],
  epoch: number,
  transferredAt = new Date().toISOString(),
): Promise<WorkspaceOwnershipTransfer> {
  if (!workspaceId || !target.personId || target.personId === profile.identity.personId ||
    !Array.isArray(workspaceHeads) || workspaceHeads.length === 0 || workspaceHeads.length > 256 ||
    workspaceHeads.some(head => typeof head !== "string" || !head) || !Number.isSafeInteger(epoch) || epoch < 2 ||
    !Number.isFinite(Date.parse(transferredAt)) || new Date(transferredAt).toISOString() !== transferredAt) {
    throw new Error("Invalid workspace ownership transfer")
  }
  if (await keyId(target.publicKey) !== target.personId) throw new Error("Invalid new owner identity")
  await verifyDeviceChain({ personId: target.personId, publicKey: target.publicKey,
    deviceId: target.certificates[0]?.payload.deviceId, certificates: target.certificates })
  const toOwnerGrant = await createWorkspaceGrant(profile, workspaceId, target.personId, "owner")
  const formerOwnerGrant = await createWorkspaceGrant(profile, workspaceId, profile.identity.personId, "editor")
  return signEnvelope(profile.privateKeys.devicePrivateKey, {
    kind: "workspace-ownership-transfer", version: 1, workspaceId,
    fromOwnerPersonId: profile.identity.personId, toOwnerPersonId: target.personId,
    toOwnerPublicKey: target.publicKey, toOwnerCertificates: target.certificates,
    toOwnerGrant, formerOwnerGrant, workspaceHeads, epoch, transferredAt,
  }, profile.device.deviceId)
}

export async function verifyWorkspaceOwnershipTransfer(
  raw: unknown,
  workspaceId: string,
  authority: WorkspaceAuthority,
  minimumEpoch: number,
  now = Date.now(),
): Promise<WorkspaceOwnershipTransfer> {
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > MAX_PEER_ADVERTISEMENT_SIZE) {
    throw new Error("Workspace ownership transfer too large")
  }
  const record = raw as WorkspaceOwnershipTransfer
  const p = record?.payload
  if (!p || p.kind !== "workspace-ownership-transfer" || p.version !== 1 || p.workspaceId !== workspaceId ||
    p.fromOwnerPersonId !== authority.personId || typeof p.toOwnerPersonId !== "string" || !p.toOwnerPersonId ||
    p.toOwnerPersonId === p.fromOwnerPersonId || typeof p.toOwnerPublicKey !== "string" || !p.toOwnerPublicKey ||
    !Array.isArray(p.toOwnerCertificates) || p.toOwnerCertificates.length === 0 || p.toOwnerCertificates.length > MAX_CERT_CHAIN_LENGTH ||
    !Array.isArray(p.workspaceHeads) || p.workspaceHeads.length === 0 || p.workspaceHeads.length > 256 ||
    p.workspaceHeads.some(head => typeof head !== "string" || !head) ||
    !Number.isSafeInteger(p.epoch) || p.epoch <= minimumEpoch || typeof p.transferredAt !== "string" ||
    !Number.isFinite(Date.parse(p.transferredAt)) || new Date(p.transferredAt).toISOString() !== p.transferredAt ||
    Date.parse(p.transferredAt) > now + MAX_FUTURE_TOLERANCE_MS || await keyId(authority.publicKey) !== authority.personId ||
    await keyId(p.toOwnerPublicKey) !== p.toOwnerPersonId) throw new Error("Invalid workspace ownership transfer")
  await verifyDeviceChain({ personId: p.toOwnerPersonId, publicKey: p.toOwnerPublicKey,
    deviceId: p.toOwnerCertificates[0].payload.deviceId, certificates: p.toOwnerCertificates })
  if (record.signerKeyId === authority.personId) {
    if (!await verifyEnvelope(record, authority.publicKey)) throw new Error("Invalid ownership transfer signature")
  } else {
    const signerKey = await verifyDeviceChain({ personId: authority.personId, publicKey: authority.publicKey,
      deviceId: record.signerKeyId, certificates: authority.certificates })
    if (!await verifyEnvelope(record, signerKey)) throw new Error("Invalid ownership transfer signature")
  }
  const scope = { workspaceId, ownerPersonId: authority.personId, ownerPublicKey: authority.publicKey,
    ownerCertificates: authority.certificates }
  if (await verifyWorkspaceGrant(p.toOwnerGrant, { ...scope, personId: p.toOwnerPersonId }) !== "owner" ||
    await verifyWorkspaceGrant(p.formerOwnerGrant, { ...scope, personId: p.fromOwnerPersonId }) !== "editor") {
    throw new Error("Invalid ownership transfer roles")
  }
  return record
}
