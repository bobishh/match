import { authorityValidationFingerprint } from "./changeAuthorization"
import type { PeerStore } from "./peerStore"
import type { WorkspaceSetStore } from "./workspaceSet"

/** Shares history validation across handshakes until durable rights change. */
export class WorkspaceAuthorityClassification {
  async classifyStored(workspaceId: string, store: Pick<PeerStore, "getWorkspaceAuthority" | "getWorkspaceCredential">,
    workspaceStore: Pick<WorkspaceSetStore, "reclassify">, reused: () => void): Promise<void> {
    if (!workspaceStore.reclassify) return
    if (!store.getWorkspaceAuthority) return workspaceStore.reclassify(workspaceId)
    const authority = await store.getWorkspaceAuthority(workspaceId) ?? await store.getWorkspaceCredential(workspaceId)
    return this.reclassify(workspaceId, authorityValidationFingerprint(authority),
      () => workspaceStore.reclassify!(workspaceId), reused)
  }

  private readonly entries = new Map<string, { fingerprint: string; done: Promise<void> }>()

  reclassify(workspaceId: string, fingerprint: string, operation: () => Promise<void>, reused: () => void): Promise<void> {
    const previous = this.entries.get(workspaceId)
    if (previous?.fingerprint === fingerprint) { reused(); return previous.done }
    const entry = { fingerprint, done: Promise.resolve() }
    // Install before invoking the operation so overlapping handshakes share it.
    entry.done = Promise.resolve().then(operation).catch(error => {
      if (this.entries.get(workspaceId) === entry) this.entries.delete(workspaceId)
      throw error
    })
    this.entries.set(workspaceId, entry)
    return entry.done
  }
}
