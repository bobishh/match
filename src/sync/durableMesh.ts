import type { LocalProfile } from "../domain/identity"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import * as Automerge from "@automerge/automerge/slim"
import { defaultProofStore } from "../domain/proofs"
import { createPairingSecret, decodePairingFrame, encodePairingFrame, inspectPairingFrame } from "./protocol"
import { createPeerAdvertisement, createWorkspaceOwnershipTransfer, createWorkspaceRevocation, verifyDeviceChain,
  verifyWorkspaceMemberBundle, verifyWorkspaceOwnershipTransfer, verifyWorkspaceRevocation, verifyWorkspaceGrant,
  createWorkspaceSuccessionPolicy, createWorkspaceSuccessionVote, createWorkspaceSuccessionClaim,
  verifyWorkspaceSuccessionPolicy, verifyWorkspaceSuccessionVote, verifyWorkspaceSuccessionClaim,
  MAX_SUCCESSION_EDITORS,
  type WorkspaceAuthority, type WorkspaceMemberBundle, type WorkspaceOwnershipTransfer, type WorkspaceRevocation,
  type WorkspaceSuccessionPolicy, type WorkspaceSuccessionVote, type WorkspaceSuccessionClaim } from "./meshRecords"
import { MeshReconnectPolicy } from "./meshReconnectPolicy"
import { acquireMeshInstanceLease } from "./meshInstanceLease"
import { meshTrace, type MeshTraceLevel } from "./meshTrace"
import { peerStore, type PeerStore, type WorkspaceMeshCredential, type WorkspacePeerRecord } from "./peerStore"
import type { SyncAcceptor, SyncConnection, SyncNode, SyncTransport, DuplexStream } from "./transport"
import { isNetworkFailure, liveWorkspaceSetSync, MESH_HEARTBEAT_INTERVAL_MS, networkConnection, networkIO, workspaceSet, type WorkspaceSetStore } from "./workspaceSet"
import type { LiveWorkspaceSync, WorkspaceReplica } from "./session"

export type MeshWorkspaceEnvelope = {
  version: 1
  workspaceId: string
  ownerPersonId: string
  ownerPublicKey: string
  ownerCertificates: unknown[]
  transportSecret: string
  epoch: number
  peers: WorkspaceMemberBundle[]
  revocations?: WorkspaceRevocation[]
  ownerHistory?: WorkspaceAuthority[]
  ownershipTransfers?: WorkspaceOwnershipTransfer[]
  successionPolicy?: WorkspaceSuccessionPolicy
  successionVotes?: WorkspaceSuccessionVote[]
  successionClaims?: WorkspaceSuccessionClaim[]
}

export type MeshExport = {
  version: 1
  peers: WorkspaceMemberBundle[]
  revocations: WorkspaceRevocation[]
  ownershipTransfers?: WorkspaceOwnershipTransfer[]
  successionPolicy?: WorkspaceSuccessionPolicy
  successionVotes?: WorkspaceSuccessionVote[]
  successionClaims?: WorkspaceSuccessionClaim[]
}

export type MeshPeerView = {
  workspaceId: string
  personId: string
  deviceId: string
  instances?: number
  role: "owner" | "editor" | "visitor"
  endpoint: string
  online: boolean
  lastSeen: string
  revokedAt?: string | null
  deviceName?: string
  userAgent?: string
}

export type MeshSuccessionView = {
  workspaceId: string
  successorPersonId: string | null
  eligibleEditorPersonIds: string[]
  votes: Array<{ voterPersonId: string; candidatePersonId: string }>
  quorum: number
  conflicted: boolean
}

type SessionEntry = {
  workspaceId: string
  deviceId: string
  instanceId: string
  remoteIssuedAt: string
  direction: "incoming" | "outgoing"
  connection: SyncConnection
  session: LiveWorkspaceSync
}

type DurableMeshOptions = {
  transport: SyncTransport
  workspaceStore: WorkspaceSetStore
  workspace: WorkspaceReplica
  getProfile: () => Promise<LocalProfile>
  store?: PeerStore
  onChange?: (workspaces: string[], peers: MeshPeerView[], revoked: string[], succession: MeshSuccessionView[]) => void
  onDiagnostic?: (message: string) => void
}

class MeshNodeRestart extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = "MeshNodeRestart"
  }
}

const MESH_INSTANCE_KEY = "match.mesh.instance.v1"

function uniqueCertificates(profile: LocalProfile, certificates: Awaited<ReturnType<typeof defaultProofStore.listCertificates>>) {
  const all = [profile.certificate, ...certificates]
  const seen = new Set<string>()
  return all.filter(cert => {
    const key = `${cert.payload.deviceId}:${cert.signature}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isEnvelope(value: unknown): value is MeshWorkspaceEnvelope {
  const item = value as MeshWorkspaceEnvelope
  return Boolean(item && item.version === 1 && typeof item.workspaceId === "string" && item.workspaceId &&
    typeof item.ownerPersonId === "string" && item.ownerPersonId && typeof item.ownerPublicKey === "string" && item.ownerPublicKey &&
    typeof item.transportSecret === "string" && item.transportSecret && Number.isSafeInteger(item.epoch) && item.epoch >= 1 &&
    Array.isArray(item.ownerCertificates) && item.ownerCertificates.length <= 32 && Array.isArray(item.peers) && item.peers.length <= 512 &&
    (item.ownerHistory === undefined || Array.isArray(item.ownerHistory)) &&
    (item.ownershipTransfers === undefined || Array.isArray(item.ownershipTransfers)) &&
    (item.successionVotes === undefined || (Array.isArray(item.successionVotes) && item.successionVotes.length <= MAX_SUCCESSION_EDITORS)) &&
    (item.successionClaims === undefined || (Array.isArray(item.successionClaims) && item.successionClaims.length <= 32)))
}

type MeshCatalog = { revocations?: WorkspaceRevocation[]; ownershipTransfers?: WorkspaceOwnershipTransfer[]
  successionPolicy?: WorkspaceSuccessionPolicy; successionVotes?: WorkspaceSuccessionVote[]; successionClaims?: WorkspaceSuccessionClaim[] }
const meshCapabilities = ["heartbeat-v1"]

function meshCatalog(credential: WorkspaceMeshCredential): MeshCatalog {
  return (credential.catalog as MeshCatalog | undefined) ?? {}
}

function revocations(credential: WorkspaceMeshCredential): WorkspaceRevocation[] {
  const value = meshCatalog(credential)
  return Array.isArray(value?.revocations) ? value.revocations : []
}

function ownershipTransfers(credential: WorkspaceMeshCredential): WorkspaceOwnershipTransfer[] {
  const value = meshCatalog(credential)
  return Array.isArray(value.ownershipTransfers) ? value.ownershipTransfers : []
}

function successionPolicy(credential: WorkspaceMeshCredential) { return meshCatalog(credential).successionPolicy }
function successionVotes(credential: WorkspaceMeshCredential) { return meshCatalog(credential).successionVotes ?? [] }
function successionClaims(credential: WorkspaceMeshCredential) { return meshCatalog(credential).successionClaims ?? [] }

function ownerAuthorities(credential: WorkspaceMeshCredential): WorkspaceAuthority[] {
  return [{ personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey,
    certificates: credential.ownerCertificates as any }, ...((credential.ownerHistory ?? []) as WorkspaceAuthority[])]
}

function revokedPersonIds(credential: WorkspaceMeshCredential) {
  return new Set(revocations(credential).map(record => record.payload.personId))
}

export async function startPersistentNode(transport: SyncTransport, store: PeerStore = peerStore, instanceId?: string) {
  return transport.start(instanceId
    ? await store.getOrCreateInstanceNodeSecret(instanceId)
    : await store.getOrCreateNodeSecret())
}

export class DurableMesh {
  private readonly store: PeerStore
  private task: Promise<void> | undefined
  private abortController: AbortController | undefined
  private node: SyncNode | undefined
  private acceptor: SyncAcceptor | undefined
  private sessions = new Map<string, SessionEntry>()
  private connecting = new Set<string>()
  private pendingIncomingConnections = 0
  private runSequence = 0
  private currentRunId = 0
  private connectionSequence = 0
  private stopped = true
  private stopWatch: (() => void) | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private failures = new Map<string, number>()
  private failedAt = new Map<string, number>()
  private readonly reconnectPolicy = new MeshReconnectPolicy()
  private readonly runtimeId = crypto.randomUUID()
  private instanceId = ""
  private releaseInstance: (() => Promise<void>) | undefined
  private externallyPaused = false
  private disposed = false
  private adoptedNode: SyncNode | undefined
  private lastDiagnostic = ""

  constructor(private readonly options: DurableMeshOptions) {
    this.store = options.store ?? peerStore
    this.trace("instance.created")
  }

  private trace(event: string, detail: Record<string, unknown> = {}, level: MeshTraceLevel = "info") {
    meshTrace(event, { runtimeId: this.runtimeId.slice(0, 8), runId: this.currentRunId, ...detail }, level)
  }

  private connectionId(direction: "incoming" | "outgoing") {
    this.connectionSequence += 1
    return `${direction === "incoming" ? "in" : "out"}-${this.connectionSequence}`
  }

  private peerKey(workspaceId: string, deviceId: string, instanceId = "legacy") {
    return `${workspaceId}:${deviceId}:${instanceId}`
  }

  private async acquireInstance() {
    if (this.releaseInstance) return
    const preferred = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(MESH_INSTANCE_KEY)
    const lease = await acquireMeshInstanceLease({ preferredInstanceId: preferred })
    this.instanceId = lease.instanceId
    this.releaseInstance = lease.release
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(MESH_INSTANCE_KEY, lease.instanceId)
    this.trace("instance.acquired", { instanceId: lease.instanceId })
  }

  async startInstanceNode(): Promise<SyncNode> {
    await this.acquireInstance()
    return startPersistentNode(this.options.transport, this.store, this.instanceId)
  }

  private async peerInstances(workspaceId?: string) {
    const list = (this.store as PeerStore & { listPeerInstances?: PeerStore["listPeerInstances"] }).listPeerInstances
    if (list) return list.call(this.store, workspaceId)
    const listPeers = (this.store as PeerStore & { listPeers?: PeerStore["listPeers"] }).listPeers
    return listPeers ? listPeers.call(this.store, workspaceId) : []
  }

  private report(stage: string, error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    this.lastDiagnostic = `${stage}: ${detail || "unknown transport error"}`
    this.trace("diagnostic", { stage, reason: detail || "unknown transport error" }, "warn")
    this.options.onDiagnostic?.(this.lastDiagnostic)
    void this.notify()
  }

  private reportProtocolFailure(stage: string, error: unknown) {
    if (isNetworkFailure(error)) {
      void this.notify()
      return
    }
    this.report(stage, error)
  }

  async pauseAll(): Promise<void> {
    this.externallyPaused = true
    await this.stop(false)
  }

  async resumeAll(node?: SyncNode): Promise<void> {
    if (this.disposed) return void node?.close("Mesh disposed")
    if (node) {
      await this.adoptedNode?.close("Mesh node replaced").catch(() => {})
      this.adoptedNode = node
    }
    this.externallyPaused = false
    await this.start()
  }

  async waitUntilListening(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!this.disposed && !this.externallyPaused && !this.stopped && (!this.node || !this.acceptor)) {
      if (Date.now() >= deadline) throw new Error("Workspace mesh did not resume in time")
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    if (this.disposed || this.externallyPaused || this.stopped) {
      throw new Error("Workspace mesh stopped before it resumed")
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
  }

  private async refreshOwnerCertificates(credential: WorkspaceMeshCredential, profile: LocalProfile,
    certificates: DeviceCertificate[]): Promise<WorkspaceMeshCredential> {
    if (credential.ownerPersonId !== profile.identity.personId) return credential
    const ownerCertificates = [...new Map([
      ...credential.ownerCertificates as DeviceCertificate[],
      ...certificates,
    ].map(certificate => [certificate.signature, certificate])).values()]
    const hasStaleGrant = credential.localGrant !== undefined
    if (ownerCertificates.length === credential.ownerCertificates.length && !hasStaleGrant) return credential
    const { localGrant: _staleGrant, ...ownerCredential } = credential
    const next = { ...ownerCredential, ownerCertificates, updatedAt: new Date().toISOString() }
    await this.store.putWorkspaceCredential(next)
    return next
  }

  private async credentialBelongsToProfile(credential: WorkspaceMeshCredential, profile: LocalProfile): Promise<boolean> {
    if (credential.ownerPersonId === profile.identity.personId) {
      return credential.ownerPublicKey === profile.identity.publicKey
    }
    const grant = credential.localGrant as WorkspaceGrant | undefined
    if (!grant || grant.payload.personId !== profile.identity.personId) return false
    for (const authority of ownerAuthorities(credential)) {
      try {
        await verifyWorkspaceGrant(grant, {
          workspaceId: credential.workspaceId,
          personId: profile.identity.personId,
          ownerPersonId: authority.personId,
          ownerPublicKey: authority.publicKey,
          ownerCertificates: authority.certificates,
        })
        return true
      } catch {}
    }
    return false
  }

  private async detachCredentialsFromPreviousIdentity(credentials: WorkspaceMeshCredential[], profile: LocalProfile) {
    const active: WorkspaceMeshCredential[] = []
    for (const credential of credentials) {
      if (await this.credentialBelongsToProfile(credential, profile)) {
        active.push(credential)
        continue
      }
      // Enrollment replaces the person identity but intentionally keeps local workspace data.
      // A credential issued to the previous identity cannot authenticate the new profile.
      await this.store.removeWorkspaceMeshData(credential.workspaceId)
      await defaultProofStore.removeWorkspaceGrants(credential.workspaceId)
    }
    return active
  }

  async ensureOwnerWorkspaces(workspaceIds: string[], endpoint: string, profile: LocalProfile): Promise<void> {
    await this.acquireInstance()
    const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
    for (const workspaceId of workspaceIds) {
      let credential = await this.store.getWorkspaceCredential(workspaceId)
      if (credential && credential.ownerPersonId !== profile.identity.personId) throw new Error("Only the workspace owner can invite peers")
      if (!credential) {
        credential = {
          version: 1,
          workspaceId,
          ownerPersonId: profile.identity.personId,
          ownerPublicKey: profile.identity.publicKey,
          ownerCertificates: certificates,
          transportSecret: createPairingSecret(),
          epoch: 1,
          updatedAt: new Date().toISOString(),
        }
        await this.store.putWorkspaceCredential(credential)
      } else {
        credential = await this.refreshOwnerCertificates(credential, profile, certificates)
      }
      await this.refreshOwnBundle(credential, profile, endpoint, certificates)
    }
    await this.notify()
  }

  async createGuestAdvertisements(workspaceIds: string[], endpoint: string, profile: LocalProfile): Promise<WorkspaceMemberBundle[]> {
    await this.acquireInstance()
    const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
    return Promise.all(workspaceIds.map(workspaceId => createPeerAdvertisement(profile, workspaceId, endpoint,
      { certificates, instanceId: this.instanceId })))
  }

  async forgetEnrolledDevice(workspaceIds: string[], deviceId: string): Promise<void> {
    for (const workspaceId of new Set(workspaceIds)) {
      for (const [key, entry] of [...this.sessions]) {
        if (entry.workspaceId !== workspaceId || entry.deviceId !== deviceId) continue
        this.sessions.delete(key)
        this.connecting.delete(key)
        this.failures.delete(key)
        this.failedAt.delete(key)
        await entry.session.close().catch(() => {})
        await entry.connection.close().catch(() => {})
      }
      await this.store.removePeer(workspaceId, deviceId)
    }
  }

  async knowsWorkspaceIssuer(workspaceIds: string[], personId: string, deviceId: string): Promise<boolean> {
    const profile = await this.options.getProfile()
    for (const id of workspaceIds) {
      const credential = await this.store.getWorkspaceCredential(id)
      const issuer = await this.store.getPeer(id, deviceId)
      if (!credential || credential.ownerPersonId !== personId || !issuer?.advertisement ||
        issuer.personId !== personId || issuer.revokedAt || revokedPersonIds(credential).has(profile.identity.personId)) return false
      if (profile.identity.personId !== personId &&
        (credential.localGrant as WorkspaceGrant | undefined)?.payload.personId !== profile.identity.personId) return false
    }
    return workspaceIds.length > 0
  }

  async acceptGuest(workspaceIds: string[], rawBundles: unknown, grants: WorkspaceGrant[]): Promise<void> {
    if (!Array.isArray(rawBundles) || rawBundles.length !== workspaceIds.length) throw new Error("Invalid peer advertisements")
    for (const workspaceId of workspaceIds) {
      const credential = await this.store.getWorkspaceCredential(workspaceId)
      const raw = rawBundles.find((bundle: any) => bundle?.advertisement?.payload?.workspaceId === workspaceId)
      const grant = grants.find(item => item.payload.workspaceId === workspaceId)
      if (!credential || !raw || !grant) throw new Error("Missing workspace mesh authority")
      await this.putVerifiedBundle(credential, { ...raw, grant, ownerPublicKey: credential.ownerPublicKey,
        ownerCertificates: credential.ownerCertificates } as WorkspaceMemberBundle)
      await this.refreshSuccessionPolicy(workspaceId)
    }
    await this.notify()
  }

  async invitationPayload(workspaceIds: string[]): Promise<MeshWorkspaceEnvelope[]> {
    const result: MeshWorkspaceEnvelope[] = []
    for (const workspaceId of workspaceIds) {
      const credential = await this.store.getWorkspaceCredential(workspaceId)
      if (!credential) throw new Error("Missing workspace mesh credential")
      result.push({
        version: 1,
        workspaceId,
        ownerPersonId: credential.ownerPersonId,
        ownerPublicKey: credential.ownerPublicKey,
        ownerCertificates: credential.ownerCertificates,
        transportSecret: credential.transportSecret,
        epoch: credential.epoch,
        peers: (await this.peerInstances(workspaceId)).filter(peer => !peer.revokedAt && peer.advertisement)
          .map(peer => peer.advertisement as WorkspaceMemberBundle),
        revocations: revocations(credential),
        ownerHistory: ownerAuthorities(credential).slice(1),
        ownershipTransfers: ownershipTransfers(credential),
        successionPolicy: successionPolicy(credential),
        successionVotes: successionVotes(credential),
        successionClaims: successionClaims(credential),
      })
    }
    return result
  }

  async receiveInvitation(raw: unknown, workspaceIds: string[], profile: LocalProfile, grants: WorkspaceGrant[]): Promise<void> {
    if (!Array.isArray(raw) || raw.length !== workspaceIds.length ||
      new TextEncoder().encode(JSON.stringify(raw)).byteLength > 8 * 1024 * 1024) throw new Error("Invalid mesh invitation")
    for (const workspaceId of workspaceIds) {
      const envelope = raw.find((item: any) => item?.workspaceId === workspaceId)
      if (!isEnvelope(envelope)) throw new Error("Invalid mesh invitation")
      const localGrant = grants.find(grant => grant.payload.workspaceId === workspaceId)
      const isOwner = envelope.ownerPersonId === profile.identity.personId
      if (!isOwner && (!localGrant || localGrant.payload.personId !== profile.identity.personId)) throw new Error("Missing local workspace grant")
      await verifyDeviceChain({ personId: envelope.ownerPersonId, publicKey: envelope.ownerPublicKey,
        deviceId: (envelope.ownerCertificates[0] as any)?.payload?.deviceId, certificates: envelope.ownerCertificates as any })
      for (const authority of envelope.ownerHistory ?? []) {
        await verifyDeviceChain({ personId: authority.personId, publicKey: authority.publicKey,
          deviceId: authority.certificates[0]?.payload.deviceId, certificates: authority.certificates })
      }
      if (localGrant) await verifyWorkspaceGrant(localGrant, { workspaceId, personId: profile.identity.personId,
        ownerPersonId: envelope.ownerPersonId, ownerPublicKey: envelope.ownerPublicKey, ownerCertificates: envelope.ownerCertificates as any })
      let credential: WorkspaceMeshCredential = {
        version: 1,
        workspaceId,
        ownerPersonId: envelope.ownerPersonId,
        ownerPublicKey: envelope.ownerPublicKey,
        ownerCertificates: envelope.ownerCertificates,
        ownerHistory: envelope.ownerHistory,
        transportSecret: envelope.transportSecret,
        epoch: envelope.epoch,
        updatedAt: new Date().toISOString(),
        ...(localGrant ? { localGrant } : {}),
        catalog: { revocations: [], ownershipTransfers: envelope.ownershipTransfers ?? [],
          successionPolicy: undefined, successionVotes: [], successionClaims: [] },
      }
      await this.store.putWorkspaceCredential(credential)
      if (envelope.revocations) await this.mergeRevocations(credential, envelope.revocations)
      await this.mergeSuccessionState(await this.store.getWorkspaceCredential(workspaceId) ?? credential,
        envelope.successionPolicy, envelope.successionVotes ?? [], envelope.successionClaims ?? [])
      credential = await this.store.getWorkspaceCredential(workspaceId) ?? credential
      await this.mergePeerBundles(credential, envelope.peers)
    }
    await this.notify()
  }

  async exportWorkspace(workspaceId: string): Promise<MeshExport> {
    const peers = (await this.peerInstances(workspaceId)).filter(peer => !peer.revokedAt && peer.advertisement)
      .map(peer => peer.advertisement as WorkspaceMemberBundle)
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    return { version: 1, peers, revocations: credential ? revocations(credential) : [],
      ownershipTransfers: credential ? ownershipTransfers(credential) : [],
      successionPolicy: credential ? successionPolicy(credential) : undefined,
      successionVotes: credential ? successionVotes(credential) : [],
      successionClaims: credential ? successionClaims(credential) : [] }
  }

  async mergeWorkspace(workspaceId: string, raw: unknown): Promise<void> {
    const value = raw as MeshExport
    if (!value || value.version !== 1 || !Array.isArray(value.peers) || value.peers.length > 512 ||
      !Array.isArray(value.revocations) || value.revocations.length > 512 ||
      (value.ownershipTransfers !== undefined && (!Array.isArray(value.ownershipTransfers) || value.ownershipTransfers.length > 32)) ||
      (value.successionVotes !== undefined && (!Array.isArray(value.successionVotes) || value.successionVotes.length > MAX_SUCCESSION_EDITORS)) ||
      (value.successionClaims !== undefined && (!Array.isArray(value.successionClaims) || value.successionClaims.length > 32)) ||
      new TextEncoder().encode(JSON.stringify(value)).byteLength > 8 * 1024 * 1024) throw new Error("Invalid mesh catalog")
    let credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential) return
    credential = await this.mergeOwnershipTransfers(credential, value.ownershipTransfers ?? [])
    await this.mergeRevocations(credential, value.revocations)
    credential = await this.store.getWorkspaceCredential(workspaceId) ?? credential
    await this.mergeSuccessionState(credential, value.successionPolicy, value.successionVotes ?? [], value.successionClaims ?? [])
    credential = await this.store.getWorkspaceCredential(workspaceId) ?? credential
    await this.mergePeerBundles(credential, value.peers)
    await this.notify()
  }

  private async mergePeerBundles(credential: WorkspaceMeshCredential, bundles: WorkspaceMemberBundle[]) {
    for (const bundle of bundles) {
      try {
        await this.putVerifiedBundle(credential, bundle)
      } catch {
        // Peer catalogs are gossip. Reject one invalid member without letting it
        // tear down an authenticated session between other valid members.
      }
    }
  }

  private async putVerifiedBundle(credential: WorkspaceMeshCredential, raw: WorkspaceMemberBundle) {
    const verified = await verifyWorkspaceMemberBundle(raw, {
      workspaceId: credential.workspaceId,
      ownerPersonId: credential.ownerPersonId,
      ownerPublicKey: credential.ownerPublicKey,
      ownerCertificates: credential.ownerCertificates as any,
      ownerHistory: ownerAuthorities(credential).slice(1),
    })
    const ownerCertificates = [...new Map([
      ...credential.ownerCertificates as DeviceCertificate[],
      ...(verified.ownerCertificates ?? []),
    ].map(certificate => [certificate.signature, certificate])).values()]
    if (ownerCertificates.length > credential.ownerCertificates.length) {
      await this.store.putWorkspaceCredential({ ...credential, ownerCertificates, updatedAt: new Date().toISOString() })
    }
    const p = verified.advertisement.payload
    if (revokedPersonIds(credential).has(p.personId)) throw new Error("Workspace member is revoked")
    const record: WorkspacePeerRecord = {
      workspaceId: p.workspaceId,
      personId: p.personId,
      deviceId: p.deviceId,
      instanceId: p.instanceId,
      endpoint: p.endpoint,
      transportSecret: credential.transportSecret,
      role: verified.role,
      lastSeen: p.issuedAt,
      advertisement: raw,
    }
    await this.store.upsertPeer(record)
  }

  private async mergeOwnershipTransfers(
    initialCredential: WorkspaceMeshCredential,
    raw: WorkspaceOwnershipTransfer[],
  ): Promise<WorkspaceMeshCredential> {
    let credential = initialCredential
    const stored = ownershipTransfers(credential)
    const known = new Map(stored.map(record => [record.signature, record]))
    for (const record of raw) if (record?.signature) known.set(record.signature, record)
    const accepted = new Map(stored.filter(record => (record.payload?.epoch ?? 0) <= credential.epoch)
      .map(record => [record.signature, record]))
    const pending = [...known.values()].filter(record => (record.payload?.epoch ?? 0) > credential.epoch)
      .sort((a, b) => (a.payload?.epoch ?? 0) - (b.payload?.epoch ?? 0) || a.signature.localeCompare(b.signature))
    for (const value of pending) {
      if ((value.payload?.epoch ?? 0) <= credential.epoch) continue
      const previousOwner = credential.ownerPersonId
      const authority: WorkspaceAuthority = { personId: previousOwner, publicKey: credential.ownerPublicKey,
        certificates: credential.ownerCertificates as any }
      const record = await verifyWorkspaceOwnershipTransfer(value, credential.workspaceId, authority, credential.epoch)
      const p = record.payload
      if (revokedPersonIds(credential).has(p.toOwnerPersonId)) throw new Error("New owner access is revoked")
      accepted.set(record.signature, record)
      const profile = await this.options.getProfile()
      const history = [...((credential.ownerHistory ?? []) as WorkspaceAuthority[])]
      if (!history.some(owner => owner.personId === authority.personId)) history.push(authority)
      const localGrant = profile.identity.personId === p.toOwnerPersonId
        ? p.toOwnerGrant
        : profile.identity.personId === p.fromOwnerPersonId
          ? p.formerOwnerGrant
          : credential.localGrant
      const next: WorkspaceMeshCredential = {
        ...credential,
        ownerPersonId: p.toOwnerPersonId,
        ownerPublicKey: p.toOwnerPublicKey,
        ownerCertificates: p.toOwnerCertificates,
        ownerHistory: history,
        localGrant,
        epoch: p.epoch,
        updatedAt: p.transferredAt,
        catalog: { ...meshCatalog(credential), ownershipTransfers: [...accepted.values()].sort((a, b) => a.payload.epoch - b.payload.epoch),
          successionPolicy: undefined, successionVotes: [] },
      }
      await this.store.transferWorkspaceCredential(previousOwner, next)
      credential = next

      for (const peer of await this.store.listPeers(credential.workspaceId)) {
        if (peer.personId !== p.fromOwnerPersonId && peer.personId !== p.toOwnerPersonId) continue
        const grant = peer.personId === p.fromOwnerPersonId ? p.formerOwnerGrant : p.toOwnerGrant
        const advertisement = peer.advertisement as WorkspaceMemberBundle | undefined
        const roleChangedAt = new Date(Math.max(Date.parse(peer.lastSeen), Date.parse(p.transferredAt)) + 1).toISOString()
        await this.store.upsertPeer({
          ...peer,
          role: peer.personId === p.toOwnerPersonId ? "owner" : "editor",
          lastSeen: roleChangedAt,
          ...(advertisement ? { advertisement: { ...advertisement, grant,
            ownerPublicKey: p.toOwnerPublicKey, ownerCertificates: p.toOwnerCertificates } } : {}),
        })
      }
    }
    return credential
  }

  private async mergeSuccessionState(initialCredential: WorkspaceMeshCredential, rawPolicy: WorkspaceSuccessionPolicy | undefined,
    rawVotes: WorkspaceSuccessionVote[], rawClaims: WorkspaceSuccessionClaim[]): Promise<WorkspaceMeshCredential> {
    let credential = initialCredential
    if (!rawPolicy && rawVotes.length === 0 && rawClaims.length === 0 && !successionPolicy(credential) &&
      successionVotes(credential).length === 0 && successionClaims(credential).length === 0) return credential
    const before = JSON.stringify({ policy: successionPolicy(credential), votes: successionVotes(credential), claims: successionClaims(credential) })
    const authority = (): WorkspaceAuthority => ({ personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey,
      certificates: credential.ownerCertificates as DeviceCertificate[] })
    let policy = successionPolicy(credential)
    if (rawPolicy?.payload?.ownerPersonId === credential.ownerPersonId && rawPolicy.payload.epoch === credential.epoch) {
      const verified = await verifyWorkspaceSuccessionPolicy(rawPolicy, credential.workspaceId, authority())
      if (!policy || verified.payload.updatedAt > policy.payload.updatedAt ||
        (verified.payload.updatedAt === policy.payload.updatedAt && verified.signature > policy.signature)) policy = verified
    }
    if (policy?.payload?.ownerPersonId === credential.ownerPersonId && policy.payload.epoch === credential.epoch) {
      await verifyWorkspaceSuccessionPolicy(policy, credential.workspaceId, authority())
    } else policy = undefined
    const voteMap = new Map<string, WorkspaceSuccessionVote>()
    if (policy) {
      for (const raw of [...successionVotes(credential), ...rawVotes]) {
        if (raw?.signed?.payload?.policySignature !== policy.signature) continue
        const vote = await verifyWorkspaceSuccessionVote(raw, policy, raw.signed.payload.candidatePersonId,
          authority(), revokedPersonIds(credential), Date.now())
        const key = vote.signed.payload.voterPersonId
        const previous = voteMap.get(key)
        if (!previous || vote.signed.signature < previous.signed.signature) voteMap.set(key, vote)
      }
    }
    const claimMap = new Map<string, WorkspaceSuccessionClaim>()
    for (const claim of successionClaims(credential)) {
      if (claim && typeof claim.signature === "string" && claim.signature) claimMap.set(claim.signature, claim)
    }
    for (const claim of rawClaims) {
      if (claim?.payload?.epoch === credential.epoch + 1 && claim.payload.fromOwnerPersonId === credential.ownerPersonId &&
        typeof claim.signature === "string" && claim.signature) {
        const verified = await verifyWorkspaceSuccessionClaim(claim, credential.workspaceId, authority(), credential.epoch,
          revokedPersonIds(credential))
        claimMap.set(verified.signature, verified)
        continue
      }
      if (claim?.payload?.epoch === credential.epoch &&
        typeof claim.signature === "string" && claim.signature) {
        const previousOwner = ownerAuthorities(credential).find(owner => owner.personId === claim.payload.fromOwnerPersonId)
        if (!previousOwner) continue
        const revokedAtClaim = new Set(revocations(credential)
          .filter(record => record.payload.epoch < claim.payload.epoch).map(record => record.payload.personId))
        const verified = await verifyWorkspaceSuccessionClaim(claim, credential.workspaceId, previousOwner,
          claim.payload.epoch - 1, revokedAtClaim)
        claimMap.set(verified.signature, verified)
      }
    }
    const pending = [...claimMap.values()].filter(claim => claim.payload.epoch > credential.epoch)
      .sort((a, b) => a.payload.epoch - b.payload.epoch || a.signature.localeCompare(b.signature))
    for (const raw of pending) {
      if (raw.payload.epoch <= credential.epoch || raw.payload.fromOwnerPersonId !== credential.ownerPersonId) continue
      const previousOwner = authority()
      const claim = await verifyWorkspaceSuccessionClaim(raw, credential.workspaceId, previousOwner, credential.epoch,
        revokedPersonIds(credential))
      const p = claim.payload
      const profile = await this.options.getProfile()
      const history = [...((credential.ownerHistory ?? []) as WorkspaceAuthority[])]
      if (!history.some(owner => owner.personId === previousOwner.personId)) history.push(previousOwner)
      const localGrant = profile.identity.personId === p.toOwnerPersonId ? undefined
        : profile.identity.personId === p.fromOwnerPersonId ? p.formerOwnerGrant : credential.localGrant
      const next: WorkspaceMeshCredential = {
        ...credential,
        ownerPersonId: p.toOwnerPersonId,
        ownerPublicKey: p.toOwnerPublicKey,
        ownerCertificates: p.toOwnerCertificates,
        ownerHistory: history,
        ...(localGrant ? { localGrant } : {}),
        epoch: p.epoch,
        updatedAt: p.claimedAt,
        catalog: { ...meshCatalog(credential), successionPolicy: undefined, successionVotes: [],
          successionClaims: [...claimMap.values()].sort((a, b) => a.payload.epoch - b.payload.epoch) },
      }
      if (!localGrant) delete (next as any).localGrant
      await this.store.transferWorkspaceCredential(previousOwner.personId, next)
      credential = next
      for (const peer of await this.store.listPeers(credential.workspaceId)) {
        if (peer.personId !== p.fromOwnerPersonId && peer.personId !== p.toOwnerPersonId) continue
        const advertisement = peer.advertisement as WorkspaceMemberBundle | undefined
        await this.store.upsertPeer({ ...peer, role: peer.personId === p.toOwnerPersonId ? "owner" : "editor",
          lastSeen: new Date(Math.max(Date.parse(peer.lastSeen), Date.parse(p.claimedAt)) + 1).toISOString(),
          ...(advertisement ? { advertisement: { ...advertisement,
            ...(peer.personId === p.fromOwnerPersonId ? { grant: p.formerOwnerGrant } : {}),
            ownerPublicKey: p.toOwnerPublicKey, ownerCertificates: p.toOwnerCertificates } } : {}) })
      }
    }
    const currentCatalog = meshCatalog(credential)
    if (credential.ownerPersonId === initialCredential.ownerPersonId) {
      const votes = [...voteMap.values()].sort((a, b) => a.signed.payload.voterPersonId.localeCompare(b.signed.payload.voterPersonId))
      const claims = [...claimMap.values()].sort((a, b) => a.payload.epoch - b.payload.epoch || a.signature.localeCompare(b.signature))
      const nextCatalog = { ...currentCatalog, successionPolicy: policy, successionVotes: votes, successionClaims: claims }
      const candidateAfter = JSON.stringify({ policy, votes, claims })
      if (candidateAfter !== before) {
        await this.store.putWorkspaceCredential({ ...credential, updatedAt: new Date().toISOString(), catalog: nextCatalog })
        credential = await this.store.getWorkspaceCredential(credential.workspaceId) ?? credential
      }
    }
    const after = JSON.stringify({ policy: successionPolicy(credential), votes: successionVotes(credential), claims: successionClaims(credential) })
    if (after !== before && this.sessions.size > 0) queueMicrotask(() => { void this.publishAll() })
    return credential
  }

  async setSuccessor(workspaceId: string, personId: string | null): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential || credential.ownerPersonId !== profile.identity.personId) throw new Error("Only the workspace owner can set succession")
    const eligible = [...new Set((await this.store.listPeers(workspaceId))
      .filter(peer => peer.role === "editor" && !peer.revokedAt).map(peer => peer.personId))].sort()
    if (personId && !eligible.includes(personId)) throw new Error("Successor must be an editor")
    const policy = await createWorkspaceSuccessionPolicy(profile, workspaceId, personId, eligible, credential.epoch)
    await this.store.putWorkspaceCredential({ ...credential, updatedAt: new Date().toISOString(),
      catalog: { ...meshCatalog(credential), successionPolicy: policy, successionVotes: [] } })
    await this.notify()
    await this.publishAll()
  }

  private async refreshSuccessionPolicy(workspaceId: string): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    const current = credential && successionPolicy(credential)
    if (!credential || !current || credential.ownerPersonId !== profile.identity.personId) return
    const eligible = [...new Set((await this.store.listPeers(workspaceId))
      .filter(peer => peer.role === "editor" && !peer.revokedAt).map(peer => peer.personId))].sort()
    const successor = current.payload.successorPersonId && eligible.includes(current.payload.successorPersonId)
      ? current.payload.successorPersonId : null
    if (eligible.join("\0") === current.payload.eligibleEditorPersonIds.join("\0") && successor === current.payload.successorPersonId &&
      current.payload.epoch === credential.epoch) return
    const policy = await createWorkspaceSuccessionPolicy(profile, workspaceId, successor, eligible, credential.epoch)
    await this.store.putWorkspaceCredential({ ...credential, updatedAt: new Date().toISOString(),
      catalog: { ...meshCatalog(credential), successionPolicy: policy, successionVotes: [] } })
  }

  async voteForSuccessor(workspaceId: string, candidatePersonId: string): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    const policy = credential && successionPolicy(credential)
    const grant = credential?.localGrant as WorkspaceGrant | undefined
    if (!credential || !policy || !grant || grant.payload.role !== "editor") throw new Error("Only an eligible editor can vote")
    const existing = successionVotes(credential).find(vote => vote.signed.payload.voterPersonId === profile.identity.personId)
    if (existing?.signed.payload.candidatePersonId === candidatePersonId) return
    if (existing) throw new Error("Your vote is already recorded for this policy")
    const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
    const vote = await createWorkspaceSuccessionVote(profile, policy, candidatePersonId, grant,
      new Date().toISOString(), certificates)
    await this.mergeSuccessionState(credential, policy, [vote], [])
    await this.notify()
    await this.publishAll()
  }

  async claimSuccession(workspaceId: string): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    const policy = credential && successionPolicy(credential)
    const grant = credential?.localGrant as WorkspaceGrant | undefined
    if (!credential || !policy || !grant || grant.payload.role !== "editor") throw new Error("Only an eligible editor can claim ownership")
    const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
    const doc = Automerge.load<any>(await this.options.workspaceStore.read(workspaceId))
    const claim = await createWorkspaceSuccessionClaim(profile, policy, successionVotes(credential), grant,
      Automerge.getHeads(doc), credential.epoch + 1, certificates)
    await this.mergeSuccessionState(credential, policy, successionVotes(credential), [claim])
    await this.notify()
    await this.publishAll()
  }

  private async mergeRevocations(credential: WorkspaceMeshCredential, raw: unknown[], disconnect = true) {
    const current = new Map(revocations(credential).map(record => [record.payload.personId, record]))
    for (const value of raw) {
      let record: WorkspaceRevocation | undefined
      for (const authority of ownerAuthorities(credential)) {
        try {
          record = await verifyWorkspaceRevocation(value, credential.workspaceId, authority.personId,
            authority.publicKey, authority.certificates)
          break
        } catch {}
      }
      if (!record) throw new Error("Invalid workspace revocation signature")
      if (record.payload.personId === credential.ownerPersonId) continue
      const previous = current.get(record.payload.personId)
      if (!previous || record.payload.epoch > previous.payload.epoch) current.set(record.payload.personId, record)
    }
    const merged = [...current.values()].sort((a, b) => a.payload.personId.localeCompare(b.payload.personId))
    const epoch = Math.max(credential.epoch, ...merged.map(record => record.payload.epoch))
    await this.store.putWorkspaceCredential({ ...credential, epoch, updatedAt: new Date().toISOString(),
      catalog: { ...meshCatalog(credential), revocations: merged } })
    const peers = await this.store.listPeers(credential.workspaceId)
    for (const peer of peers) {
      const record = current.get(peer.personId)
      if (!record) continue
      if (!peer.revokedAt) await this.store.upsertPeer({ ...peer, lastSeen: new Date().toISOString(), revokedAt: record.payload.revokedAt })
      const sessions = [...this.sessions.entries()].filter(([, session]) =>
        session.workspaceId === credential.workspaceId && session.deviceId === peer.deviceId)
      if (disconnect) for (const [key, session] of sessions) {
        this.sessions.delete(key)
        await session.session.close()
      }
    }
    const localPersonId = (credential.localGrant as WorkspaceGrant | undefined)?.payload.personId
    if (localPersonId && current.has(localPersonId)) throw new Error("Workspace access revoked")
  }

  async revokePerson(workspaceId: string, personId: string): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential || credential.ownerPersonId !== profile.identity.personId) throw new Error("Only the workspace owner can revoke access")
    const record = await createWorkspaceRevocation(profile, workspaceId, personId, credential.epoch + 1)
    await this.mergeRevocations(credential, [record], false)
    await this.refreshSuccessionPolicy(workspaceId)
    // Gossip tombstone before severing the revoked session. Other members converge on the owner's epoch.
    await this.publishAll()
    await this.mergeRevocations(await this.store.getWorkspaceCredential(workspaceId) ?? credential, [record])
    await this.notify()
  }

  async transferOwnership(workspaceId: string, personId: string): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential || credential.ownerPersonId !== profile.identity.personId) {
      throw new Error("Only the workspace owner can transfer ownership")
    }
    if (personId === profile.identity.personId) throw new Error("You already own this workspace")
    const peers = (await this.store.listPeers(workspaceId)).filter(peer => peer.personId === personId && !peer.revokedAt)
    if (!peers.length) throw new Error("Select an active mesh member")
    if (!peers.some(peer => [...this.sessions.values()].some(session =>
      session.workspaceId === workspaceId && session.deviceId === peer.deviceId))) {
      throw new Error("Member must be online to receive ownership")
    }
    const raw = peers.find(peer => peer.advertisement)?.advertisement as WorkspaceMemberBundle | undefined
    if (!raw) throw new Error("Member identity is unavailable")
    const target = await verifyWorkspaceMemberBundle(raw, {
      workspaceId, ownerPersonId: credential.ownerPersonId, ownerPublicKey: credential.ownerPublicKey,
      ownerCertificates: credential.ownerCertificates as any, ownerHistory: ownerAuthorities(credential).slice(1),
    })
    const doc = Automerge.load<any>(await this.options.workspaceStore.read(workspaceId))
    const transfer = await createWorkspaceOwnershipTransfer(profile, workspaceId, {
      personId: target.payload.personId,
      publicKey: target.publicKey,
      certificates: target.certificates,
    }, Automerge.getHeads(doc), credential.epoch + 1)

    // Publish proof while old authority is still active. Target applies it before this device demotes itself.
    await this.store.putWorkspaceCredential({ ...credential, updatedAt: new Date().toISOString(),
      catalog: { ...meshCatalog(credential), ownershipTransfers: [...ownershipTransfers(credential), transfer] } })
    await this.publishAll()
    const current = await this.store.getWorkspaceCredential(workspaceId)
    if (!current) throw new Error("Workspace mesh credential disappeared")
    await this.mergeOwnershipTransfers(current, [transfer])
    await this.notify()
    await this.publishAll()
  }

  async leaveWorkspace(workspaceId: string): Promise<void> {
    if (!workspaceId) throw new Error("No active workspace")
    for (const [key, entry] of [...this.sessions]) {
      if (entry.workspaceId !== workspaceId) continue
      this.sessions.delete(key)
      await entry.session.close().catch(() => {})
      await entry.connection.close().catch(() => {})
    }
    await this.store.removeWorkspaceMeshData(workspaceId)
    await defaultProofStore.removeWorkspaceGrants(workspaceId)
    this.lastDiagnostic = ""
    this.options.onDiagnostic?.("")
    this.failures.delete(workspaceId)
    this.failedAt.delete(workspaceId)
    await this.notify()
  }

  async start(): Promise<void> {
    if (!this.stopped || this.externallyPaused || this.disposed) return
    if ((await this.store.listWorkspaceCredentials()).length === 0) {
      await this.adoptedNode?.close("No mesh credentials").catch(() => {})
      this.adoptedNode = undefined
      return
    }
    if (!this.stopped || this.externallyPaused || this.disposed) return
    await this.acquireInstance()
    if (!this.stopped || this.externallyPaused || this.disposed) return
    this.stopped = false
    this.trace("mesh.start")
    await this.notify()
    this.abortController = new AbortController()
    this.task = this.run(this.abortController.signal)
  }

  async stop(releaseInstance = true): Promise<void> {
    if (this.stopped) {
      if (releaseInstance) {
        await this.releaseInstance?.()
        this.releaseInstance = undefined
      }
      return
    }
    this.stopped = true
    this.trace("mesh.stop")
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.abortController?.abort()
    this.abortController = undefined
    await this.task?.catch(() => {})
    this.task = undefined
    await this.shutdown()
    if (releaseInstance) {
      await this.releaseInstance?.()
      this.releaseInstance = undefined
    }
  }

  private async shutdown() {
    this.trace("node.shutdown", { sessions: this.sessions.size, pendingIncoming: this.pendingIncomingConnections })
    this.stopWatch?.()
    this.stopWatch = undefined
    await this.dropSessions()
    await this.acceptor?.close().catch(() => {})
    this.acceptor = undefined
    const node = this.node
    this.node = undefined
    const adopted = this.adoptedNode
    this.adoptedNode = undefined
    await node?.close("Mesh stopped").catch(() => {})
    if (adopted !== node) await adopted?.close("Mesh stopped").catch(() => {})
    await this.notify()
  }

  private async run(signal: AbortSignal) {
    while (!signal.aborted) {
      this.currentRunId = ++this.runSequence
      this.trace("run.start")
      const offline = () => { void this.dropSessions() }
      const abort = () => { void this.shutdown() }
      try {
        const storedCredentials = await this.store.listWorkspaceCredentials()
        if (signal.aborted || storedCredentials.length === 0) return
        const profile = await this.options.getProfile()
        const credentials = await this.detachCredentialsFromPreviousIdentity(storedCredentials, profile)
        if (signal.aborted || credentials.length === 0) return
        // Every browser runtime owns one independently leased transport endpoint.
        // Workspace roles and grants remain attached to the approved device/person.
        const adoptedNode = this.adoptedNode
        this.adoptedNode = undefined
        const nodeSource = adoptedNode ? "adopted" : "instance"
        const node = adoptedNode ?? await startPersistentNode(this.options.transport, this.store, this.instanceId)
        if (signal.aborted) return void node.close("Mesh cancelled")
        this.node = node
        this.trace("node.started", {
          source: nodeSource,
          endpoint: node.endpointId.slice(0, 8),
        })
        const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
        for (let credential of credentials) {
          credential = await this.refreshOwnerCertificates(credential, profile, certificates)
          await this.refreshOwnBundle(credential, profile, node.endpointId, certificates)
          await this.pruneInvalidStoredPeers(credential, profile.device.deviceId)
        }
        this.acceptor = await node.accept()
        signal.addEventListener("abort", abort, { once: true })
        if (typeof window !== "undefined") window.addEventListener("offline", offline)
        this.stopWatch = this.options.workspace.subscribe?.(() => { void this.publishAll() })
        void this.acceptLoop(signal)
        await this.dialLoop(signal)
      } catch (error) {
        if (!signal.aborted) {
          if (error instanceof MeshNodeRestart) {
            this.trace("node.restart", { reason: error.reason })
          } else {
            this.report("Mesh restart", error)
            console.warn("Durable mesh restarting", error)
          }
        }
      } finally {
        signal.removeEventListener("abort", abort)
        if (typeof window !== "undefined") window.removeEventListener("offline", offline)
        await this.shutdown()
      }
      if (!signal.aborted) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(finish, 1_000)
          function finish() {
            clearTimeout(timer)
            signal.removeEventListener("abort", finish)
            resolve()
          }
          signal.addEventListener("abort", finish, { once: true })
        })
      }
    }
  }

  private async dropSessions() {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await this.notify()
    await Promise.allSettled(sessions.map(entry => entry.session.close()))
  }

  private async acceptLoop(signal: AbortSignal) {
    this.trace("accept.loop.started")
    while (!signal.aborted && this.acceptor) {
      try {
        const raw = await this.acceptor.accept()
        if (!raw) {
          this.trace("accept.loop.closed")
          return
        }
        const connectionId = this.connectionId("incoming")
        this.pendingIncomingConnections += 1
        this.trace("accept.connection", { connectionId })
        void this.acceptConnection(networkConnection(raw), signal, undefined, connectionId).finally(() => {
          this.pendingIncomingConnections = Math.max(0, this.pendingIncomingConnections - 1)
        })
      } catch (error) {
        if (!signal.aborted) {
          this.trace("accept.failed", { reason: error instanceof Error ? error.message : String(error) }, "warn")
          if (!isNetworkFailure(error)) console.warn("Mesh accept failed", error)
        }
      }
    }
  }

  async acceptOnInvitationNode(connection: SyncConnection, stream: DuplexStream, frame: Uint8Array) {
    await this.acceptConnection(connection, undefined, { stream, frame }, this.connectionId("incoming"))
    const entry = [...this.sessions.values()].find(item => item.connection === connection)
    if (!entry) return
    const unsubscribe = this.options.workspace.subscribe?.(() => {
      void entry.session.publish().catch(() => { void entry.session.close() })
    })
    try { await entry.session.done } finally { unsubscribe?.() }
  }

  private async acceptConnection(connection: SyncConnection, signal?: AbortSignal,
    initial?: { stream: DuplexStream; frame: Uint8Array }, connectionId = this.connectionId("incoming")) {
    try {
      this.trace("handshake.incoming.started", { connectionId })
      const stream = initial?.stream ?? await connection.acceptStream()
      const frame = initial?.frame ?? await stream.read()
      const header = inspectPairingFrame(frame)
      if (header.type !== "mesh-handshake-request") throw new Error("Unsupported mesh handshake")
      const credentials = await this.store.listWorkspaceCredentials()
      let credential = credentials.find(item => item.transportSecret === header.secret)
      if (!credential) throw new Error("Unknown mesh credential")
      const request = JSON.parse(new TextDecoder().decode(decodePairingFrame(frame, "mesh-handshake-request", credential.transportSecret)))
      if (request.workspaceId !== credential.workspaceId) throw new Error("Wrong mesh workspace")
      if (Array.isArray(request.ownershipTransfers)) {
        credential = await this.mergeOwnershipTransfers(credential, request.ownershipTransfers)
      }
      await this.mergeSuccessionState(credential, request.successionPolicy, request.successionVotes ?? [], request.successionClaims ?? [])
      credential = await this.store.getWorkspaceCredential(credential.workspaceId) ?? credential
      const remote = await verifyWorkspaceMemberBundle(request.peer, {
        workspaceId: credential.workspaceId, ownerPersonId: credential.ownerPersonId,
        ownerPublicKey: credential.ownerPublicKey, ownerCertificates: credential.ownerCertificates as any,
        ownerHistory: ownerAuthorities(credential).slice(1),
      })
      this.trace("handshake.incoming.verified", {
        connectionId,
        peerId: remote.advertisement.payload.deviceId.slice(0, 8),
        workspaceId: credential.workspaceId.slice(0, 8),
      })
      if (revokedPersonIds(credential).has(remote.advertisement.payload.personId)) {
        // A disconnected member must learn the owner's signed revocation on reconnect.
        // Send no workspace data and never establish a sync session.
        await stream.send(encodePairingFrame("mesh-handshake-response", credential.transportSecret,
          new TextEncoder().encode(JSON.stringify({ workspaceId: credential.workspaceId,
            peer: await this.ownBundle(credential), revocations: revocations(credential) }))))
        await stream.closeSend()
        const timeout = setTimeout(() => { void connection.close() }, 10_000)
        try { await connection.acceptStream() } finally { clearTimeout(timeout); await connection.close() }
        return
      }
      await this.putVerifiedBundle(credential, request.peer)
      const own = await this.ownBundle(credential)
      await stream.send(encodePairingFrame("mesh-handshake-response", credential.transportSecret,
        new TextEncoder().encode(JSON.stringify({ workspaceId: credential.workspaceId, peer: own,
          ownershipTransfers: ownershipTransfers(credential), successionPolicy: successionPolicy(credential),
          successionVotes: successionVotes(credential), successionClaims: successionClaims(credential), capabilities: meshCapabilities }))))
      await stream.closeSend()
      if (signal?.aborted) return
      await this.installSession(credential.workspaceId, remote.advertisement.payload.deviceId,
        remote.advertisement.payload.instanceId ?? "legacy", remote.advertisement.payload.issuedAt, "incoming", connection,
        Array.isArray(request.capabilities) && request.capabilities.includes("heartbeat-v1"), connectionId)
    } catch (error) {
      this.trace("handshake.incoming.failed", {
        connectionId,
        reason: error instanceof Error ? error.message : String(error),
      }, "warn")
      this.report("Incoming handshake", error)
      await connection.close()
    }
  }

  private async ownBundle(credential: WorkspaceMeshCredential) {
    const profile = await this.options.getProfile()
    const peers = await this.peerInstances(credential.workspaceId)
    const own = peers.find(peer => peer.deviceId === profile.device.deviceId && peer.instanceId === this.instanceId) ??
      peers.find(peer => peer.deviceId === profile.device.deviceId && !peer.instanceId) ??
      await this.store.getPeer(credential.workspaceId, profile.device.deviceId)
    if (!own?.advertisement) throw new Error("Missing local peer advertisement")
    return own.advertisement as WorkspaceMemberBundle
  }

  private async refreshOwnBundle(credential: WorkspaceMeshCredential, profile: LocalProfile,
    endpoint: string, certificates: DeviceCertificate[]) {
    const peerInstances = await this.peerInstances(credential.workspaceId)
    let current = peerInstances.find(peer => peer.deviceId === profile.device.deviceId && peer.instanceId === this.instanceId) ??
      peerInstances.find(peer => peer.deviceId === profile.device.deviceId && !peer.instanceId) ??
      await this.store.getPeer(credential.workspaceId, profile.device.deviceId)
    // Device enrollment keeps the browser's device key while replacing its person identity.
    // Never let the old identity win PeerStore's timestamp merge for the same device key.
    if (current && current.personId !== profile.identity.personId) {
      await this.store.removePeer(credential.workspaceId, profile.device.deviceId)
      current = null
    }
    let bundle = current?.advertisement as WorkspaceMemberBundle | undefined
    if (bundle) {
      try {
        await verifyWorkspaceMemberBundle(bundle, {
          workspaceId: credential.workspaceId, ownerPersonId: credential.ownerPersonId,
          ownerPublicKey: credential.ownerPublicKey, ownerCertificates: credential.ownerCertificates as DeviceCertificate[],
          ownerHistory: ownerAuthorities(credential).slice(1),
        })
      } catch {
        await this.store.removePeer(credential.workspaceId, profile.device.deviceId)
        current = null
        bundle = undefined
      }
    }
    const localGrant = credential.localGrant as WorkspaceGrant | undefined
    const role = credential.ownerPersonId === profile.identity.personId ? "owner" : localGrant?.payload.role
    const signatures = (items: DeviceCertificate[] | undefined) =>
      (items ?? []).map(item => item.signature).sort().join("\0")
    const issuedAt = bundle?.advertisement.payload.issuedAt
    const currentUserAgent = (typeof navigator !== "undefined" ? navigator.userAgent : "").trim().slice(0, 256) || undefined
    const reusable = bundle && issuedAt && Date.parse(issuedAt) > Date.now() - 7 * 24 * 60 * 60 * 1000 &&
      current?.endpoint === endpoint && current.role === role &&
      (!this.instanceId || bundle.advertisement.payload.instanceId === this.instanceId) &&
      bundle.advertisement.payload.deviceName === profile.device.displayName.slice(0, 256) &&
      bundle.advertisement.payload.userAgent === currentUserAgent &&
      bundle.publicKey === profile.identity.publicKey && bundle.ownerPublicKey === credential.ownerPublicKey &&
      bundle.grant?.signature === localGrant?.signature && signatures(bundle.certificates) === signatures(certificates) &&
      signatures(bundle.ownerCertificates) === signatures(credential.ownerCertificates as DeviceCertificate[])
    if (reusable) return bundle
    const next = await createPeerAdvertisement(profile, credential.workspaceId, endpoint, {
      certificates,
      grant: localGrant,
      ownerPublicKey: credential.ownerPublicKey,
      ownerCertificates: credential.ownerCertificates as DeviceCertificate[],
      ...(this.instanceId ? { instanceId: this.instanceId } : {}),
    })
    await this.putVerifiedBundle(credential, next)
    return next
  }

  private async pruneInvalidStoredPeers(credential: WorkspaceMeshCredential, localDeviceId: string) {
    for (const peer of await this.store.listPeers(credential.workspaceId)) {
      if (peer.deviceId === localDeviceId || peer.revokedAt || !peer.advertisement) continue
      try {
        await verifyWorkspaceMemberBundle(peer.advertisement, {
          workspaceId: credential.workspaceId, ownerPersonId: credential.ownerPersonId,
          ownerPublicKey: credential.ownerPublicKey, ownerCertificates: credential.ownerCertificates as DeviceCertificate[],
          ownerHistory: ownerAuthorities(credential).slice(1),
        })
      } catch {
        await this.store.removePeer(credential.workspaceId, peer.deviceId)
        for (const key of [...this.failures.keys()]) if (key.startsWith(`${credential.workspaceId}:${peer.deviceId}:`)) {
          this.failures.delete(key)
          this.failedAt.delete(key)
        }
      }
    }
  }

  private async dialLoop(signal: AbortSignal) {
    while (!signal.aborted) {
      if (!this.node) throw new MeshNodeRestart("runtime node unavailable")
      const profile = await this.options.getProfile()
      const peers = (await this.peerInstances()).filter(peer =>
        !peer.revokedAt && peer.deviceId !== profile.device.deviceId)
      for (const peer of peers) {
        // Newer signed endpoints introduce themselves. Stable advertisements preserve
        // one dialer per pair; endpoint changes reverse direction and propagate.
        const own = (await this.peerInstances(peer.workspaceId)).find(item =>
          item.deviceId === profile.device.deviceId && item.instanceId === this.instanceId)
        const ownIssuedAt = (own?.advertisement as WorkspaceMemberBundle | undefined)?.advertisement.payload.issuedAt
        const peerIssuedAt = (peer.advertisement as WorkspaceMemberBundle | undefined)?.advertisement.payload.issuedAt
        if (!ownIssuedAt || !peerIssuedAt || ownIssuedAt < peerIssuedAt ||
          (ownIssuedAt === peerIssuedAt && profile.device.deviceId < peer.deviceId)) continue
        const key = this.peerKey(peer.workspaceId, peer.deviceId, peer.instanceId)
        if (signal.aborted || this.sessions.has(key) || this.connecting.has(key)) continue
        const attempts = this.failures.get(key) ?? 0
        const retryDelay = attempts > 0 ? Math.min(5_000 * 3 ** (attempts - 1), 5 * 60_000) : 0
        if (Date.now() - (this.failedAt.get(key) ?? 0) < retryDelay) continue
        void this.dialPeer(peer, signal)
      }
      await new Promise<void>(resolve => {
        this.retryTimer = setTimeout(resolve, 1_000)
        signal.addEventListener("abort", () => { clearTimeout(this.retryTimer); resolve() }, { once: true })
      })
    }
  }

  private async dialPeer(peer: WorkspacePeerRecord, signal: AbortSignal) {
    const key = this.peerKey(peer.workspaceId, peer.deviceId, peer.instanceId)
    const connectionId = this.connectionId("outgoing")
    let connection: SyncConnection | undefined
    if (this.connecting.has(key)) return
    this.connecting.add(key)
    try {
      if (!this.node || this.sessions.has(key)) return
      let credential = await this.store.getWorkspaceCredential(peer.workspaceId)
      if (!credential || credential.transportSecret !== peer.transportSecret) return
      const mode = this.reconnectPolicy.mode(this.node, key)
      this.trace("dial.started", {
        connectionId,
        peerId: peer.deviceId.slice(0, 8),
        workspaceId: peer.workspaceId.slice(0, 8),
        endpoint: peer.endpoint.slice(0, 8),
        mode,
      })
      connection = networkConnection(await networkIO(this.reconnectPolicy.dial(this.node, key, peer.endpoint)))
      this.trace("dial.connected", { connectionId, peerId: peer.deviceId.slice(0, 8), mode })
      const stream = await connection.openStream()
      this.trace("handshake.outgoing.started", { connectionId, peerId: peer.deviceId.slice(0, 8) })
      await stream.send(encodePairingFrame("mesh-handshake-request", credential.transportSecret,
        new TextEncoder().encode(JSON.stringify({ workspaceId: peer.workspaceId, peer: await this.ownBundle(credential),
          ownershipTransfers: ownershipTransfers(credential), successionPolicy: successionPolicy(credential),
          successionVotes: successionVotes(credential), successionClaims: successionClaims(credential), capabilities: meshCapabilities }))))
      await stream.closeSend()
      const response = JSON.parse(new TextDecoder().decode(decodePairingFrame(await stream.read(), "mesh-handshake-response", credential.transportSecret)))
      if (Array.isArray(response.ownershipTransfers)) {
        credential = await this.mergeOwnershipTransfers(credential, response.ownershipTransfers)
      }
      await this.mergeSuccessionState(credential, response.successionPolicy, response.successionVotes ?? [], response.successionClaims ?? [])
      credential = await this.store.getWorkspaceCredential(credential.workspaceId) ?? credential
      const verified = await verifyWorkspaceMemberBundle(response.peer, {
        workspaceId: credential.workspaceId, ownerPersonId: credential.ownerPersonId,
        ownerPublicKey: credential.ownerPublicKey, ownerCertificates: credential.ownerCertificates as any,
        ownerHistory: ownerAuthorities(credential).slice(1),
      })
      if (verified.advertisement.payload.deviceId !== peer.deviceId || signal.aborted) throw new Error("Unexpected mesh peer")
      const verifiedInstanceId = verified.advertisement.payload.instanceId ?? "legacy"
      this.trace("handshake.outgoing.verified", { connectionId, peerId: peer.deviceId.slice(0, 8) })
      if (Array.isArray(response.revocations)) await this.mergeRevocations(credential, response.revocations)
      await this.putVerifiedBundle(credential, response.peer)
      this.failures.delete(key)
      this.failedAt.delete(key)
      await this.installSession(peer.workspaceId, peer.deviceId, verifiedInstanceId,
        verified.advertisement.payload.issuedAt, "outgoing", connection,
        Array.isArray(response.capabilities) && response.capabilities.includes("heartbeat-v1"), connectionId)
      connection = undefined
    } catch (error) {
      this.reconnectPolicy.recordFailure(key, error)
      this.trace("dial.failed", {
        connectionId,
        peerId: peer.deviceId.slice(0, 8),
        reason: error instanceof Error ? error.message : String(error),
      }, "warn")
      this.reportProtocolFailure(`Dial ${peer.deviceId.slice(0, 6)}`, error)
      this.failures.set(key, Math.min((this.failures.get(key) ?? 0) + 1, 8))
      this.failedAt.set(key, Date.now())
      await connection?.close().catch(() => {})
      if (/runtime node is closed|node is closed/i.test(error instanceof Error ? error.message : String(error))) {
        const stale = this.node
        this.node = undefined
        await stale?.close("Mesh runtime closed").catch(() => {})
      }
      await this.notify()
    } finally {
      this.connecting.delete(key)
    }
  }

  private async installSession(workspaceId: string, deviceId: string, instanceId: string, remoteIssuedAt: string,
    direction: "incoming" | "outgoing", connection: SyncConnection, heartbeatSupported = false,
    connectionId = this.connectionId(direction)) {
    const key = this.peerKey(workspaceId, deviceId, instanceId)
    const profile = await this.options.getProfile()
    const preferred = profile.device.deviceId < deviceId ? "outgoing" : "incoming"
    const previous = this.sessions.get(key)
    if (previous && previous.remoteIssuedAt >= remoteIssuedAt && previous.direction === preferred && direction !== preferred) {
      this.trace("session.rejected", { connectionId, peerId: deviceId.slice(0, 8), direction, reason: "duplicate direction" })
      return void connection.close()
    }
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential) return void connection.close()
    const session = liveWorkspaceSetSync(connection, credential.transportSecret, workspaceSet(this.options.workspaceStore, [workspaceId]))
    this.sessions.set(key, { workspaceId, deviceId, instanceId, remoteIssuedAt, direction, connection, session })
    this.trace("session.started", {
      connectionId,
      peerId: deviceId.slice(0, 8),
      instanceId: instanceId.slice(0, 8),
      workspaceId: workspaceId.slice(0, 8),
      direction,
      heartbeat: heartbeatSupported,
      replaced: Boolean(previous),
    })
    this.lastDiagnostic = ""
    this.options.onDiagnostic?.("")
    await previous?.session.close()
    await this.notify()
    void session.publish().catch(error => {
      this.reconnectPolicy.recordFailure(key, error)
      this.trace("session.publish.failed", { connectionId, peerId: deviceId.slice(0, 8), reason: error instanceof Error ? error.message : String(error) }, "warn")
      this.reportProtocolFailure(`Publish ${deviceId.slice(0, 6)}`, error)
      void session.close()
    })
    const heartbeat = heartbeatSupported ? setInterval(() => {
      void session.heartbeat?.().catch(error => {
        this.reconnectPolicy.recordFailure(key, error)
        this.trace("session.heartbeat.failed", { connectionId, peerId: deviceId.slice(0, 8), reason: error instanceof Error ? error.message : String(error) }, "warn")
        this.reportProtocolFailure(`Heartbeat ${deviceId.slice(0, 6)}`, error)
        void session.close()
      })
    }, MESH_HEARTBEAT_INTERVAL_MS) : undefined
    void session.done.catch(error => {
      this.reconnectPolicy.recordFailure(key, error)
      this.trace("session.receive.failed", { connectionId, peerId: deviceId.slice(0, 8), reason: error instanceof Error ? error.message : String(error) }, "warn")
      this.reportProtocolFailure(`Receive ${deviceId.slice(0, 6)}`, error)
    }).finally(async () => {
      if (heartbeat) clearInterval(heartbeat)
      const wasCurrent = this.sessions.get(key)?.session === session
      if (wasCurrent) this.sessions.delete(key)
      this.trace("session.closed", { connectionId, peerId: deviceId.slice(0, 8), wasCurrent })
      await connection.close()
      await this.notify()
    })
  }

  private async publishAll() {
    await Promise.allSettled([...this.sessions.entries()].map(async ([key, entry]) => {
      try {
        await entry.session.publish()
      } catch (error) {
        this.reconnectPolicy.recordFailure(key, error)
        this.report(`Publish ${entry.deviceId.slice(0, 6)}`, error)
        if (this.sessions.get(key)?.session === entry.session) await entry.session.close()
      }
    }))
  }

  async views(workspaceId?: string): Promise<MeshPeerView[]> {
    return (await this.store.listPeers(workspaceId)).map(peer => {
      const payload = (peer.advertisement as WorkspaceMemberBundle | undefined)?.advertisement?.payload
      return {
        workspaceId: peer.workspaceId, personId: peer.personId, deviceId: peer.deviceId, role: peer.role,
        endpoint: peer.endpoint, lastSeen: peer.lastSeen, revokedAt: peer.revokedAt,
        online: [...this.sessions.values()].some(session => session.workspaceId === peer.workspaceId && session.deviceId === peer.deviceId),
        instances: Math.max(1, peer.instances?.length ?? 0),
        ...(payload?.deviceName ? { deviceName: payload.deviceName } : {}),
        ...(payload?.userAgent ? { userAgent: payload.userAgent } : {}),
      }
    })
  }

  async revokedWorkspaceIds(): Promise<string[]> {
    const profile = await this.options.getProfile()
    const result: string[] = []
    for (const credential of await this.store.listWorkspaceCredentials()) {
      if (revokedPersonIds(credential).has(profile.identity.personId)) result.push(credential.workspaceId)
    }
    return result
  }

  async successionViews(): Promise<MeshSuccessionView[]> {
    const result: MeshSuccessionView[] = []
    for (const credential of await this.store.listWorkspaceCredentials()) {
      const claims = successionClaims(credential).filter(claim => claim.payload.epoch === credential.epoch)
      const conflicted = new Set(claims.map(claim => claim.payload.toOwnerPersonId)).size > 1
      const policy = successionPolicy(credential) ?? claims[0]?.payload.policy
      if (!policy) continue
      const revoked = revokedPersonIds(credential)
      const eligible = policy.payload.eligibleEditorPersonIds.filter(id => !revoked.has(id))
      result.push({
        workspaceId: credential.workspaceId,
        successorPersonId: policy.payload.successorPersonId && !revoked.has(policy.payload.successorPersonId)
          ? policy.payload.successorPersonId : null,
        eligibleEditorPersonIds: eligible,
        votes: successionVotes(credential).map(vote => ({ voterPersonId: vote.signed.payload.voterPersonId,
          candidatePersonId: vote.signed.payload.candidatePersonId })),
        quorum: Math.floor(eligible.length / 2) + 1,
        conflicted,
      })
    }
    return result
  }

  private async notify() {
    const workspaces = [...new Set([...this.sessions.values()].map(entry => entry.workspaceId))]
    const peers = await this.views()
    const revoked = await this.revokedWorkspaceIds()
    const succession = await this.successionViews()
    this.options.onChange?.(workspaces, peers, revoked, succession)
  }
}
