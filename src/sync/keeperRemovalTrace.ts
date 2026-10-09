import type { DurableMesh, MeshPeerView } from "./durableMesh"
import type { KeeperDiscovery } from "./keeperDiscovery"
import { removeKeeperAccess } from "./deviceSyncKeeper"
import type { LocalProfile } from "../domain/identity"
import { meshTrace } from "./meshTrace"

let activeRemovalPersonId = ""
type KeeperRemovalProjection = Pick<MeshPeerView, "personId" | "workspaceId" | "deviceId" | "revokedAt">

function keeperRemovalTrace(event: string, detail: Record<string, unknown>, peers: MeshPeerView[]) {
  meshTrace(`keeper.remove.${event}`, detail)
  if (event === "complete" || event === "failed") {
    recordKeeperRemovalProjection(peers, "after")
    activeRemovalPersonId = ""
  }
}

export function recordKeeperRemovalProjection(peers: KeeperRemovalProjection[], phase = "mesh-notify", personId = activeRemovalPersonId) {
  if (!personId) return
  const matching = peers.filter(peer => peer.personId === personId)
  if (!matching.length) {
    meshTrace("keeper.remove.projection", { peerId: personId, phase, outcome: "no-peer" })
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
  discovery?: KeeperDiscovery
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
