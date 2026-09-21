import { peerStore, type PeerStore } from "./peerStore";
import type { SyncTransport } from "./transport";

export async function startPersistentNode(
  transport: SyncTransport,
  store: PeerStore = peerStore,
  instanceId?: string,
) {
  const secret = instanceId
    ? await store.getOrCreateInstanceNodeSecret(instanceId)
    : await store.getOrCreateNodeSecret();
  return transport.start(secret);
}
