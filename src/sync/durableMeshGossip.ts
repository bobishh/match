import { BrowserGossipDriver, type GossipDelivery } from "@meta-uber/mesh-replication/gossip"
import { publishGossipPacket} from "./workspaceSet"
import { DurableMeshBase } from "./durableMeshBase"

export abstract class DurableMeshGossip extends DurableMeshBase {
  protected gossipTopic(workspaceId: string) {
    return `match-workspace-${workspaceId}`
  }

  protected gossipSession(workspaceId: string, endpoint: string) {
    return [...this.sessions.values()].find(entry =>
      entry.workspaceId === workspaceId && entry.endpoint === endpoint)
  }

  protected refreshWorkspaceGossip(workspaceId: string): Promise<void> {
    const previous = this.gossipRefreshes.get(workspaceId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => this.rebuildWorkspaceGossip(workspaceId))
    this.gossipRefreshes.set(workspaceId, current)
    void current.finally(() => {
      if (this.gossipRefreshes.get(workspaceId) === current) this.gossipRefreshes.delete(workspaceId)
    })
    return current
  }

  protected async rebuildWorkspaceGossip(workspaceId: string) {
    const node = this.node
    const endpoints = [...new Set([...this.sessions.values()]
      .filter(entry => entry.workspaceId === workspaceId && entry.endpoint)
      .map(entry => entry.endpoint))].sort()
    const topology = this.runtime().setGossipEndpoints(workspaceId, endpoints)
    if (!this.stopped && node && endpoints.length &&
      this.gossipDrivers.has(workspaceId) && !topology.changed) return
    const previous = this.gossipDrivers.get(workspaceId)
    previous?.close()
    this.gossipDrivers.delete(workspaceId)
    this.gossipNeighborCounts.delete(workspaceId)
    if (this.stopped || !node || !topology.endpoints.length) return
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential) return
    const topic = this.gossipTopic(workspaceId)
    const driver = new BrowserGossipDriver(node.createGossipEngine(), {
      send: async (endpoint, packet) => {
        const entry = this.gossipSession(workspaceId, endpoint)
        if (!entry) throw new Error("Gossip peer session is unavailable")
        try {
          await publishGossipPacket(entry.connection, credential.transportSecret, packet)
          this.trace("gossip.sent", { workspaceId: workspaceId.slice(0, 8), endpoint: endpoint.slice(0, 8) })
        } catch (error) {
          this.trace("gossip.send.failed", {
            workspaceId: workspaceId.slice(0, 8),
            endpoint: endpoint.slice(0, 8),
            reason: error instanceof Error ? error.message : String(error),
          }, "warn")
          throw error
        }
      },
      deliver: delivery => this.receiveWorkspaceGossip(workspaceId, delivery),
    })
    this.gossipDrivers.set(workspaceId, driver)
    this.gossipNeighborCounts.set(workspaceId, 0)
    try {
      await driver.joinTopic(topic, topology.endpoints)
      this.trace("gossip.started", { workspaceId: workspaceId.slice(0, 8), peers: topology.endpoints.length })
    } catch (error) {
      if (this.gossipDrivers.get(workspaceId) === driver) this.gossipDrivers.delete(workspaceId)
      driver.close()
      this.trace("gossip.start.failed", {
        workspaceId: workspaceId.slice(0, 8),
        reason: error instanceof Error ? error.message : String(error),
      }, "warn")
    }
  }

  protected async receiveWorkspaceGossip(workspaceId: string, delivery: GossipDelivery) {
    if (delivery.topic !== this.gossipTopic(workspaceId)) return
    const entry = this.gossipSession(workspaceId, delivery.deliveredFrom)
    if (!entry) {
      this.trace("gossip.rejected", {
        workspaceId: workspaceId.slice(0, 8),
        endpoint: delivery.deliveredFrom.slice(0, 8),
      }, "warn")
      return
    }
    let value: { version?: unknown; kind?: unknown; workspaceId?: unknown }
    try { value = JSON.parse(new TextDecoder().decode(delivery.content)) }
    catch { return }
    if (value.version !== 1 || value.kind !== "workspace-update" || value.workspaceId !== workspaceId) return
    this.trace("gossip.delivered", {
      workspaceId: workspaceId.slice(0, 8),
      peerId: entry.deviceId.slice(0, 8),
    })
    await entry.session.publish()
  }

  protected async receiveWorkspaceGossipPacket(workspaceId: string, endpoint: string, packet: Uint8Array) {
    let driver = this.gossipDrivers.get(workspaceId)
    if (!driver) {
      await this.refreshWorkspaceGossip(workspaceId)
      driver = this.gossipDrivers.get(workspaceId)
    }
    if (!driver || !this.gossipSession(workspaceId, endpoint)) return
    await driver.handleMessage(endpoint, packet)
    const neighbors = driver.activeNeighbors(this.gossipTopic(workspaceId)).length
    const previous = this.gossipNeighborCounts.get(workspaceId) ?? 0
    this.gossipNeighborCounts.set(workspaceId, neighbors)
    this.trace("gossip.packet", { workspaceId: workspaceId.slice(0, 8), neighbors })
    if (neighbors > previous) {
      this.trace("gossip.neighbor.up", { workspaceId: workspaceId.slice(0, 8), neighbors })
      queueMicrotask(() => { void this.publishAll() })
    } else if (neighbors < previous) {
      this.trace("gossip.neighbor.down", { workspaceId: workspaceId.slice(0, 8), neighbors })
    }
  }

  protected async broadcastWorkspaceGossip(workspaceId: string): Promise<Set<string> | undefined> {
    const driver = this.gossipDrivers.get(workspaceId)
    if (!driver) return undefined
    const topic = this.gossipTopic(workspaceId)
    await driver.broadcast(topic, new TextEncoder().encode(JSON.stringify({
      version: 1,
      kind: "workspace-update",
      workspaceId,
      nonce: crypto.randomUUID(),
    })))
    const neighbors = new Set(driver.activeNeighbors(topic))
    this.trace("gossip.broadcast", { workspaceId: workspaceId.slice(0, 8), neighbors: neighbors.size })
    return neighbors
  }
}
