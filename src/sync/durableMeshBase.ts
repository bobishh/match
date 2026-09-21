import { type LocalProfile} from "../domain/identity"
import type { DeviceCertificate } from "../domain/model"
import * as Automerge from "@automerge/automerge/slim"
import { MeshReconnectPolicy } from "@meta-uber/mesh-runtime"
import { isMeshNetworkFailure as isNetworkFailure } from "@meta-uber/mesh-transport"
import { AutomergeAntiEntropy } from "@meta-uber/mesh-replication/automerge"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { createMeshRuntime, type MeshRuntimeState } from "@meta-uber/mesh-runtime"
import type { BrowserGossipDriver} from "@meta-uber/mesh-replication/gossip"
import type { defaultProofStore } from "../domain/proofs"
import {
  MAX_SUCCESSION_EDITORS,
  type WorkspaceAuthority, type WorkspaceMemberBundle, type WorkspaceOwnershipTransfer, type WorkspaceRevocation,
  type WorkspaceSuccessionPolicy, type WorkspaceSuccessionVote, type WorkspaceSuccessionClaim,
  type WorkspaceBreakGlassClaim } from "./meshRecords"
import { acquireMeshInstanceLease } from "./meshInstanceLease"
import { meshTrace, type MeshTraceLevel } from "./meshTrace"
import { peerStore, type PeerStore, type WorkspaceMeshCredential} from "./peerStore"
import { startPersistentNode } from "./persistentNode"
import type { SyncAcceptor, SyncConnection, SyncNode, SyncTransport} from "./transport"
import { type LiveWorkspaceSync, type WorkspaceReplica, type WorkspaceSetStore } from "./workspaceSet"
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
  breakGlassClaims?: WorkspaceBreakGlassClaim[]
}

export type MeshExport = {
  version: 1
  peers: WorkspaceMemberBundle[]
  revocations: WorkspaceRevocation[]
  ownershipTransfers?: WorkspaceOwnershipTransfer[]
  successionPolicy?: WorkspaceSuccessionPolicy
  successionVotes?: WorkspaceSuccessionVote[]
  successionClaims?: WorkspaceSuccessionClaim[]
  breakGlassClaims?: WorkspaceBreakGlassClaim[]
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

export type SessionEntry = {
  workspaceId: string
  deviceId: string
  instanceId: string
  endpoint: string
  remoteIssuedAt: string
  remoteRouteSequence?: number
  direction: "incoming" | "outgoing"
  connection: SyncConnection
  session: LiveWorkspaceSync
  ownershipReceiptSupported?: boolean
  runtimeGeneration?: number
  evict: (cause: string) => Promise<void>
}

export type SessionDirection = SessionEntry["direction"]

export function shouldReplaceMeshSession(
  previous: Pick<SessionEntry, "remoteIssuedAt" | "remoteRouteSequence" | "direction"> | undefined,
  candidate: Pick<SessionEntry, "remoteIssuedAt" | "remoteRouteSequence" | "direction">,
  preferred: SessionDirection,
) {
  if (!previous) return true
  const runtime = createMeshRuntime()
  try {
    const key = { workspaceId: "comparison", deviceId: "comparison", instanceId: "comparison" }
    runtime.admitSession({ key, connectionId: "previous", ...previous }, previous.direction)
    return runtime.admitSession({ key, connectionId: "candidate", ...candidate }, preferred).decision === "accepted"
  } finally {
    runtime.free?.()
  }
}

export type DurableMeshOptions = {
  transport: SyncTransport
  workspaceStore: WorkspaceSetStore
  workspace: WorkspaceReplica
  getProfile: () => Promise<LocalProfile>
  store?: PeerStore
  onChange?: (workspaces: string[], peers: MeshPeerView[], revoked: string[], succession: MeshSuccessionView[]) => void
  onDiagnostic?: (message: string) => void
  onRetryChange?: (retryAtByWorkspace: Record<string, number>) => void
  networkOnline?: () => boolean
  getOwnedWorkspaceIds?: () => Promise<string[]>
}

export class MeshDialCancelled extends Error {
  constructor() { super("Mesh dial cancelled"); this.name = "AbortError" }
}

export class MeshNodeRestart extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = "MeshNodeRestart"
  }
}

const MESH_INSTANCE_KEY = "match.mesh.instance.v1"

export function isMeshDialNetworkFailure(error: unknown): boolean {
  if (isNetworkFailure(error)) return true
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(isMeshDialNetworkFailure)
  return /all promises were rejected|no addressing information available|pkarr.*404/i.test(
    error instanceof Error ? error.message : String(error),
  )
}

export function uniqueCertificates(profile: LocalProfile, certificates: Awaited<ReturnType<typeof defaultProofStore.listCertificates>>) {
  const all = [profile.certificate, ...certificates]
    .filter(cert => cert?.payload?.personId === profile.identity.personId)
  const seen = new Set<string>()
  return all.filter(cert => {
    const key = `${cert.payload.deviceId}:${cert.signature}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function nonEmptyText(value: unknown): value is string { return typeof value === "string" && value.length > 0 }
function boundedArray(value: unknown, maximum: number): boolean { return Array.isArray(value) && value.length <= maximum }
function optionalArray(value: unknown, maximum = Number.MAX_SAFE_INTEGER): boolean {
  return value === undefined || boundedArray(value, maximum)
}

export function isEnvelope(value: unknown): value is MeshWorkspaceEnvelope {
  const item = value as Partial<MeshWorkspaceEnvelope>
  const required = item.version === 1 && nonEmptyText(item.workspaceId) && nonEmptyText(item.ownerPersonId) &&
    nonEmptyText(item.ownerPublicKey) && nonEmptyText(item.transportSecret) && Number.isSafeInteger(item.epoch) && item.epoch! >= 1
  const collections = boundedArray(item.ownerCertificates, 32) && boundedArray(item.peers, 512)
  const optional = optionalArray(item.ownerHistory) && optionalArray(item.ownershipTransfers) &&
    optionalArray(item.breakGlassClaims, 32) && optionalArray(item.successionVotes, MAX_SUCCESSION_EDITORS) &&
    optionalArray(item.successionClaims, 32)
  return required && collections && optional
}

export type MeshCatalog = { revocations?: WorkspaceRevocation[]; ownershipTransfers?: WorkspaceOwnershipTransfer[]
  successionPolicy?: WorkspaceSuccessionPolicy; successionVotes?: WorkspaceSuccessionVote[]; successionClaims?: WorkspaceSuccessionClaim[]
  breakGlassClaims?: WorkspaceBreakGlassClaim[] }
export function meshCapabilities(): string[] { return meshRustRuntime().state.meshCapabilities() }

export function assertRequiredMeshCapabilities(capabilities: unknown): asserts capabilities is string[] {
  meshRustRuntime().state.validateMeshCapabilities(capabilities)
}

export function meshCatalog(credential: WorkspaceMeshCredential): MeshCatalog {
  return (credential.catalog as MeshCatalog | undefined) ?? {}
}

export function revocations(credential: WorkspaceMeshCredential): WorkspaceRevocation[] {
  const value = meshCatalog(credential)
  return Array.isArray(value?.revocations) ? value.revocations : []
}

export function ownershipTransfers(credential: WorkspaceMeshCredential): WorkspaceOwnershipTransfer[] {
  const value = meshCatalog(credential)
  return Array.isArray(value.ownershipTransfers) ? value.ownershipTransfers : []
}

export function successionPolicy(credential: WorkspaceMeshCredential) { return meshCatalog(credential).successionPolicy }
export function successionVotes(credential: WorkspaceMeshCredential) { return meshCatalog(credential).successionVotes ?? [] }
export function successionClaims(credential: WorkspaceMeshCredential) { return meshCatalog(credential).successionClaims ?? [] }
export function breakGlassClaims(credential: WorkspaceMeshCredential) {
  return (meshCatalog(credential).breakGlassClaims ?? []).filter(record => record?.payload?.kind === "workspace-break-glass")
}

export function hasConflictingBreakGlassClaims(records: WorkspaceBreakGlassClaim[]) {
  return meshRustRuntime().state.hasConflictingBreakGlassClaims(records)
}

export function ownerAuthorities(credential: WorkspaceMeshCredential): WorkspaceAuthority[] {
  return [{ personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey,
    certificates: credential.ownerCertificates as DeviceCertificate[] }, ...((credential.ownerHistory ?? []) as WorkspaceAuthority[])]
}

export function revokedPersonIds(credential: WorkspaceMeshCredential) {
  return new Set(revocations(credential).map(record => record.payload.personId))
}

export abstract class DurableMeshBase {
  static readonly ROUTE_LEASE_MS = 2 * 60_000
  static readonly ROUTE_RENEW_MS = 60_000
  protected readonly store: PeerStore
  protected task: Promise<void> | undefined
  protected abortController: AbortController | undefined
  protected node: SyncNode | undefined
  protected acceptor: SyncAcceptor | undefined
  protected sessions = new Map<string, SessionEntry>()
  protected syncEngines = new Map<string, AutomergeAntiEntropy>()
  protected gossipDrivers = new Map<string, BrowserGossipDriver>()
  protected gossipRefreshes = new Map<string, Promise<void>>()
  protected gossipNeighborCounts = new Map<string, number>()
  protected connecting = new Set<string>()
  protected pendingIncomingConnections = 0
  protected runSequence = 0
  protected currentRunId = 0
  protected connectionSequence = 0
  protected stopped = true
  protected stopWatch: (() => void) | undefined
  protected retryTimer: ReturnType<typeof setTimeout> | undefined
  protected readonly reconnectPolicy = new MeshReconnectPolicy()
  protected runtimeState: MeshRuntimeState | undefined
  protected readonly runtimeId = crypto.randomUUID()
  protected instanceId = ""
  protected releaseInstance: (() => Promise<void>) | undefined
  protected externallyPaused = false
  protected disposed = false
  protected adoptedNode: SyncNode | undefined
  protected lastDiagnostic = ""

  constructor(protected readonly options: DurableMeshOptions) {
    this.store = options.store ?? peerStore
    this.trace("instance.created")
  }

  protected runtime() {
    this.runtimeState ??= createMeshRuntime()
    if (!this.runtimeState.running) this.runtimeState.start()
    return this.runtimeState
  }

  protected runtimeSessionKey(workspaceId: string, deviceId: string, instanceId: string) {
    return { workspaceId, deviceId, instanceId }
  }

  protected trace(event: string, detail: Record<string, unknown> = {}, level: MeshTraceLevel = "info") {
    meshTrace(event, { runtimeId: this.runtimeId.slice(0, 8), runId: this.currentRunId, ...detail }, level)
  }

  protected connectionId(direction: "incoming" | "outgoing") {
    this.connectionSequence += 1
    return `${direction === "incoming" ? "in" : "out"}-${this.connectionSequence}`
  }

  protected peerKey(workspaceId: string, deviceId: string, instanceId = "legacy") {
    return `${workspaceId}:${deviceId}:${instanceId}`
  }

  protected routeFailures(key: string): number {
    return this.runtimeState?.reconnectState(key)?.failures ?? 0
  }

  protected clearRouteReconnect(key: string): void {
    this.runtimeState?.clearReconnect(key)
  }

  protected clearRouteReconnects(prefix: string): void {
    this.runtimeState?.clearReconnectsWithPrefix(prefix)
  }

  protected deviceKey(workspaceId: string, deviceId: string) {
    return `${workspaceId}:${deviceId}`
  }

  protected syncEngine(workspaceId: string, deviceId: string, localDeviceId: string, instanceId: string) {
    const key = this.peerKey(workspaceId, deviceId, instanceId)
    let engine = this.syncEngines.get(key)
    if (!engine) {
      engine = new AutomergeAntiEntropy(localDeviceId, Automerge, {
        proof: async () => this.options.workspaceStore.readAuthorization?.(
          await this.options.workspaceStore.read(workspaceId),
        ),
      })
      this.syncEngines.set(key, engine)
    }
    return engine
  }
  protected async acquireInstance() {
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

  protected async peerInstances(workspaceId?: string) {
    const list = (this.store as PeerStore & { listPeerInstances?: PeerStore["listPeerInstances"] }).listPeerInstances
    if (list) return list.call(this.store, workspaceId)
    const listPeers = (this.store as PeerStore & { listPeers?: PeerStore["listPeers"] }).listPeers
    return listPeers ? listPeers.call(this.store, workspaceId) : []
  }

  protected report(stage: string, error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    this.lastDiagnostic = `${stage}: ${detail || "unknown transport error"}`
    this.trace("diagnostic", { stage, reason: detail || "unknown transport error" }, "warn")
    this.options.onDiagnostic?.(this.lastDiagnostic)
    void this.notify()
  }

  protected reportProtocolFailure(stage: string, error: unknown) {
    if (isMeshDialNetworkFailure(error)) {
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
    this.runtimeState?.free?.()
    this.runtimeState = undefined
  }

  protected abstract start(): Promise<void>
  protected abstract stop(releaseInstance?: boolean): Promise<void>
  protected abstract notify(): Promise<void>
  protected abstract publishAll(): Promise<void>
}
