import { ref, type Ref } from "vue"
import { parseInvitation, type ScopedInvitation } from "@meta-uber/mesh-pairing"
import { irohTransport } from "./irohTransport"
import { deriveTranscriptAuthCode } from "./invitations"
import { bootstrapIdentity, type LocalProfile } from "../domain/identity"
import type { SyncNode, SyncTransport } from "./transport"
import { type LiveWorkspaceSync, type WorkspaceReplica, type WorkspaceSetStore } from "./workspaceSet"
import type { DurableMesh, DurableMeshOptions, MeshPeerView, MeshSuccessionView } from "./durableMesh"
import { createDeviceSyncState, userMessage } from "./deviceSyncState"
import { requestDeviceEnrollment, selectDeviceEnrollment } from "./deviceSyncEnrollment"
import { acceptWorkspaceInvitation } from "./deviceSyncWorkspaceGuest"
import { generateWorkspaceInvite as generateHostInvite } from "./deviceSyncHost"
import type { BlobDescriptor } from "@meta-uber/mesh-blob"

export type DeviceSyncOptions = {
  workspace: WorkspaceReplica
  workspaceStore?: WorkspaceSetStore
  origin: () => string
  transport?: SyncTransport
  availableWorkspaces?: Ref<{ id: string; title: string }[]>
  activeWorkspaceId?: () => string
  displayName?: () => string
  identityChanged?: () => Promise<void>
  workspaceOwner?: (id: string) => Promise<string>
}

export function createDeviceSyncController(options: DeviceSyncOptions) {
  return new DeviceSyncController(options).api()
}

class DeviceSyncController {
  private readonly state = createDeviceSyncState()
  private readonly workspace: WorkspaceReplica
  private readonly workspaceStore?: WorkspaceSetStore
  private readonly meshWorkspaceStore?: WorkspaceSetStore
  private readonly origin: () => string
  private readonly transport: SyncTransport
  private readonly availableWorkspaces: Ref<{ id: string; title: string }[]>
  private readonly activeWorkspaceId?: () => string
  private readonly workspaceOwner?: (id: string) => Promise<string>
  private readonly displayName?: () => string
  private readonly identityChanged?: () => Promise<void>
  private readonly joinDecisions = new Map<string, (role: "visitor" | "editor" | null) => void>()
  private readonly leavingWorkspaceIds = new Set<string>()
  private readonly directPeerSessions = new Map<string, LiveWorkspaceSync>()
  private readonly markNetworkOnline = () => { this.state.networkOnline.value = true }
  private readonly markNetworkOffline = () => { this.state.networkOnline.value = false }
  private node: SyncNode | undefined
  private liveSession: LiveWorkspaceSync | undefined
  private stopWatchingWorkspace: (() => void) | undefined
  private run = 0
  private wakeRetry: (() => void) | undefined
  private approveResolve: ((approved: boolean) => void) | undefined
  private durableMesh?: DurableMesh
  private durableMeshPromise?: Promise<DurableMesh | undefined>

  constructor(options: DeviceSyncOptions) {
    this.workspace = options.workspace
    this.workspaceStore = options.workspaceStore
    this.origin = options.origin
    this.transport = options.transport ?? irohTransport
    this.availableWorkspaces = options.availableWorkspaces ?? ref([])
    this.activeWorkspaceId = options.activeWorkspaceId
    this.workspaceOwner = options.workspaceOwner
    this.displayName = options.displayName
    this.identityChanged = options.identityChanged
    this.meshWorkspaceStore = this.workspaceStore ? { ...this.workspaceStore } : undefined
    if (typeof window !== "undefined") this.listenForNetworkChanges()
  }

  private async ensureDurableMesh(): Promise<DurableMesh | undefined> {
    if (this.durableMesh) return this.durableMesh
    const store = this.meshWorkspaceStore
    if (!this.workspaceStore || !store) return undefined
    if (!this.durableMeshPromise) {
      this.durableMeshPromise = import("./durableMesh").then(({ DurableMesh }) => {
        if (this.durableMesh) return this.durableMesh
        this.durableMesh = new DurableMesh(this.meshOptions(store))
        this.attachMeshStore()
        return this.durableMesh
      }).catch(error => {
        this.durableMeshPromise = undefined
        throw error
      })
    }
    return this.durableMeshPromise
  }

  private meshOptions(store: WorkspaceSetStore): DurableMeshOptions {
    return {
      transport: this.transport, workspaceStore: store, workspace: this.workspace,
      getProfile: () => this.getProfile(),
      onChange: (ids, peers, revoked, succession) => this.updateMeshState(ids, peers, revoked, succession),
      onDiagnostic: message => { this.state.meshDiagnostic.value = message },
      onRetryChange: retryAtByWorkspace => { this.state.meshRetryAt.value = retryAtByWorkspace },
      networkOnline: () => this.state.networkOnline.value,
      getOwnedWorkspaceIds: () => this.getOwnedWorkspaceIds(),
    }
  }

  private updateMeshState(ids: string[], peers: MeshPeerView[], revoked: string[], succession: MeshSuccessionView[]) {
    this.state.meshLiveWorkspaceIds.value = [...new Set(ids)].filter(id => !this.leavingWorkspaceIds.has(id))
    this.state.meshPeers.value = peers.filter(peer => !this.leavingWorkspaceIds.has(peer.workspaceId))
    this.state.revokedWorkspaceIds.value = revoked.filter(id => !this.leavingWorkspaceIds.has(id))
    this.state.meshSuccession.value = succession.filter(item => !this.leavingWorkspaceIds.has(item.workspaceId))
    this.state.ownershipRevision.value += 1
    if (ids.length > 0 && this.state.step.value === "workspace-reconnecting") this.state.step.value = "members"
  }

  private attachMeshStore() {
    this.meshWorkspaceStore!.readMesh = id => this.durableMesh!.exportWorkspace(id)
    this.meshWorkspaceStore!.mergeMesh = (id, value) => this.durableMesh!.mergeWorkspace(id, value)
  }

  private listenForNetworkChanges() {
    window.addEventListener("online", this.markNetworkOnline)
    window.addEventListener("offline", this.markNetworkOffline)
  }

  private async getOwnedWorkspaceIds() {
    if (!this.workspaceOwner) return []
    const profile = await this.getProfile()
    const result: string[] = []
    for (const workspace of this.availableWorkspaces.value) {
      if (await this.workspaceOwner(workspace.id) === profile.identity.personId) result.push(workspace.id)
    }
    return result
  }

  private decideJoin(id: string, approve: boolean) {
    const request = this.state.pendingJoins.value.find(item => item.id === id)
    this.joinDecisions.get(id)?.(approve ? request?.role ?? "visitor" : null)
    this.joinDecisions.delete(id)
    this.state.pendingJoins.value = this.state.pendingJoins.value.filter(item => item.id !== id)
  }

  private async stopNode(reason: string) {
    this.approveResolve?.(false)
    this.approveResolve = undefined
    for (const resolve of this.joinDecisions.values()) resolve(null)
    this.joinDecisions.clear()
    this.state.pendingJoins.value = []
    this.stopWatchingWorkspace?.()
    this.stopWatchingWorkspace = undefined
    const session = this.liveSession
    this.liveSession = undefined
    this.state.directLive.value = false
    this.state.liveWorkspaceIds.value = []
    await session?.close()
    const current = this.node
    this.node = undefined
    await current?.close(reason).catch(() => {})
  }

  private async pauseDurableMesh() { await this.durableMesh?.pauseAll() }

  private async startDurableMesh(adoptedNode?: SyncNode) {
    const mesh = await this.ensureDurableMesh()
    this.state.revokedWorkspaceIds.value = await mesh?.revokedWorkspaceIds() ?? []
    await mesh?.resumeAll(adoptedNode)
  }

  private async handoffDirectNode(reason: string) {
    const adoptedNode = this.node
    this.node = undefined
    await this.stopNode(reason)
    await this.startDurableMesh(adoptedNode)
  }

  private async addOwnerWorkspace(workspaceId: string) {
    await (await this.ensureDurableMesh())?.addOwnerWorkspace(workspaceId)
  }

  private async fetchBlob(workspaceId: string, descriptor: BlobDescriptor): Promise<Uint8Array | undefined> {
    return (await this.ensureDurableMesh())?.fetchBlob(workspaceId, descriptor)
  }

  private async shutdown() {
    this.run += 1
    this.wakeRetry?.()
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.markNetworkOnline)
      window.removeEventListener("offline", this.markNetworkOffline)
    }
    await (this.durableMesh ?? await this.durableMeshPromise)?.dispose()
    await this.stopNode("Page closed")
  }

  private async revokePeer(personId: string) {
    const workspaceId = this.activeWorkspaceId?.()
    if (!workspaceId) throw new Error("No active workspace")
    await (await this.ensureDurableMesh())?.revokePerson(workspaceId, personId)
    await this.liveSession?.publish().catch(() => {})
    const direct = this.directPeerSessions.get(personId)
    this.directPeerSessions.delete(personId)
    await direct?.close()
  }

  private async withActiveWorkspace(action: (workspaceId: string, mesh: DurableMesh) => Promise<void>, changeOwnership = false) {
    const workspaceId = this.activeWorkspaceId?.()
    const mesh = await this.ensureDurableMesh()
    if (!workspaceId || !mesh) throw new Error("No active workspace")
    await action(workspaceId, mesh)
    if (changeOwnership) this.state.ownershipRevision.value += 1
  }

  private async leaveMesh() {
    const workspaceId = this.activeWorkspaceId?.()
    const mesh = await this.ensureDurableMesh()
    if (!workspaceId || !mesh) throw new Error("No active workspace")
    this.run += 1
    this.wakeRetry?.()
    this.beforeLeaveWorkspace(workspaceId)
    try {
      await this.pauseDurableMesh()
      await this.stopNode("Leaving workspace mesh")
      for (const session of this.directPeerSessions.values()) await session.close().catch(() => {})
      this.directPeerSessions.clear()
      await mesh.leaveWorkspace(workspaceId)
      void this.startDurableMesh()
    } finally { this.leavingWorkspaceIds.delete(workspaceId) }
  }

  private async leaveWorkspace(workspaceId: string) {
    if (workspaceId === this.activeWorkspaceId?.()) {
      await this.leaveMesh()
      return
    }
    const mesh = await this.ensureDurableMesh()
    if (!mesh) throw new Error("Mesh unavailable")
    this.beforeLeaveWorkspace(workspaceId)
    try { await mesh.leaveWorkspace(workspaceId) }
    finally { this.leavingWorkspaceIds.delete(workspaceId) }
  }

  private beforeLeaveWorkspace(workspaceId: string) {
    this.leavingWorkspaceIds.add(workspaceId)
    this.state.directLive.value = false
    this.state.liveWorkspaceIds.value = this.state.liveWorkspaceIds.value.filter(id => id !== workspaceId)
    this.state.meshLiveWorkspaceIds.value = this.state.meshLiveWorkspaceIds.value.filter(id => id !== workspaceId)
    this.state.meshPeers.value = this.state.meshPeers.value.filter(peer => peer.workspaceId !== workspaceId)
    this.state.revokedWorkspaceIds.value = this.state.revokedWorkspaceIds.value.filter(id => id !== workspaceId)
    this.state.meshDiagnostic.value = ""
    this.state.ownershipRevision.value += 1
    this.state.step.value = "members"
  }

  private attachLiveSession(session: LiveWorkspaceSync, currentRun: number) {
    this.liveSession = session
    this.state.directLive.value = true
    this.stopWatchingWorkspace = this.workspace.subscribe?.(() => { void this.publishLiveSession(session, currentRun) })
    void session.done.catch(syncError => this.liveSessionFailed(syncError, currentRun))
  }

  private async publishLiveSession(session: LiveWorkspaceSync, currentRun: number) {
    try { await session.publish() } catch (syncError) { this.liveSessionFailed(syncError, currentRun) }
  }

  private liveSessionFailed(syncError: unknown, currentRun: number) {
    if (currentRun !== this.run) return
    console.error("Match live sync failed", syncError)
    this.state.step.value = "error"
    this.state.error.value = "Live sync stopped. Pair again."
    void this.stopNode("Live sync failed")
  }

  private detachLiveSession(session: LiveWorkspaceSync) {
    this.stopWatchingWorkspace?.()
    this.stopWatchingWorkspace = undefined
    if (this.liveSession === session) this.liveSession = undefined
    this.state.directLive.value = false
  }

  private async close() {
    this.run += 1
    this.wakeRetry?.()
    this.state.isOpen.value = false
    this.state.step.value = "idle"
    this.state.qrCode.value = ""
    this.state.inviteUrl.value = ""
    this.state.copyNotice.value = ""
    this.state.error.value = ""
    this.state.authCode.value = ""
    this.state.parsedInvite.value = null
    await this.handoffDirectNode("Pairing closed")
  }

  private async dismiss() {
    if (this.state.step.value !== "error") { this.state.isOpen.value = false; return }
    this.clearPairingLocation()
    await this.close()
  }

  private open() {
    if (["workspace-reconnecting", "workspace-guest-waiting", "enroll-host-pending", "enroll-guest-waiting", "enroll-syncing"].includes(this.state.step.value)) {
      this.state.isOpen.value = true
      return
    }
    this.state.isOpen.value = true
    this.state.step.value = "members"
    this.state.error.value = ""
    this.state.copyNotice.value = ""
    this.state.localUserAgent.value = typeof navigator !== "undefined" ? navigator.userAgent : ""
    this.selectActiveWorkspace()
  }

  private selectActiveWorkspace() {
    const active = this.activeWorkspaceId?.() || this.availableWorkspaces.value[0]?.id
    this.state.selectedWorkspaceIds.value = active ? [active] : []
    this.state.selectedWorkspaceId.value = active ?? ""
  }

  private async getProfile(): Promise<LocalProfile> {
    const profile = await bootstrapIdentity("My Device")
    this.state.localDeviceId.value = profile.device.deviceId
    this.state.localUserAgent.value = typeof navigator !== "undefined" ? navigator.userAgent : ""
    return profile
  }

  private enrollmentContext(): Parameters<typeof selectDeviceEnrollment>[0] {
    return {
      state: this.state, workspaceStore: this.workspaceStore, meshWorkspaceStore: this.meshWorkspaceStore,
      durableMesh: this.durableMesh, availableWorkspaces: this.availableWorkspaces.value,
      activeWorkspaceId: this.activeWorkspaceId, workspaceOwner: this.workspaceOwner, origin: this.origin,
      transport: this.transport, getProfile: () => this.getProfile(), nextRun: () => ++this.run,
      currentRun: () => this.run, pauseMesh: () => this.pauseDurableMesh(), stopNode: reason => this.stopNode(reason),
      setNode: node => { this.node = node }, handoffNode: reason => this.handoffDirectNode(reason),
      identityChanged: this.identityChanged, waitToReconnect: milliseconds => this.waitToReconnect(milliseconds),
      setApprovalResolver: resolve => { this.approveResolve = resolve }, denyPendingApproval: () => this.approveResolve?.(false),
    }
  }

  private async selectSyncAll() {
    await this.ensureDurableMesh()
    await selectDeviceEnrollment(this.enrollmentContext())
  }

  private selectSyncWorkspace() {
    this.state.step.value = "workspace-select"
    if (this.availableWorkspaces.value.length && this.state.selectedWorkspaceIds.value.length === 0) {
      this.state.selectedWorkspaceIds.value = [this.availableWorkspaces.value[0].id]
    }
  }

  private async generateWorkspaceInvite() {
    await this.ensureDurableMesh()
    await generateHostInvite({
      state: this.state, workspace: this.workspace, workspaceStore: this.workspaceStore, meshWorkspaceStore: this.meshWorkspaceStore,
      durableMesh: this.durableMesh, availableWorkspaces: this.availableWorkspaces.value, workspaceOwner: this.workspaceOwner,
      origin: this.origin, transport: this.transport, getProfile: () => this.getProfile(), nextRun: () => ++this.run,
      currentRun: () => this.run, pauseMesh: () => this.pauseDurableMesh(), stopNode: reason => this.stopNode(reason),
      startMesh: node => this.startDurableMesh(node), setNode: node => { this.node = node }, getNode: () => this.node,
      attachLiveSession: (session, run) => this.attachLiveSession(session, run), detachLiveSession: session => this.detachLiveSession(session),
      waitForJoinDecision: (personId, name) => this.waitForJoinDecision(personId, name),
      replaceDirectSession: (personId, session) => this.replaceDirectSession(personId, session),
      removeDirectSession: (personId, session) => this.removeDirectSession(personId, session),
    })
  }

  private waitForJoinDecision(personId: string, name: string) {
    const requestId = crypto.randomUUID()
    this.state.pendingJoins.value.push({ id: requestId, personId, name, role: "visitor" })
    this.state.isOpen.value = true
    this.state.step.value = "workspace-host"
    return new Promise<"visitor" | "editor" | null>(resolve => {
      const timer = setTimeout(() => this.decideJoin(requestId, false), 600_000)
      this.joinDecisions.set(requestId, value => { clearTimeout(timer); resolve(value) })
    })
  }

  private replaceDirectSession(personId: string, session: LiveWorkspaceSync) {
    const previous = this.directPeerSessions.get(personId)
    this.directPeerSessions.set(personId, session)
    return previous
  }

  private removeDirectSession(personId: string, session: LiveWorkspaceSync) {
    if (this.directPeerSessions.get(personId) === session) this.directPeerSessions.delete(personId)
  }

  private approveEnrollment() {
    if (this.state.step.value !== "enroll-host-pending") return
    this.approveResolve?.(true)
    this.approveResolve = undefined
  }

  private declineEnrollment() {
    this.approveResolve?.(false)
    this.approveResolve = undefined
  }

  private async prepareJoin(rawInvite: string) {
    await this.close()
    this.state.isOpen.value = true
    try {
      const saved = this.savedWorkspaceInvite(rawInvite)
      if (saved && await this.reopenSavedWorkspace(saved)) return
      const invite = parseInvitation(rawInvite)
      this.state.parsedInvite.value = invite
      await this.showInviteStep(invite)
    } catch (err) {
      this.state.step.value = "error"
      this.state.error.value = userMessage(err, "This pairing link is invalid.")
    }
  }

  private savedWorkspaceInvite(rawInvite: string) {
    try {
      const invite = parseInvitation(rawInvite, Number.NEGATIVE_INFINITY)
      return invite.kind === "workspace-join" ? invite : undefined
    } catch { return undefined }
  }

  private async reopenSavedWorkspace(invite: Extract<ScopedInvitation, { kind: "workspace-join" }>) {
    const ids = invite.workspaces.map(item => item.id)
    const local = ids.every(id => this.availableWorkspaces.value.some(item => item.id === id))
    const known = await (await this.ensureDurableMesh())?.knowsWorkspaceIssuer(
      ids,
      invite.issuerPersonId,
      invite.issuerDeviceId,
    )
    if (!local || !known) return false
    await this.workspaceStore?.activate(ids[0]!)
    this.clearPairingLocation()
    this.state.isOpen.value = false
    await this.startDurableMesh()
    return true
  }

  private async showInviteStep(invite: ScopedInvitation) {
    if (invite.kind === "device-enrollment") {
      this.state.step.value = "enroll-guest"
      this.state.authCode.value = await deriveTranscriptAuthCode(invite.secret, invite.invitationId, invite.issuerPublicKey)
      return
    }
    if (invite.kind !== "workspace-join") return
    this.state.invitationWorkspaces.value = invite.workspaces || [{ id: invite.workspaceId, title: invite.workspaceTitle }]
    this.state.invitationWorkspaceTitle.value = this.state.invitationWorkspaces.value.map(item => item.title).join(", ")
    const local = this.state.invitationWorkspaces.value.some(item => this.availableWorkspaces.value.some(workspace => workspace.id === item.id))
    this.state.step.value = local ? "workspace-merge-confirm" : "workspace-guest"
  }

  private clearPairingLocation() {
    if (typeof window === "undefined") return
    const url = new URL(window.location.href)
    if (url.pathname.replace(/\/$/, "") !== "/pair") return
    url.pathname = "/"
    url.hash = ""
    window.history.replaceState(window.history.state, "", url)
  }

  private async requestEnrollment() {
    const invite = this.state.parsedInvite.value
    if (!invite || invite.kind !== "device-enrollment" || this.state.step.value !== "enroll-guest") return
    await this.ensureDurableMesh()
    await requestDeviceEnrollment(this.enrollmentContext(), invite)
  }

  private async waitToReconnect(milliseconds: number) {
    await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(timer)
        window.removeEventListener("online", finish)
        if (this.wakeRetry === finish) this.wakeRetry = undefined
        resolve()
      }
      const timer = setTimeout(finish, milliseconds)
      this.wakeRetry = finish
      window.addEventListener("online", finish, { once: true })
    })
  }

  private async acceptWorkspaceJoin() {
    const invite = this.state.parsedInvite.value
    if (!invite || invite.kind !== "workspace-join" || this.state.step.value === "workspace-guest-waiting") return
    await this.ensureDurableMesh()
    await acceptWorkspaceInvitation({
      state: this.state, workspace: this.workspace, workspaceStore: this.workspaceStore, meshWorkspaceStore: this.meshWorkspaceStore,
      durableMesh: this.durableMesh, transport: this.transport, getProfile: () => this.getProfile(), displayName: this.displayName,
      nextRun: () => ++this.run, currentRun: () => this.run, pauseMesh: () => this.pauseDurableMesh(),
      waitToReconnect: milliseconds => this.waitToReconnect(milliseconds), setNode: node => { this.node = node },
      setLiveSession: session => { this.liveSession = session }, setStopWatching: stop => { this.stopWatchingWorkspace = stop },
      clearPairingLocation: () => this.clearPairingLocation(),
    }, invite)
  }

  private joinFromLocation(rawUrl: string) {
    const url = new URL(rawUrl)
    if (url.pathname.replace(/\/$/, "") !== "/pair" || !url.hash) return false
    void this.prepareJoin(rawUrl)
    return true
  }

  private async copyInvite(targetUrl?: string) {
    const url = targetUrl || this.state.inviteUrl.value
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      this.state.copyNotice.value = "Pairing link copied."
    } catch { this.state.copyNotice.value = "Clipboard unavailable. Select the pairing link and copy it manually." }
  }

  api() {
    const state = this.state
    return {
      isOpen: state.isOpen, pendingJoins: state.pendingJoins, decideJoin: (id: string, approve: boolean) => this.decideJoin(id, approve),
      isLive: state.isLive, isWorkspaceLive: (id: string) => (state.directLive.value && state.liveWorkspaceIds.value.includes(id)) || state.meshLiveWorkspaceIds.value.includes(id),
      isWorkspaceAccessRevoked: (id: string) => state.revokedWorkspaceIds.value.includes(id), meshPeers: state.meshPeers, meshDiagnostic: state.meshDiagnostic,
      meshRetryAt: state.meshRetryAt, networkOnline: state.networkOnline, meshSuccession: state.meshSuccession, localDeviceId: state.localDeviceId,
      localUserAgent: state.localUserAgent, ownershipRevision: state.ownershipRevision, step: state.step, phase: state.phase, title: state.title,
      qrCode: state.qrCode, inviteUrl: state.inviteUrl, copyNotice: state.copyNotice, error: state.error, authCode: state.authCode,
      selectedWorkspaceId: state.selectedWorkspaceId, selectedWorkspaceIds: state.selectedWorkspaceIds, invitationWorkspaceTitle: state.invitationWorkspaceTitle,
      invitationWorkspaces: state.invitationWorkspaces, availableWorkspaces: this.availableWorkspaces, open: () => this.open(),
      selectSyncAll: () => this.selectSyncAll(), selectSyncWorkspace: () => this.selectSyncWorkspace(), generateWorkspaceInvite: () => this.generateWorkspaceInvite(),
      approveEnrollment: () => this.approveEnrollment(), declineEnrollment: () => this.declineEnrollment(), enrollmentDeviceName: state.enrollmentDeviceName,
      requestEnrollment: () => this.requestEnrollment(), acceptWorkspaceJoin: () => this.acceptWorkspaceJoin(), prepareJoin: (raw: string) => this.prepareJoin(raw),
      joinFromLocation: (raw: string) => this.joinFromLocation(raw), startDurableMesh: () => this.startDurableMesh(), addOwnerWorkspace: (id: string) => this.addOwnerWorkspace(id),
      fetchBlob: (workspaceId: string, descriptor: BlobDescriptor) => this.fetchBlob(workspaceId, descriptor),
      shutdown: () => this.shutdown(), revokePeer: (personId: string) => this.revokePeer(personId),
      transferOwnership: (personId: string) => this.withActiveWorkspace((id, mesh) => mesh.transferOwnership(id, personId), true),
      setSuccessor: (personId: string | null) => this.withActiveWorkspace((id, mesh) => mesh.setSuccessor(id, personId)),
      voteForSuccessor: (personId: string) => this.withActiveWorkspace((id, mesh) => mesh.voteForSuccessor(id, personId)),
      claimSuccession: () => this.withActiveWorkspace((id, mesh) => mesh.claimSuccession(id), true),
      breakGlassOwnership: () => this.withActiveWorkspace((id, mesh) => mesh.breakGlassOwnership(id), true),
      leaveMesh: () => this.leaveMesh(), leaveWorkspace: (workspaceId: string) => this.leaveWorkspace(workspaceId),
      copyInvite: (target?: string) => this.copyInvite(target), close: () => this.close(), dismiss: () => this.dismiss(),
    }
  }
}
