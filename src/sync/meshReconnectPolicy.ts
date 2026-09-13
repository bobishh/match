import type { SyncConnection, SyncNode } from "./transport"
import { isNetworkFailure } from "./workspaceSet"

export class MeshReconnectPolicy {
  private readonly relayPeers = new Set<string>()

  recordFailure(peerKey: string, error: unknown) {
    if (isNetworkFailure(error)) this.relayPeers.add(peerKey)
  }

  mode(node: SyncNode, peerKey: string): "direct" | "relay" {
    return this.relayPeers.has(peerKey) && node.dialRelay ? "relay" : "direct"
  }

  dial(node: SyncNode, peerKey: string, endpoint: string): Promise<SyncConnection> {
    if (this.mode(node, peerKey) === "relay") return node.dialRelay!(endpoint)
    return node.dial(endpoint)
  }
}
