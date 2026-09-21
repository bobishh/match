import { type LocalProfile} from "../domain/identity"
import type { DeviceCertificate } from "../domain/model"
import { isMeshNetworkFailure as isNetworkFailure, meshNetworkConnection as networkConnection, meshNetworkIO as networkIO } from "@meta-uber/mesh-transport"
import { BrowserMeshDialScheduler } from "@meta-uber/mesh-runtime"
import { adaptVerifiedWorkspaceAdvertisement, connectToDevice, type DeviceRoute } from "@meta-uber/mesh-replication/protocol"
import { defaultProofStore } from "../domain/proofs"
import {
  verifyWorkspaceMemberBundle, type VerifiedWorkspaceMember, type WorkspaceMemberBundle, type WorkspaceOwnershipTransfer,
  type WorkspaceSuccessionPolicy, type WorkspaceSuccessionVote, type WorkspaceSuccessionClaim,
  type WorkspaceBreakGlassClaim } from "./meshRecords"
import { type WorkspaceMeshCredential, type WorkspacePeerRecord } from "./peerStore"
import type { SyncConnection} from "./transport"
import { DurableMeshBase, MeshDialCancelled, MeshNodeRestart, uniqueCertificates, ownershipTransfers, successionPolicy, successionVotes, successionClaims, breakGlassClaims, ownerAuthorities } from "./durableMeshBase"
import { DurableMeshHandshake } from "./durableMeshHandshake"

export abstract class DurableMeshDial extends DurableMeshHandshake {
  private readonly dialScheduler = new BrowserMeshDialScheduler<WorkspacePeerRecord>({
    peers: () => this.peerInstances(),
    hasSession: (workspaceId, deviceId) => this.hasDeviceSession(workspaceId, deviceId),
    deviceKey: (workspaceId, deviceId) => this.deviceKey(workspaceId, deviceId),
    peerKey: (workspaceId, deviceId, instanceId) => this.peerKey(workspaceId, deviceId, instanceId),
    routeFailures: key => this.routeFailures(key),
    retryAt: (key, fallback) => this.runtimeState?.reconnectState(key)?.retryAtMs ?? fallback,
    routeAttemptActive: key => this.runtime().routeAttemptActive(key),
    dial: (routes, signal) => this.dialDevice(routes, signal),
    onRetries: retries => this.options.onRetryChange?.(retries),
  })

  protected hasDeviceSession(workspaceId: string, deviceId: string) {
    return this.runtimeState?.connectedDevices(workspaceId).includes(deviceId) ?? false
  }

  protected async dialLoop(signal: AbortSignal) {
    let nextRouteRefreshAt = Date.now() + DurableMeshBase.ROUTE_RENEW_MS
    while (!signal.aborted) {
      if (!this.node) throw new MeshNodeRestart("runtime node unavailable")
      if (await this.pauseDialingWhenOffline(signal)) continue
      const profile = await this.options.getProfile()
      nextRouteRefreshAt = await this.refreshRoutesWhenDue(profile, nextRouteRefreshAt)
      await this.scheduleDials(profile.device.deviceId, signal)
      await this.waitForDialTick(signal)
    }
  }

  protected async pauseDialingWhenOffline(signal: AbortSignal): Promise<boolean> {
    if (this.options.networkOnline?.() !== false) return false
    this.options.onRetryChange?.({})
    await this.waitForDialTick(signal)
    return true
  }

  protected async refreshRoutesWhenDue(profile: LocalProfile, nextAt: number): Promise<number> {
    if (Date.now() < nextAt) return nextAt
    const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
    for (const credential of await this.store.listWorkspaceCredentials()) {
      await this.refreshOwnBundle(credential, profile, this.node!.endpointId, certificates)
    }
    await this.publishAll()
    return Date.now() + DurableMeshBase.ROUTE_RENEW_MS
  }

  protected async scheduleDials(localDeviceId: string, signal: AbortSignal): Promise<void> {
    await this.dialScheduler.schedule(localDeviceId, signal)
  }

  protected waitForDialTick(signal: AbortSignal) {
    return this.lifecycle!.wait(1_000, signal)
  }

  protected async dialDevice(peers: WorkspacePeerRecord[], signal: AbortSignal) {
    const peer = peers[0]!
    const key = this.deviceKey(peer.workspaceId, peer.deviceId)
    if (this.runtime().routeAttemptActive(key)) return
    const attempt = this.runtime().beginRouteAttempt(key, Date.now())
    try {
      if (!this.node || this.hasDeviceSession(peer.workspaceId, peer.deviceId)) return
      const routeEntries = await Promise.all(peers.map(async candidate => ({
        peer: candidate,
        route: await adaptVerifiedWorkspaceAdvertisement(
          (candidate.advertisement as WorkspaceMemberBundle).advertisement,
        ),
      })))
      const connected = await connectToDevice({
        targetDeviceId: peer.deviceId,
        routes: routeEntries.map(value => value.route),
        fallbackDelayMs: 250,
        routeHealth: route => -this.routeFailures(this.peerKey(route.scopeId, route.deviceId, route.instanceId)),
        trace: (event, fields) => this.trace(event, { ...fields }),
        signal,
        connect: async (route, routeSignal) => {
          const entry = routeEntries.find(value => value.route.instanceId === route.instanceId)!
          return this.connectPeer(entry.peer, route, signal, routeSignal)
        },
      })
      const value = connected.value
      const installed = await this.installSession(peer.workspaceId, peer.deviceId, value.instanceId,
        value.issuedAt, value.routeSequence, "outgoing", value.connection,
        value.heartbeatSupported, value.incrementalSupported, value.connectionId, value.ownershipReceiptSupported,
        value.personId, value.ownerWorkspaceSupported, value.endpoint)
      if (installed) await this.refreshWorkspaceGossip(peer.workspaceId)
      if (installed && value.ownerWorkspaceSupported) {
        const credential = await this.store.getWorkspaceCredential(peer.workspaceId)
        if (credential) await this.offerMissingOwnerWorkspaces(value.connection, credential.transportSecret,
          value.ownerWorkspaceIds, value.personId)
      }
    } catch (error) {
      if (this.hasDeviceSession(peer.workspaceId, peer.deviceId)) {
        this.trace("dial.device.superseded", {
          peerId: peer.deviceId.slice(0, 8),
          workspaceId: peer.workspaceId.slice(0, 8),
          routes: peers.length,
          reason: error instanceof Error ? error.message : String(error),
        })
        return
      }
      this.trace("dial.device.failed", {
        peerId: peer.deviceId.slice(0, 8),
        workspaceId: peer.workspaceId.slice(0, 8),
        routes: peers.length,
        reason: error instanceof Error ? error.message : String(error),
      }, "warn")
      this.reportProtocolFailure(`Dial ${peer.deviceId.slice(0, 6)}`, error)
      await this.notify()
    } finally {
      this.runtime().finishRouteAttempt(key, attempt.token)
    }
  }

  protected async connectPeer(peer: WorkspacePeerRecord, route: DeviceRoute, signal: AbortSignal, routeSignal: AbortSignal) {
    const key = this.peerKey(peer.workspaceId, peer.deviceId, peer.instanceId)
    const connectionId = this.connectionId("outgoing")
    let connection: SyncConnection | undefined
    try {
      this.throwIfDialCancelled(signal, routeSignal)
      let credential = await this.requireDialCredential(peer)
      connection = await this.openPeerConnection(peer, route, key, connectionId)
      const handshake = await this.exchangeOutgoingHandshake(connection, peer, credential, connectionId)
      credential = await this.mergeOutgoingAuthority(credential, handshake.response)
      const verified = await this.verifyOutgoingPeer(peer, credential, handshake.response, signal, routeSignal, connectionId)
      if (Array.isArray(handshake.response.revocations)) await this.mergeRevocations(credential, handshake.response.revocations)
      await this.putVerifiedBundle(credential, handshake.response.peer)
      this.throwIfDialCancelled(signal, routeSignal)
      this.clearRouteReconnect(key)
      const result = this.outgoingConnectionResult(connection, connectionId, verified, handshake.response)
      connection = undefined
      return result
    } catch (error) {
      await this.handleDialFailure(error, connection, peer, key, connectionId, signal, routeSignal)
      throw error
    }
  }

  protected throwIfDialCancelled(signal: AbortSignal, routeSignal: AbortSignal): void {
    if (!this.node || signal.aborted || routeSignal.aborted) throw new MeshDialCancelled()
  }

  protected async requireDialCredential(peer: WorkspacePeerRecord): Promise<WorkspaceMeshCredential> {
    const credential = await this.store.getWorkspaceCredential(peer.workspaceId)
    if (!credential || credential.transportSecret !== peer.transportSecret) throw new Error("Mesh credential unavailable")
    return credential
  }

  protected async openPeerConnection(peer: WorkspacePeerRecord, route: DeviceRoute, key: string, connectionId: string): Promise<SyncConnection> {
    const mode = this.reconnectPolicy.mode(this.node!, key)
    this.trace("dial.started", { connectionId, peerId: peer.deviceId.slice(0, 8), workspaceId: peer.workspaceId.slice(0, 8),
      endpoint: peer.endpoint.slice(0, 8), mode })
    const connection = networkConnection(await networkIO(this.reconnectPolicy.dial<SyncConnection>(this.node!, key, route.endpoint)))
    this.trace("dial.connected", { connectionId, peerId: peer.deviceId.slice(0, 8), mode })
    return connection
  }

  protected async exchangeOutgoingHandshake(connection: SyncConnection, peer: WorkspacePeerRecord,
    credential: WorkspaceMeshCredential, connectionId: string) {
    const stream = await connection.openStream()
    this.trace("handshake.outgoing.started", { connectionId, peerId: peer.deviceId.slice(0, 8) })
    const profile = await this.options.getProfile()
    const ownerWorkspaceIds = credential.ownerPersonId === profile.identity.personId && peer.personId === profile.identity.personId
      ? await this.ownerWorkspaceIds(profile) : undefined
    const request = this.validateHandshake({ workspaceId: peer.workspaceId, peer: await this.ownBundle(credential),
        ownershipTransfers: ownershipTransfers(credential), successionPolicy: successionPolicy(credential),
        breakGlassClaims: breakGlassClaims(credential), successionVotes: successionVotes(credential), successionClaims: successionClaims(credential),
        ownerWorkspaceIds, capabilities: this.handshakeCodec.capabilities() }, peer.workspaceId)
    await stream.send(this.handshakeCodec.encodeRequest(credential.transportSecret, request))
    await stream.closeSend()
    const response = this.handshakeCodec.readResponse(await stream.read(), credential.transportSecret, peer.workspaceId)
    return { response }
  }

  protected async mergeOutgoingAuthority(credential: WorkspaceMeshCredential, response: {
    ownershipTransfers?: WorkspaceOwnershipTransfer[]; breakGlassClaims?: WorkspaceBreakGlassClaim[];
    successionPolicy?: WorkspaceSuccessionPolicy; successionVotes?: WorkspaceSuccessionVote[]; successionClaims?: WorkspaceSuccessionClaim[]
  }): Promise<WorkspaceMeshCredential> {
    return this.mergeIncomingAuthority(credential, response)
  }

  protected async verifyOutgoingPeer(peer: WorkspacePeerRecord, credential: WorkspaceMeshCredential, response: { peer: WorkspaceMemberBundle },
    signal: AbortSignal, routeSignal: AbortSignal, connectionId: string) {
    const verified = await verifyWorkspaceMemberBundle(response.peer, { workspaceId: credential.workspaceId,
      ownerPersonId: credential.ownerPersonId, ownerPublicKey: credential.ownerPublicKey,
      ownerCertificates: credential.ownerCertificates as DeviceCertificate[], ownerHistory: ownerAuthorities(credential).slice(1) })
    this.throwIfDialCancelled(signal, routeSignal)
    if (verified.advertisement.payload.deviceId !== peer.deviceId) throw new Error("Unexpected mesh peer")
    this.trace("handshake.outgoing.verified", { connectionId, peerId: peer.deviceId.slice(0, 8) })
    return verified
  }

  protected outgoingConnectionResult(connection: SyncConnection, connectionId: string,
    verified: VerifiedWorkspaceMember, response: { ownerWorkspaceIds?: string[]; capabilities?: unknown }) {
    const features = this.handshakeCodec.features(response.capabilities)
    return {
        connection,
        connectionId,
        instanceId: verified.advertisement.payload.instanceId ?? "legacy",
        issuedAt: verified.advertisement.payload.issuedAt,
        routeSequence: verified.advertisement.payload.routeSequence,
        personId: verified.advertisement.payload.personId,
        endpoint: verified.advertisement.payload.endpoint,
        ownerWorkspaceIds: response.ownerWorkspaceIds,
        ...features,
    }
  }

  protected async handleDialFailure(error: unknown, connection: SyncConnection | undefined, peer: WorkspacePeerRecord, key: string,
    connectionId: string, signal: AbortSignal, routeSignal: AbortSignal): Promise<void> {
    if (error instanceof MeshDialCancelled || signal.aborted || routeSignal.aborted) {
      await connection?.close().catch(() => {})
      this.trace("dial.cancelled", { connectionId, peerId: peer.deviceId.slice(0, 8) })
      throw new MeshDialCancelled()
    }
    this.reconnectPolicy.recordFailure(key, isNetworkFailure(error))
    this.trace("dial.failed", { connectionId, peerId: peer.deviceId.slice(0, 8),
      reason: error instanceof Error ? error.message : String(error) }, "warn")
    if (!this.hasDeviceSession(peer.workspaceId, peer.deviceId)) this.reportProtocolFailure(`Dial ${peer.deviceId.slice(0, 6)}`, error)
    else this.trace("dial.failure.superseded", { connectionId, peerId: peer.deviceId.slice(0, 8) })
    this.runtime().scheduleReconnect(key, Date.now(), 5_000, 5 * 60_000)
    await connection?.close().catch(() => {})
    if (/runtime node is closed|node is closed/i.test(error instanceof Error ? error.message : String(error))) {
      const stale = this.node
      this.node = undefined
      await stale?.close("Mesh runtime closed").catch(() => {})
    }
  }
}
