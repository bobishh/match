import { BrowserMeshGossip } from "@meta-uber/mesh-runtime"
import { publishGossipPacket } from "./workspaceSet"
import { DurableMeshBase } from "./durableMeshBase"

/** Match binds workspace documents to the shared browser gossip lifecycle. */
export abstract class DurableMeshGossip extends DurableMeshBase {
  protected readonly gossip = new BrowserMeshGossip({
    isStopped: () => this.stopped,
    createEngine: () => this.node?.createGossipEngine(),
    endpoints: workspaceId => [...new Set([...this.sessions.values()]
      .filter(entry => entry.workspaceId === workspaceId && entry.endpoint)
      .map(entry => entry.endpoint))].sort(),
    setEndpoints: (workspaceId, endpoints) => this.runtime().setGossipEndpoints(workspaceId, endpoints),
    transportSecret: async workspaceId => (await this.store.getWorkspaceCredential(workspaceId))?.transportSecret,
    session: (workspaceId, endpoint) => {
      const entry = [...this.sessions.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.endpoint === endpoint)
      return entry && { endpoint: entry.endpoint, deviceId: entry.deviceId, publish: () => entry.session.publish() }
    },
    send: async (workspaceId, endpoint, secret, packet) => {
      const entry = [...this.sessions.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.endpoint === endpoint)
      if (!entry) throw new Error("Gossip peer session is unavailable")
      await publishGossipPacket(entry.connection, secret, packet)
    },
    publishAll: () => this.publishAll(),
    trace: (event, detail, level) => this.trace(event, detail, level),
  }, "match-workspace-")

  protected refreshWorkspaceGossip(workspaceId: string): Promise<void> { return this.gossip.refresh(workspaceId) }
  protected async rebuildWorkspaceGossip(workspaceId: string): Promise<void> { await this.gossip.rebuild(workspaceId) }
  protected async receiveWorkspaceGossipPacket(workspaceId: string, endpoint: string, packet: Uint8Array): Promise<void> {
    await this.gossip.receivePacket(workspaceId, endpoint, packet)
  }
  protected async broadcastWorkspaceGossip(workspaceId: string): Promise<Set<string> | undefined> {
    return this.gossip.broadcast(workspaceId)
  }
  protected abstract publishAll(): Promise<void>
}
