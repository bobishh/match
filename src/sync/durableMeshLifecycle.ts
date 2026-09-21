import { type LocalProfile} from "../domain/identity"
import type { DeviceCertificate } from "../domain/model"
import { defaultProofStore } from "../domain/proofs"
import { type WorkspaceMemberBundle} from "./meshRecords"
import { type WorkspaceMeshCredential} from "./peerStore"
import type { SyncConnection, SyncNode, DuplexStream } from "./transport"
import { MeshNodeRestart, uniqueCertificates } from "./durableMeshBase"
import { startPersistentNode } from "./persistentNode"
import { meshNetworkConnection as networkConnection } from "@meta-uber/mesh-transport"
import { isMeshNetworkFailure as isNetworkFailure } from "@meta-uber/mesh-transport"
import { DurableMeshAuthority } from "./durableMeshAuthority"

export abstract class DurableMeshLifecycle extends DurableMeshAuthority {
  protected abstract refreshOwnBundle(credential: WorkspaceMeshCredential, profile: LocalProfile, endpoint: string, certificates: DeviceCertificate[]): Promise<WorkspaceMemberBundle | undefined>
  protected abstract pruneInvalidStoredPeers(credential: WorkspaceMeshCredential, localDeviceId: string): Promise<void>
  protected abstract acceptConnection(connection: SyncConnection, signal?: AbortSignal, initial?: { stream: DuplexStream; frame: Uint8Array }, connectionId?: string): Promise<void>
  protected abstract dialLoop(signal: AbortSignal): Promise<void>
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
    this.options.onRetryChange?.({})
    await this.task?.catch(() => {})
    this.task = undefined
    await this.shutdown()
    if (releaseInstance) {
      await this.releaseInstance?.()
      this.releaseInstance = undefined
    }
  }

  protected async shutdown() {
    this.trace("node.shutdown", { sessions: this.sessions.size, pendingIncoming: this.pendingIncomingConnections })
    this.stopWatch?.()
    this.stopWatch = undefined
    const node = this.node
    this.node = undefined
    for (const driver of this.gossipDrivers.values()) driver.close()
    this.gossipDrivers.clear()
    this.gossipNeighborCounts.clear()
    this.gossipPeerKeys.clear()
    await this.dropSessions()
    this.runtimeState?.stop()
    await Promise.allSettled(this.gossipRefreshes.values())
    for (const driver of this.gossipDrivers.values()) driver.close()
    this.gossipDrivers.clear()
    this.gossipNeighborCounts.clear()
    this.gossipPeerKeys.clear()
    await this.acceptor?.close().catch(() => {})
    this.acceptor = undefined
    const adopted = this.adoptedNode
    this.adoptedNode = undefined
    await node?.close("Mesh stopped").catch(() => {})
    if (adopted !== node) await adopted?.close("Mesh stopped").catch(() => {})
    await this.notify()
  }

  protected async run(signal: AbortSignal) {
    while (!signal.aborted) {
      this.currentRunId = ++this.runSequence
      this.trace("run.start")
      const offline = () => { void this.dropSessions() }
      const abort = () => { void this.shutdown() }
      try {
        await this.runMeshOnce(signal, offline, abort)
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

  protected async runMeshOnce(signal: AbortSignal, offline: () => void, abort: () => void): Promise<void> {
    const storedCredentials = await this.store.listWorkspaceCredentials()
    const profile = await this.options.getProfile()
    const ownedWorkspaceIds = await this.options.getOwnedWorkspaceIds?.() ?? []
    if (signal.aborted || (storedCredentials.length === 0 && ownedWorkspaceIds.length === 0)) return
    let credentials = await this.activeCredentialsForProfile(storedCredentials, profile)
    if (signal.aborted || (credentials.length === 0 && ownedWorkspaceIds.length === 0)) return
    const adoptedNode = this.adoptedNode
    this.adoptedNode = undefined
    const node = adoptedNode ?? await startPersistentNode(this.options.transport, this.store, this.instanceId)
    if (signal.aborted) return void node.close("Mesh cancelled")
    this.node = node
    this.trace("node.started", { source: adoptedNode ? "adopted" : "instance", endpoint: node.endpointId.slice(0, 8) })
    if (ownedWorkspaceIds.length > 0) credentials = await this.prepareOwnedWorkspaces(ownedWorkspaceIds, node, profile)
    await this.prepareCredentials(credentials, profile, node.endpointId)
    this.acceptor = await node.accept()
    signal.addEventListener("abort", abort, { once: true })
    if (typeof window !== "undefined") window.addEventListener("offline", offline)
    this.stopWatch = this.options.workspace.subscribe?.(() => { void this.publishAll() })
    void this.acceptLoop(signal)
    await this.dialLoop(signal)
  }

  protected async prepareOwnedWorkspaces(ids: string[], node: SyncNode, profile: LocalProfile): Promise<WorkspaceMeshCredential[]> {
    await this.ensureOwnerWorkspaces(ids, node.endpointId, profile)
    return this.activeCredentialsForProfile(await this.store.listWorkspaceCredentials(), profile)
  }

  protected async prepareCredentials(credentials: WorkspaceMeshCredential[], profile: LocalProfile, endpoint: string): Promise<void> {
    const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
    for (let credential of credentials) {
      credential = await this.migrateLegacyBreakGlassClaim(credential, profile)
      credential = await this.refreshOwnerCertificates(credential, profile, certificates)
      await this.refreshOwnBundle(credential, profile, endpoint, certificates)
      await this.pruneInvalidStoredPeers(credential, profile.device.deviceId)
    }
  }

  protected async dropSessions() {
    const sessions = [...this.sessions.values()]
    await Promise.allSettled(sessions.map(entry => entry.evict("mesh stopped")))
    await this.notify()
  }

  protected async acceptLoop(signal: AbortSignal) {
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

}
