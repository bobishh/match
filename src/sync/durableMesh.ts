import type { LocalProfile } from "../domain/identity"
import type { WorkspaceGrant } from "../domain/model"
import { defaultProofStore } from "../domain/proofs"
import { createPairingSecret, decodePairingFrame, encodePairingFrame, inspectPairingFrame } from "./protocol"
import { createPeerAdvertisement, createWorkspaceRevocation, verifyDeviceChain, verifyWorkspaceMemberBundle,
  verifyWorkspaceRevocation, verifyWorkspaceGrant, type WorkspaceMemberBundle, type WorkspaceRevocation } from "./meshRecords"
import { MeshLeader } from "./meshLeader"
import { peerStore, type PeerStore, type WorkspaceMeshCredential, type WorkspacePeerRecord } from "./peerStore"
import type { SyncAcceptor, SyncConnection, SyncNode, SyncTransport } from "./transport"
import { isNetworkFailure, liveWorkspaceSetSync, networkConnection, networkIO, workspaceSet, type WorkspaceSetStore } from "./workspaceSet"
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
}

export type MeshExport = { version: 1; peers: WorkspaceMemberBundle[]; revocations: WorkspaceRevocation[] }

export type MeshPeerView = {
  workspaceId: string
  personId: string
  deviceId: string
  role: "owner" | "editor" | "visitor"
  endpoint: string
  online: boolean
  lastSeen: string
  revokedAt?: string | null
}

type SessionEntry = {
  workspaceId: string
  deviceId: string
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
  onChange?: (workspaces: string[], peers: MeshPeerView[]) => void
}

type MeshTabMessage =
  | { type: "pause"; requestId: string; senderId: string }
  | { type: "paused"; requestId: string; senderId: string; wasLeader: boolean }
  | { type: "resume"; senderId: string }
  | { type: "state-request"; senderId: string }
  | { type: "state"; senderId: string; workspaces: string[]; peers: MeshPeerView[] }

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
    Array.isArray(item.ownerCertificates) && item.ownerCertificates.length <= 32 && Array.isArray(item.peers) && item.peers.length <= 512)
}

function revocations(credential: WorkspaceMeshCredential): WorkspaceRevocation[] {
  const value = credential.catalog as { revocations?: WorkspaceRevocation[] } | undefined
  return Array.isArray(value?.revocations) ? value.revocations : []
}

function revokedPersonIds(credential: WorkspaceMeshCredential) {
  return new Set(revocations(credential).map(record => record.payload.personId))
}

export async function startPersistentNode(transport: SyncTransport, store: PeerStore = peerStore) {
  return transport.start(await store.getOrCreateNodeSecret())
}

export class DurableMesh {
  private readonly store: PeerStore
  private leader: MeshLeader | undefined
  private task: Promise<void> | undefined
  private node: SyncNode | undefined
  private acceptor: SyncAcceptor | undefined
  private sessions = new Map<string, SessionEntry>()
  private connecting = new Set<string>()
  private stopped = true
  private stopWatch: (() => void) | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private failures = new Map<string, number>()
  private failedAt = new Map<string, number>()
  private readonly tabId = crypto.randomUUID()
  private readonly tabChannel: BroadcastChannel | undefined
  private externallyPaused = false
  private disposed = false
  private restartRequested = false
  private takeoverNode = false
  private pauseWaiters = new Map<string, (wasLeader: boolean) => void>()

  constructor(private readonly options: DurableMeshOptions) {
    this.store = options.store ?? peerStore
    if (typeof BroadcastChannel !== "undefined") {
      this.tabChannel = new BroadcastChannel("match:durable-mesh")
      this.tabChannel.onmessage = event => { void this.handleTabMessage(event.data as MeshTabMessage) }
    }
  }

  private async handleTabMessage(message: MeshTabMessage) {
    if (!message || message.senderId === this.tabId || this.disposed) return
    if (message.type === "pause") {
      const wasLeader = Boolean(this.leader?.isLeader)
      this.externallyPaused = true
      await this.stop()
      this.tabChannel?.postMessage({ type: "paused", requestId: message.requestId, senderId: this.tabId, wasLeader } satisfies MeshTabMessage)
    } else if (message.type === "paused") {
      this.pauseWaiters.get(message.requestId)?.(message.wasLeader)
    } else if (message.type === "resume") {
      this.externallyPaused = false
      await this.start()
    } else if (message.type === "state-request" && this.leader?.isLeader) {
      await this.notify()
    } else if (message.type === "state" && !this.leader?.isLeader) {
      this.options.onChange?.(message.workspaces, message.peers)
    }
  }

  async pauseAll(): Promise<void> {
    this.externallyPaused = true
    const wasLeader = Boolean(this.leader?.isLeader)
    const requestId = crypto.randomUUID()
    let releaseWait: ((wasLeader: boolean) => void) | undefined
    const leaderPaused = this.leader && !wasLeader && this.tabChannel ? new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 1_000)
      releaseWait = remoteWasLeader => {
        if (!remoteWasLeader) return
        clearTimeout(timer)
        resolve()
      }
      this.pauseWaiters.set(requestId, releaseWait)
    }) : Promise.resolve()
    this.tabChannel?.postMessage({ type: "pause", requestId, senderId: this.tabId } satisfies MeshTabMessage)
    await this.stop()
    await leaderPaused
    this.pauseWaiters.delete(requestId)
  }

  async resumeAll(): Promise<void> {
    if (this.disposed) return
    this.externallyPaused = false
    this.tabChannel?.postMessage({ type: "resume", senderId: this.tabId } satisfies MeshTabMessage)
    await this.start()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
    this.tabChannel?.close()
    this.pauseWaiters.clear()
  }

  async ensureOwnerWorkspaces(workspaceIds: string[], endpoint: string, profile: LocalProfile): Promise<void> {
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
      }
      const bundle = await createPeerAdvertisement(profile, workspaceId, endpoint, { certificates })
      await this.putVerifiedBundle(credential, bundle)
    }
    await this.notify()
  }

  async createGuestAdvertisements(workspaceIds: string[], endpoint: string, profile: LocalProfile): Promise<WorkspaceMemberBundle[]> {
    const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
    return Promise.all(workspaceIds.map(workspaceId => createPeerAdvertisement(profile, workspaceId, endpoint, { certificates })))
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
        peers: (await this.store.listPeers(workspaceId)).filter(peer => !peer.revokedAt && peer.advertisement)
          .map(peer => peer.advertisement as WorkspaceMemberBundle),
        revocations: revocations(credential),
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
      if (!localGrant || localGrant.payload.personId !== profile.identity.personId) throw new Error("Missing local workspace grant")
      await verifyDeviceChain({ personId: envelope.ownerPersonId, publicKey: envelope.ownerPublicKey,
        deviceId: (envelope.ownerCertificates[0] as any)?.payload?.deviceId, certificates: envelope.ownerCertificates as any })
      await verifyWorkspaceGrant(localGrant, { workspaceId, personId: profile.identity.personId,
        ownerPersonId: envelope.ownerPersonId, ownerPublicKey: envelope.ownerPublicKey, ownerCertificates: envelope.ownerCertificates as any })
      const credential: WorkspaceMeshCredential = {
        version: 1,
        workspaceId,
        ownerPersonId: envelope.ownerPersonId,
        ownerPublicKey: envelope.ownerPublicKey,
        ownerCertificates: envelope.ownerCertificates,
        transportSecret: envelope.transportSecret,
        epoch: envelope.epoch,
        updatedAt: new Date().toISOString(),
        localGrant,
        catalog: { revocations: [] },
      }
      await this.store.putWorkspaceCredential(credential)
      if (envelope.revocations) await this.mergeRevocations(credential, envelope.revocations)
      for (const bundle of envelope.peers) await this.putVerifiedBundle(credential, bundle)
    }
    await this.notify()
  }

  async exportWorkspace(workspaceId: string): Promise<MeshExport> {
    const peers = (await this.store.listPeers(workspaceId)).filter(peer => !peer.revokedAt && peer.advertisement)
      .map(peer => peer.advertisement as WorkspaceMemberBundle)
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    return { version: 1, peers, revocations: credential ? revocations(credential) : [] }
  }

  async mergeWorkspace(workspaceId: string, raw: unknown): Promise<void> {
    const value = raw as MeshExport
    if (!value || value.version !== 1 || !Array.isArray(value.peers) || value.peers.length > 512 ||
      !Array.isArray(value.revocations) || value.revocations.length > 512 ||
      new TextEncoder().encode(JSON.stringify(value)).byteLength > 8 * 1024 * 1024) throw new Error("Invalid mesh catalog")
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential) return
    await this.mergeRevocations(credential, value.revocations)
    for (const bundle of value.peers) await this.putVerifiedBundle(credential, bundle)
    await this.notify()
  }

  private async putVerifiedBundle(credential: WorkspaceMeshCredential, raw: WorkspaceMemberBundle) {
    const verified = await verifyWorkspaceMemberBundle(raw, {
      workspaceId: credential.workspaceId,
      ownerPersonId: credential.ownerPersonId,
      ownerPublicKey: credential.ownerPublicKey,
      ownerCertificates: credential.ownerCertificates as any,
    })
    const p = verified.advertisement.payload
    if (revokedPersonIds(credential).has(p.personId)) throw new Error("Workspace member is revoked")
    const record: WorkspacePeerRecord = {
      workspaceId: p.workspaceId,
      personId: p.personId,
      deviceId: p.deviceId,
      endpoint: p.endpoint,
      transportSecret: credential.transportSecret,
      role: verified.role,
      lastSeen: p.issuedAt,
      advertisement: raw,
    }
    await this.store.upsertPeer(record)
  }

  private async mergeRevocations(credential: WorkspaceMeshCredential, raw: unknown[]) {
    const current = new Map(revocations(credential).map(record => [record.payload.personId, record]))
    for (const value of raw) {
      const record = await verifyWorkspaceRevocation(value, credential.workspaceId, credential.ownerPersonId,
        credential.ownerPublicKey, credential.ownerCertificates as any)
      const previous = current.get(record.payload.personId)
      if (!previous || record.payload.epoch > previous.payload.epoch) current.set(record.payload.personId, record)
    }
    const merged = [...current.values()].sort((a, b) => a.payload.personId.localeCompare(b.payload.personId))
    const epoch = Math.max(credential.epoch, ...merged.map(record => record.payload.epoch))
    await this.store.putWorkspaceCredential({ ...credential, epoch, updatedAt: new Date().toISOString(), catalog: { revocations: merged } })
    const peers = await this.store.listPeers(credential.workspaceId)
    for (const peer of peers) {
      const record = current.get(peer.personId)
      if (!record || peer.revokedAt) continue
      await this.store.upsertPeer({ ...peer, lastSeen: new Date().toISOString(), revokedAt: record.payload.revokedAt })
      const session = this.sessions.get(`${credential.workspaceId}:${peer.deviceId}`)
      if (session) {
        this.sessions.delete(`${credential.workspaceId}:${peer.deviceId}`)
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
    await this.mergeRevocations(credential, [record])
    // Gossip tombstone before severing the revoked session. Other members converge on the owner's epoch.
    await this.publishAll()
    await this.notify()
  }

  async start(): Promise<void> {
    if (!this.stopped || this.externallyPaused || this.disposed) return
    if ((await this.store.listWorkspaceCredentials()).length === 0) return
    this.stopped = false
    this.leader = new MeshLeader({ name: "match:mesh-leader" })
    await this.leader.start(signal => {
      this.task = this.run(signal)
      return this.task
    })
    if (!this.leader.isLeader) {
      this.takeoverNode = true
      this.tabChannel?.postMessage({ type: "state-request", senderId: this.tabId } satisfies MeshTabMessage)
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    await this.leader?.stop()
    this.leader = undefined
    await this.shutdown()
    await this.task?.catch(() => {})
    this.task = undefined
  }

  private async shutdown() {
    this.stopWatch?.()
    this.stopWatch = undefined
    await this.dropSessions()
    await this.acceptor?.close().catch(() => {})
    this.acceptor = undefined
    await this.node?.close("Mesh stopped").catch(() => {})
    this.node = undefined
    await this.notify()
  }

  private async run(signal: AbortSignal) {
    while (!signal.aborted) {
      const offline = () => { void this.dropSessions() }
      const abort = () => { void this.shutdown() }
      try {
        const credentials = await this.store.listWorkspaceCredentials()
        if (signal.aborted || credentials.length === 0) return
        const profile = await this.options.getProfile()
        // A tab taking over from another tab uses a distinct transport endpoint. Some
        // relays retain the closed tab's connection for the stable node ID briefly.
        // The endpoint remains authenticated by the same signed device advertisement.
        const node = this.takeoverNode
          ? await this.options.transport.start()
          : await startPersistentNode(this.options.transport, this.store)
        if (signal.aborted) return void node.close("Mesh cancelled")
        this.node = node
        const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
        for (const credential of credentials) {
          const bundle = await createPeerAdvertisement(profile, credential.workspaceId, node.endpointId, {
            certificates,
            grant: credential.localGrant as WorkspaceGrant | undefined,
            ownerPublicKey: credential.ownerPublicKey,
            ownerCertificates: credential.ownerCertificates as any,
          })
          await this.putVerifiedBundle(credential, bundle)
        }
        this.acceptor = await node.accept()
        signal.addEventListener("abort", abort, { once: true })
        if (typeof window !== "undefined") window.addEventListener("offline", offline)
        this.stopWatch = this.options.workspace.subscribe?.(() => { void this.publishAll() })
        void this.acceptLoop(signal)
        await this.dialLoop(signal)
      } catch (error) {
        if (!signal.aborted) console.warn("Durable mesh restarting", error)
      } finally {
        signal.removeEventListener("abort", abort)
        if (typeof window !== "undefined") window.removeEventListener("offline", offline)
        await this.shutdown()
      }
      this.restartRequested = false
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
    while (!signal.aborted && this.acceptor) {
      try {
        const raw = await this.acceptor.accept()
        if (!raw) return
        void this.acceptConnection(networkConnection(raw), signal)
      } catch (error) {
        if (!signal.aborted && !isNetworkFailure(error)) console.warn("Mesh accept failed", error)
      }
    }
  }

  private async acceptConnection(connection: SyncConnection, signal: AbortSignal) {
    try {
      const stream = await connection.acceptStream()
      const frame = await stream.read()
      const header = inspectPairingFrame(frame)
      if (header.type !== "mesh-handshake-request") throw new Error("Unsupported mesh handshake")
      const credentials = await this.store.listWorkspaceCredentials()
      const credential = credentials.find(item => item.transportSecret === header.secret)
      if (!credential) throw new Error("Unknown mesh credential")
      const request = JSON.parse(new TextDecoder().decode(decodePairingFrame(frame, "mesh-handshake-request", credential.transportSecret)))
      if (request.workspaceId !== credential.workspaceId) throw new Error("Wrong mesh workspace")
      const remote = await verifyWorkspaceMemberBundle(request.peer, {
        workspaceId: credential.workspaceId, ownerPersonId: credential.ownerPersonId,
        ownerPublicKey: credential.ownerPublicKey, ownerCertificates: credential.ownerCertificates as any,
      })
      if (revokedPersonIds(credential).has(remote.advertisement.payload.personId)) throw new Error("Workspace member is revoked")
      await this.putVerifiedBundle(credential, request.peer)
      const own = await this.ownBundle(credential)
      await stream.send(encodePairingFrame("mesh-handshake-response", credential.transportSecret,
        new TextEncoder().encode(JSON.stringify({ workspaceId: credential.workspaceId, peer: own }))))
      await stream.closeSend()
      if (signal.aborted) return
      await this.installSession(credential.workspaceId, remote.advertisement.payload.deviceId,
        remote.advertisement.payload.issuedAt, "incoming", connection)
    } catch {
      await connection.close()
    }
  }

  private async ownBundle(credential: WorkspaceMeshCredential) {
    const profile = await this.options.getProfile()
    const own = await this.store.getPeer(credential.workspaceId, profile.device.deviceId)
    if (!own?.advertisement) throw new Error("Missing local peer advertisement")
    return own.advertisement as WorkspaceMemberBundle
  }

  private async dialLoop(signal: AbortSignal) {
    while (!signal.aborted) {
      if (this.restartRequested || !this.node) throw new Error("Mesh node restart requested")
      const profile = await this.options.getProfile()
      const peers = (await this.store.listPeers()).filter(peer => !peer.revokedAt && peer.deviceId !== profile.device.deviceId)
      for (const peer of peers) {
        const key = `${peer.workspaceId}:${peer.deviceId}`
        if (signal.aborted || this.sessions.has(key) || this.connecting.has(key)) continue
        const attempts = this.failures.get(key) ?? 0
        if (attempts > 0 && Date.now() - (this.failedAt.get(key) ?? 0) < Math.min(1000 * 2 ** attempts, 15_000)) continue
        void this.dialPeer(peer, signal)
      }
      await new Promise<void>(resolve => {
        this.retryTimer = setTimeout(resolve, 1_000)
        signal.addEventListener("abort", () => { clearTimeout(this.retryTimer); resolve() }, { once: true })
      })
    }
  }

  private async dialPeer(peer: WorkspacePeerRecord, signal: AbortSignal) {
    const key = `${peer.workspaceId}:${peer.deviceId}`
    let connection: SyncConnection | undefined
    if (this.connecting.has(key)) return
    this.connecting.add(key)
    try {
      if (!this.node || this.sessions.has(key)) return
      const credential = await this.store.getWorkspaceCredential(peer.workspaceId)
      if (!credential || credential.transportSecret !== peer.transportSecret) return
      connection = networkConnection(await networkIO(this.node.dial(peer.endpoint)))
      const stream = await connection.openStream()
      await stream.send(encodePairingFrame("mesh-handshake-request", credential.transportSecret,
        new TextEncoder().encode(JSON.stringify({ workspaceId: peer.workspaceId, peer: await this.ownBundle(credential) }))))
      await stream.closeSend()
      const response = JSON.parse(new TextDecoder().decode(decodePairingFrame(await stream.read(), "mesh-handshake-response", credential.transportSecret)))
      const verified = await verifyWorkspaceMemberBundle(response.peer, {
        workspaceId: credential.workspaceId, ownerPersonId: credential.ownerPersonId,
        ownerPublicKey: credential.ownerPublicKey, ownerCertificates: credential.ownerCertificates as any,
      })
      if (verified.advertisement.payload.deviceId !== peer.deviceId || signal.aborted) throw new Error("Unexpected mesh peer")
      await this.putVerifiedBundle(credential, response.peer)
      this.failures.delete(key)
      this.failedAt.delete(key)
      await this.installSession(peer.workspaceId, peer.deviceId, verified.advertisement.payload.issuedAt, "outgoing", connection)
      connection = undefined
    } catch {
      this.failures.set(key, Math.min((this.failures.get(key) ?? 0) + 1, 5))
      this.failedAt.set(key, Date.now())
      await connection?.close().catch(() => {})
    } finally {
      this.connecting.delete(key)
    }
  }

  private async installSession(workspaceId: string, deviceId: string, remoteIssuedAt: string,
    direction: "incoming" | "outgoing", connection: SyncConnection) {
    const key = `${workspaceId}:${deviceId}`
    const profile = await this.options.getProfile()
    const preferred = profile.device.deviceId < deviceId ? "outgoing" : "incoming"
    const previous = this.sessions.get(key)
    if (previous && previous.remoteIssuedAt >= remoteIssuedAt && previous.direction === preferred && direction !== preferred) {
      return void connection.close()
    }
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential) return void connection.close()
    const session = liveWorkspaceSetSync(connection, credential.transportSecret, workspaceSet(this.options.workspaceStore, [workspaceId]))
    this.sessions.set(key, { workspaceId, deviceId, remoteIssuedAt, direction, connection, session })
    await previous?.session.close()
    await this.notify()
    void session.publish()
    void session.done.catch(() => {}).finally(async () => {
      const wasCurrent = this.sessions.get(key)?.session === session
      if (wasCurrent) this.sessions.delete(key)
      await connection.close()
      await this.notify()
      if (wasCurrent && !this.stopped && !this.restartRequested) {
        // Iroh may retain a dead connection for the same stable endpoint. Reopen the
        // node to clear its connection pool before the next authenticated dial.
        this.restartRequested = true
        const node = this.node
        this.node = undefined
        await node?.close("Mesh peer disconnected").catch(() => {})
      }
    })
  }

  private async publishAll() {
    await Promise.allSettled([...this.sessions.values()].map(entry => entry.session.publish()))
  }

  async views(workspaceId?: string): Promise<MeshPeerView[]> {
    const online = new Set([...this.sessions.keys()])
    return (await this.store.listPeers(workspaceId)).map(peer => ({
      workspaceId: peer.workspaceId, personId: peer.personId, deviceId: peer.deviceId, role: peer.role,
      endpoint: peer.endpoint, lastSeen: peer.lastSeen, revokedAt: peer.revokedAt,
      online: online.has(`${peer.workspaceId}:${peer.deviceId}`),
    }))
  }

  async revokedWorkspaceIds(): Promise<string[]> {
    const profile = await this.options.getProfile()
    const result: string[] = []
    for (const credential of await this.store.listWorkspaceCredentials()) {
      if (revokedPersonIds(credential).has(profile.identity.personId)) result.push(credential.workspaceId)
    }
    return result
  }

  private async notify() {
    const workspaces = [...new Set([...this.sessions.values()].map(entry => entry.workspaceId))]
    const peers = await this.views()
    this.options.onChange?.(workspaces, peers)
    if (this.leader?.isLeader) {
      this.tabChannel?.postMessage({ type: "state", senderId: this.tabId, workspaces, peers } satisfies MeshTabMessage)
    }
  }
}
