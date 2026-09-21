import { type LocalProfile} from "../domain/identity"
import { isMeshNetworkFailure } from "@meta-uber/mesh-transport"
import { BrowserMeshSessions } from "@meta-uber/mesh-runtime"
import type { AutomergeAntiEntropy } from "@meta-uber/mesh-replication/automerge"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { type WorkspaceMemberBundle} from "./meshRecords"
import { type WorkspaceMeshCredential} from "./peerStore"
import type { SyncConnection} from "./transport"
import { liveAutomergeWorkspaceSync, liveWorkspaceSetSync, workspaceSet, type LiveWorkspaceSync} from "./workspaceSet"
import { ownershipTransfers, successionPolicy, successionVotes, successionClaims, breakGlassClaims, revocations, revokedPersonIds,
  type MeshPeerView, type MeshSuccessionView, type SessionEntry } from "./durableMeshBase"
import { DurableMeshDial } from "./durableMeshDial"

export class DurableMeshSessions extends DurableMeshDial {
  private readonly browserSessions = new BrowserMeshSessions<SyncConnection, LiveWorkspaceSync, LocalProfile>({
    profile: this.options.getProfile,
    deviceId: profile => profile.device.deviceId,
    credential: workspaceId => this.store.getWorkspaceCredential(workspaceId),
    create: input => {
      const created = this.createMeshSession(input.connection, input.credential as WorkspaceMeshCredential,
        input.workspaceId, input.deviceId, input.instanceId, input.profile, input.incrementalSupported,
        input.connectionId, input.remotePersonId, input.ownerWorkspaceSupported, input.remoteEndpoint)
      return { session: created.session, reset: created.incrementalEngine
        ? () => created.incrementalEngine!.reset(input.workspaceId, input.deviceId) : undefined }
    },
    runtime: () => this.runtime(),
    key: (workspaceId, deviceId, instanceId) => this.peerKey(workspaceId, deviceId, instanceId),
    stopped: () => this.stopped,
    trace: (event, detail, level) => this.trace(event, detail, level),
    diagnosticCleared: () => {
      if (!this.lastDiagnostic.startsWith("Workspace ")) {
        this.lastDiagnostic = ""
        this.options.onDiagnostic?.("")
      }
    },
    currentRemoved: async entry => {
      await this.refreshWorkspaceGossip(entry.workspaceId)
      if (!this.stopped) queueMicrotask(() => { void this.publishAll() })
      await this.notify()
    },
    notify: () => this.notify(),
    publishRecovered: (key, entry) => this.publishRecoveredSession(key, entry as SessionEntry),
    protocolFailure: (stage, error) => this.reportProtocolFailure(stage, error),
    networkFailure: (key, error) => this.reconnectPolicy.recordFailure(key, isMeshNetworkFailure(error)),
  }, this.sessions)

  protected async installSession(workspaceId: string, deviceId: string, instanceId: string, remoteIssuedAt: string,
    remoteRouteSequence: number | undefined, direction: "incoming" | "outgoing", connection: SyncConnection, heartbeatSupported = false,
    incrementalSupported = false, connectionId = this.connectionId(direction), ownershipReceiptSupported = false,
    remotePersonId = "", ownerWorkspaceSupported = false, remoteEndpoint = "") {
    return this.browserSessions.install({ workspaceId, deviceId, instanceId, remoteIssuedAt, remoteRouteSequence,
      direction, connection, heartbeatSupported, incrementalSupported, connectionId, ownershipReceiptSupported,
      remotePersonId, ownerWorkspaceSupported, remoteEndpoint })
  }

  protected async publishRecoveredSession(key: string, entry: SessionEntry) {
    if (this.stopped || this.sessions.get(key) !== entry) return
    try {
      await entry.session.publish()
    } catch (error) {
      this.reconnectPolicy.recordFailure(key, isMeshNetworkFailure(error))
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
    await this.browserSessions.publishAll(async workspaceId => {
      try { await this.broadcastWorkspaceGossip(workspaceId) }
      catch (error) {
        this.trace("gossip.broadcast.failed", {
          workspaceId: workspaceId.slice(0, 8), reason: error instanceof Error ? error.message : String(error),
        }, "warn")
      }
    }, async (key, entry, error) => {
      this.reconnectPolicy.recordFailure(key, isMeshNetworkFailure(error))
      this.report(`Publish ${entry.deviceId.slice(0, 6)}`, error)
      await entry.evict("publish failed")
    })
  }

  async views(workspaceId?: string): Promise<MeshPeerView[]> {
    return (await this.store.listPeers(workspaceId)).map(peer => {
      const payload = (peer.advertisement as WorkspaceMemberBundle | undefined)?.advertisement?.payload
      const online = this.runtimeState?.connectedDevices(peer.workspaceId).includes(peer.deviceId) ?? false
      return {
        workspaceId: peer.workspaceId, personId: peer.personId, deviceId: peer.deviceId, role: peer.role,
        endpoint: peer.endpoint, lastSeen: peer.lastSeen, revokedAt: peer.revokedAt,
        online,
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
      const summary = meshRustRuntime().state.summarizeSuccession(
        successionPolicy(credential), successionClaims(credential), successionVotes(credential), ownershipTransfers(credential),
        breakGlassClaims(credential), revocations(credential), credential.epoch,
      ) as { successorPersonId: string | null; eligibleEditorPersonIds: string[];
        votes: Array<{ voterPersonId: string; candidatePersonId: string }>; quorum: number; conflicted: boolean } | null
      if (!summary) continue
      result.push({
        workspaceId: credential.workspaceId,
        successorPersonId: summary.successorPersonId,
        eligibleEditorPersonIds: summary.eligibleEditorPersonIds,
        votes: summary.votes,
        quorum: summary.quorum,
        conflicted: summary.conflicted,
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
