import { type LocalProfile} from "../domain/identity"
import { startMeshHeartbeat } from "@meta-uber/mesh-transport"
import type { AutomergeAntiEntropy } from "@meta-uber/mesh-replication/automerge"
import { type WorkspaceMemberBundle} from "./meshRecords"
import { hasConflictingOwnershipTransfers } from "./ownershipConflicts"
import { type WorkspaceMeshCredential} from "./peerStore"
import type { SyncConnection} from "./transport"
import { liveAutomergeWorkspaceSync, liveWorkspaceSetSync, workspaceSet, type LiveWorkspaceSync} from "./workspaceSet"
import { ownershipTransfers, successionPolicy, successionVotes, successionClaims, breakGlassClaims, hasConflictingBreakGlassClaims, revokedPersonIds, shouldReplaceMeshSession,
  type MeshPeerView, type MeshSuccessionView, type SessionEntry } from "./durableMeshBase"
import { DurableMeshDial } from "./durableMeshDial"

export class DurableMeshSessions extends DurableMeshDial {
  protected async installSession(workspaceId: string, deviceId: string, instanceId: string, remoteIssuedAt: string,
    remoteRouteSequence: number | undefined, direction: "incoming" | "outgoing", connection: SyncConnection, heartbeatSupported = false,
    incrementalSupported = false, connectionId = this.connectionId(direction), ownershipReceiptSupported = false,
    remotePersonId = "", ownerWorkspaceSupported = false, remoteEndpoint = "") {
    const key = this.peerKey(workspaceId, deviceId, instanceId)
    const profile = await this.options.getProfile()
    const preferred = profile.device.deviceId < deviceId ? "outgoing" : "incoming"
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential) { await connection.close(); return false }
    // No await between choosing the winner and registering it: concurrent
    // handshakes must observe the session installed by the previous continuation.
    const previous = this.sessions.get(key)
    const replace = shouldReplaceMeshSession(previous, { remoteIssuedAt, remoteRouteSequence, direction }, preferred)
    if (!replace) {
      this.trace("session.rejected", { connectionId, peerId: deviceId.slice(0, 8), direction, reason: "duplicate direction" })
      await connection.close()
      return false
    }
    const { incrementalEngine, session } = this.createMeshSession(connection, credential, workspaceId, deviceId,
      instanceId, profile, incrementalSupported, connectionId, remotePersonId, ownerWorkspaceSupported, remoteEndpoint)
    let stopHeartbeat: (() => void) | undefined = undefined
    let evicted = false
    const entry: SessionEntry = {
      workspaceId, deviceId, instanceId, endpoint: remoteEndpoint, remoteIssuedAt, remoteRouteSequence, direction,
      connection, session, ownershipReceiptSupported,
      evict: async cause => {
        if (evicted) return
        evicted = true
        stopHeartbeat?.()
        const wasCurrent = this.sessions.get(key) === entry
        if (wasCurrent) {
          this.sessions.delete(key)
          if (incrementalEngine) incrementalEngine.reset(workspaceId, deviceId)
          await this.refreshWorkspaceGossip(workspaceId)
        }
        this.trace("session.closed", { connectionId, peerId: deviceId.slice(0, 8), wasCurrent, cause })
        if (wasCurrent) {
          if (!this.stopped) queueMicrotask(() => { void this.publishAll() })
          await Promise.allSettled([this.notify(), session.close(), connection.close()])
          return
        }
        await Promise.allSettled([session.close(), connection.close()])
      },
    }
    this.sessions.set(key, entry)
    this.trace("session.started", {
      connectionId,
      peerId: deviceId.slice(0, 8),
      instanceId: instanceId.slice(0, 8),
      workspaceId: workspaceId.slice(0, 8),
      direction,
      heartbeat: heartbeatSupported,
      incremental: incrementalSupported,
      replaced: Boolean(previous),
    })
    // A replacement transport session does not prove its document is valid.
    // Keep a document rejection visible until that document later validates.
    if (!this.lastDiagnostic.startsWith("Workspace ")) {
      this.lastDiagnostic = ""
      this.options.onDiagnostic?.("")
    }
    void previous?.evict("replaced")
    // Local writes made while offline have no session to publish through. Replay
    // them once this replacement is the current authenticated transport.
    queueMicrotask(() => { void this.publishRecoveredSession(key, entry) })
    stopHeartbeat = heartbeatSupported ? startMeshHeartbeat(session, error => {
        if (evicted) return
        this.reconnectPolicy.recordFailure(key, error)
        this.trace("session.heartbeat.failed", { connectionId, peerId: deviceId.slice(0, 8), reason: error instanceof Error ? error.message : String(error) }, "warn")
        this.reportProtocolFailure(`Heartbeat ${deviceId.slice(0, 6)}`, error)
        void entry.evict("heartbeat failed")
      }) : undefined
    void session.done.catch(error => {
      if (evicted) return
      this.reconnectPolicy.recordFailure(key, error)
      this.trace("session.receive.failed", { connectionId, peerId: deviceId.slice(0, 8), reason: error instanceof Error ? error.message : String(error) }, "warn")
      this.reportProtocolFailure(`Receive ${deviceId.slice(0, 6)}`, error)
    }).finally(() => entry.evict("receive loop ended"))
    await this.notify()
    return true
  }

  protected async publishRecoveredSession(key: string, entry: SessionEntry) {
    if (this.stopped || this.sessions.get(key) !== entry) return
    try {
      await entry.session.publish()
    } catch (error) {
      this.reconnectPolicy.recordFailure(key, error)
      this.report(`Publish ${entry.deviceId.slice(0, 6)}`, error)
      await entry.evict("recovery publish failed")
    }
  }

  protected createMeshSession(connection: SyncConnection, credential: WorkspaceMeshCredential, workspaceId: string, deviceId: string,
    instanceId: string, profile: LocalProfile, incrementalSupported: boolean, connectionId: string, remotePersonId: string,
    ownerWorkspaceSupported: boolean, remoteEndpoint: string): { incrementalEngine: AutomergeAntiEntropy | undefined; session: LiveWorkspaceSync } {
    const incrementalEngine = incrementalSupported ? this.syncEngine(workspaceId, deviceId, profile.device.deviceId, instanceId) : undefined
    if (!incrementalEngine) return { incrementalEngine, session: liveWorkspaceSetSync(connection, credential.transportSecret,
      workspaceSet(this.options.workspaceStore, [workspaceId]), { onGossipPacket: remoteEndpoint
        ? packet => this.receiveWorkspaceGossipPacket(workspaceId, remoteEndpoint, packet) : undefined }) }
    const session = liveAutomergeWorkspaceSync(connection, credential.transportSecret, this.options.workspaceStore, workspaceId,
      profile.device.deviceId, deviceId, incrementalEngine, error => this.handleDocumentSyncError(error ?? undefined, connectionId, workspaceId, deviceId, instanceId), {
        onOwnerWorkspaceOffer: ownerWorkspaceSupported && remotePersonId === profile.identity.personId
          ? bytes => this.receiveOwnerWorkspaceOffer(bytes, remotePersonId) : undefined,
        onGossipPacket: remoteEndpoint ? packet => this.receiveWorkspaceGossipPacket(workspaceId, remoteEndpoint, packet) : undefined,
      })
    return { incrementalEngine, session }
  }

  protected handleDocumentSyncError(error: Error | undefined, connectionId: string, workspaceId: string, deviceId: string,
    instanceId: string): void {
    const stage = `Workspace ${workspaceId.slice(0, 8)} from ${deviceId.slice(0, 8)}`
    if (error) {
      this.trace("document.rejected", { connectionId, workspaceId, peerId: deviceId, instanceId, reason: error.message }, "warn")
      this.report(stage, error)
      return
    }
    if (this.lastDiagnostic.startsWith(`${stage}:`)) {
      this.lastDiagnostic = ""
      this.options.onDiagnostic?.("")
    }
  }

  protected async publishAll() {
    console.info("[match.publish]", this.sessions.size)
    const byWorkspace = new Map<string, Array<[string, SessionEntry]>>()
    for (const item of this.sessions.entries()) {
      const entries = byWorkspace.get(item[1].workspaceId) ?? []
      entries.push(item)
      byWorkspace.set(item[1].workspaceId, entries)
    }
    await Promise.allSettled([...byWorkspace].map(async ([workspaceId, entries]) => {
      try { await this.broadcastWorkspaceGossip(workspaceId) }
      catch (error) {
        this.trace("gossip.broadcast.failed", {
          workspaceId: workspaceId.slice(0, 8),
          reason: error instanceof Error ? error.message : String(error),
        }, "warn")
      }
      // Gossip discovers neighbours. The authenticated mesh session delivers the
      // document, and remains valid while gossip is rebuilding after a route swap.
      await Promise.allSettled(entries.map(async ([key, entry]) => {
        try {
          await entry.session.publish()
        } catch (error) {
          this.reconnectPolicy.recordFailure(key, error)
          this.report(`Publish ${entry.deviceId.slice(0, 6)}`, error)
          await entry.evict("publish failed")
        }
      }))
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
      const conflicted = new Set(claims.map(claim => claim.payload.toOwnerPersonId)).size > 1 ||
        hasConflictingOwnershipTransfers(ownershipTransfers(credential)) ||
        hasConflictingBreakGlassClaims(breakGlassClaims(credential))
      const policy = successionPolicy(credential) ?? claims[0]?.payload.policy
      if (!policy) {
        if (conflicted) result.push({ workspaceId: credential.workspaceId, successorPersonId: null,
          eligibleEditorPersonIds: [], votes: [], quorum: 0, conflicted: true })
        continue
      }
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

  protected async notify() {
    const workspaces = [...new Set([...this.sessions.values()].map(entry => entry.workspaceId))]
    const peers = await this.views()
    const revoked = await this.revokedWorkspaceIds()
    const succession = await this.successionViews()
    this.options.onChange?.(workspaces, peers, revoked, succession)
  }
}
