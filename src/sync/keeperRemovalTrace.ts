import type { DurableMesh, MeshPeerView } from "./durableMesh"
import type { LighthouseDiscovery } from "./lighthouseDiscovery"
import { removeKeeperAccess } from "./deviceSyncKeeper"
import type { LocalProfile } from "../domain/identity"
import { meshTrace } from "./meshTrace"

let activeRemovalPersonId = ""

export function beginKeeperRemovalTrace(personId: string, peers: MeshPeerView[]) {
  activeRemovalPersonId = personId
  recordKeeperRemovalProjection(peers, "before")
}

export function keeperRemovalTrace(event: string, detail: Record<string, unknown>, peers: MeshPeerView[]) {
  meshTrace(`keeper.remove.${event}`, detail)
  if (event === "complete" || event === "failed") {
    recordKeeperRemovalProjection(peers, "after")
    activeRemovalPersonId = ""
  }
}

export function recordKeeperRemovalProjection(peers: MeshPeerView[], phase = "mesh-notify") {
  if (!activeRemovalPersonId) return
  const matching = peers.filter(peer => peer.personId === activeRemovalPersonId)
  if (!matching.length) {
    meshTrace("keeper.remove.projection", { peerId: activeRemovalPersonId, phase, outcome: "no-peer" })
    return
  }
  for (const peer of matching) meshTrace("keeper.remove.projection", {
    peerId: peer.personId, workspaceId: peer.workspaceId, recordId: peer.deviceId, phase,
    outcome: peer.revokedAt ? "revoked" : "active",
  })
}

export function removeKeeperWithTrace(personId: string, options: {
  getProfile: () => Promise<LocalProfile>
  workspaces: { id: string; title: string }[]
  workspaceOwner?: (id: string) => Promise<string>
  mesh: () => Promise<DurableMesh | undefined>
  activeWorkspaceId?: string
  discovery?: LighthouseDiscovery
  knownServiceDeviceIds?: string[]
  peers: () => MeshPeerView[]
  changed: () => void
}): Promise<"removed" | "pending"> {
  activeRemovalPersonId = personId
  recordKeeperRemovalProjection(options.peers(), "before")
  const { peers, changed, ...removalOptions } = options
  const trace = (event: string, detail: Record<string, unknown>) => keeperRemovalTrace(event, detail, peers())
  return removeKeeperAccess(personId, { ...removalOptions, trace }).then(result => { changed(); return result }, error => {
    trace("failed", { peerId: personId, outcome: error instanceof Error ? error.name : "unknown" })
    throw error
  })
}
