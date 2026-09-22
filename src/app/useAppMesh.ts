import { computed, ref, type ComputedRef, type Ref } from "vue"
import type { WorkspaceRole } from "../domain/permissions"
import { bootstrapIdentity } from "../domain/identity"
import { pendingHistoryRepair, repairPendingHistory } from "../sync/changeAuthorization"
import { describeUserAgent } from "../ui/deviceInfo"
import type { useDeviceSync } from "../sync/useDeviceSync"
import type { useWorkspaceChat } from "../chat/useWorkspaceChat"

type MeshContext = {
  activeWorkspace: { id: string }
  chat: ReturnType<typeof useWorkspaceChat>
  currentRole: Ref<WorkspaceRole>
  currentWorkspaceOwnerId: Ref<string>
  canRepairHistory: ComputedRef<boolean>
  sync: ReturnType<typeof useDeviceSync>
  mergeAuthorizedWorkspace: (id: string, bytes: Uint8Array, authorization: unknown) => Promise<unknown>
}

export function useAppMesh(context: MeshContext) {
  const { activeWorkspace, chat, currentRole, currentWorkspaceOwnerId, canRepairHistory, sync, mergeAuthorizedWorkspace } = context
  const activeMeshPeers = computed(() => sync.meshPeers.value.filter(peer =>
    peer.workspaceId === activeWorkspace.id && peer.deviceId !== sync.localDeviceId.value && !peer.revokedAt,
  ))
  const meshPresence = computed<"connected" | "offline" | "empty">(() => {
    if (sync.isWorkspaceAccessRevoked(activeWorkspace.id)) return "offline"
    if (sync.isWorkspaceLive(activeWorkspace.id) || activeMeshPeers.value.some(peer => peer.online)) return "connected"
    return activeMeshPeers.value.length ? "offline" : "empty"
  })
  const meshPresenceLabel = computed(() => ({
    connected: "Mesh connected",
    offline: "Mesh offline",
    empty: "Mesh empty",
  }[meshPresence.value]))
  const activeMeshRetryAt = computed(() => sync.meshRetryAt.value[activeWorkspace.id])
  const onlineWorkspaceDevices = computed(() => {
    const ids = new Set(sync.meshPeers.value.filter(peer => peer.workspaceId === activeWorkspace.id && !peer.revokedAt && peer.online)
      .map(peer => peer.deviceId))
    if (sync.localDeviceId.value) ids.add(sync.localDeviceId.value)
    return Math.max(1, ids.size)
  })
  const revokingPeer = ref("")
  const peerAccessError = ref("")
  const historyRepairVersion = ref(0)
  const repairableHistory = computed(() => {
    void historyRepairVersion.value
    void sync.meshDiagnostic.value
    return canRepairHistory.value ? pendingHistoryRepair(activeWorkspace.id) : 0
  })
  const meshParticipantDevices = computed(() => sync.meshPeers.value
    .filter(peer => peer.workspaceId === activeWorkspace.id && peer.personId !== chat.personId.value)
    .map(peer => ({ ...peer, name: chat.members.value.find(member => member.personId === peer.personId)?.name ?? `Participant · ${peer.personId.slice(0, 6)}` })))
  const meshMembers = computed(() => {
    const peers = sync.meshPeers.value.filter(peer => peer.workspaceId === activeWorkspace.id && !peer.revokedAt)
    if (!peers.length) return []
    const selfId = chat.personId.value
    const personIds = new Set(peers.map(peer => peer.personId))
    if (selfId) personIds.add(selfId)
    return [...personIds].map(personId => createMeshMember(personId, peers, selfId, sync, chat, currentWorkspaceOwnerId.value, currentRole.value))
      .sort((a, b) => Number(b.self) - Number(a.self) || Number(b.role === "owner") - Number(a.role === "owner") || a.name.localeCompare(b.name))
  })
  const activeSuccession = computed(() => sync.meshSuccession.value.find(item => item.workspaceId === activeWorkspace.id))
  const successionVotesForSelf = computed(() => activeSuccession.value?.votes.filter(vote => vote.candidatePersonId === chat.personId.value).length ?? 0)
  const canClaimSuccession = computed(() => currentRole.value === "editor" && Boolean(activeSuccession.value) && !activeSuccession.value!.conflicted &&
    (activeSuccession.value!.successorPersonId === chat.personId.value || (!activeSuccession.value!.successorPersonId && successionVotesForSelf.value >= activeSuccession.value!.quorum)))
  const transferringOwnership = ref("")

  async function repairHistory() {
    peerAccessError.value = ""
    try {
      const recovered = await repairPendingHistory(activeWorkspace.id, await bootstrapIdentity())
      await mergeAuthorizedWorkspace(activeWorkspace.id, recovered.bytes, recovered.authorization)
      historyRepairVersion.value++
      sync.meshDiagnostic.value = ""
    } catch (error) { peerAccessError.value = error instanceof Error ? error.message : String(error) }
  }
  async function transferWorkspaceOwnership(personId: string) {
    if (transferringOwnership.value) return
    transferringOwnership.value = personId
    peerAccessError.value = ""
    try { await sync.transferOwnership(personId) }
    catch (error) { peerAccessError.value = error instanceof Error ? error.message : "Could not transfer ownership" }
    finally { transferringOwnership.value = "" }
  }
  const meshAction = (action: () => Promise<void>, message: string) => async () => {
    peerAccessError.value = ""
    try { await action() }
    catch (error) { peerAccessError.value = error instanceof Error ? error.message : message }
  }
  const promoteWorkspacePeer = (personId: string) => meshAction(() => sync.promotePeer(personId), "Could not promote member")()
  const leaveWorkspaceMesh = meshAction(() => sync.leaveMesh(), "Could not leave mesh")
  const claimWorkspaceSuccession = meshAction(() => sync.claimSuccession(), "Could not claim ownership")
  const setWorkspaceSuccessor = (personId: string | null) => meshAction(() => sync.setSuccessor(personId), "Could not set successor")()
  const voteForWorkspaceSuccessor = (personId: string) => meshAction(() => sync.voteForSuccessor(personId), "Could not record vote")()
  async function revokeWorkspacePeer(personId: string) {
    if (revokingPeer.value) return
    revokingPeer.value = personId
    peerAccessError.value = ""
    try { await sync.revokePeer(personId) }
    catch (error) { peerAccessError.value = error instanceof Error ? error.message : "Could not revoke access" }
    finally { revokingPeer.value = "" }
  }
  return { promoteWorkspacePeer, meshPresence, meshPresenceLabel, activeMeshRetryAt, onlineWorkspaceDevices, revokingPeer, peerAccessError, repairableHistory, repairHistory, meshParticipantDevices, meshMembers, activeSuccession, canClaimSuccession, transferringOwnership, transferWorkspaceOwnership, leaveWorkspaceMesh, setWorkspaceSuccessor, voteForWorkspaceSuccessor, claimWorkspaceSuccession, revokeWorkspacePeer }
}

function createMeshMember(personId: string, peers: ReturnType<typeof useDeviceSync>["meshPeers"]["value"], selfId: string, sync: ReturnType<typeof useDeviceSync>, chat: ReturnType<typeof useWorkspaceChat>, ownerId: string, currentRole: WorkspaceRole) {
  const devices = peers.filter(peer => peer.personId === personId)
  const self = personId === selfId
  const localUserAgent = sync.localUserAgent.value || undefined
  const deviceList = devices.map(peer => ({
    deviceId: peer.deviceId, name: peer.deviceName || `Device ${peer.deviceId.slice(0, 6)}`,
    online: peer.online || (self && peer.deviceId === sync.localDeviceId.value), lastSeen: peer.lastSeen,
    userAgent: peer.userAgent || (self && peer.deviceId === sync.localDeviceId.value ? localUserAgent : undefined),
    description: describeUserAgent(peer.userAgent || (self && peer.deviceId === sync.localDeviceId.value ? localUserAgent : undefined)), tabs: peer.instances ?? 1,
  }))
  if (self && sync.localDeviceId.value && !deviceList.some(device => device.deviceId === sync.localDeviceId.value)) deviceList.push({ deviceId: sync.localDeviceId.value, name: "This device", online: true, lastSeen: new Date().toISOString(), userAgent: localUserAgent, description: describeUserAgent(localUserAgent), tabs: 1 })
  const peerRole = devices[0]?.role ?? "visitor"
  return { personId, name: self ? chat.displayName.value || "You" : chat.members.value.find(member => member.personId === personId)?.name ?? `Participant · ${personId.slice(0, 6)}`, role: self ? currentRole : personId === ownerId ? "owner" as const : peerRole === "owner" ? "editor" as const : peerRole, online: deviceList.some(device => device.online), onlineDevices: deviceList.filter(device => device.online).length, devices: deviceList.length, deviceList, self }
}
