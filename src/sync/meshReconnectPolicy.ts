import type { SyncConnection, SyncNode } from "./transport"
import { isNetworkFailure } from "./workspaceSet"

export class MeshReconnectPolicy {
  private readonly relayPeers = new Set<string>()

  recordFailure(peerKey: string, error: unknown) {
    if (isNetworkFailure(error)) this.relayPeers.add(peerKey)
  }

  dial(node: SyncNode, peerKey: string, endpoint: string): Promise<SyncConnection> {
    if (this.relayPeers.has(peerKey) && node.dialRelay) return node.dialRelay(endpoint)
    return node.dial(endpoint)
  }
}
