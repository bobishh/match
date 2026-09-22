import {
  createPairingSecret,
  createWorkspaceJoinInvite,
  inspectPairingFrame,
  invitationUrl,
  type WorkspaceJoinInvitation,
} from "@meta-uber/mesh-pairing"
import { defaultInvitationService } from "./invitations"
import type { LocalProfile } from "../domain/identity"
import type { WorkspaceGrant } from "../domain/model"
import { toBase64Url } from "../domain/identity"
import { defaultProofStore } from "../domain/proofs"
import { isMeshNetworkFailure, meshNetworkConnection, startMeshHeartbeat } from "@meta-uber/mesh-transport"
import { BrowserWorkspaceJoinHandoffHost, BrowserWorkspaceJoinHost } from "@meta-uber/mesh-runtime"
import { WasmWorkspaceJoinHandshake, WasmWorkspaceJoinHandoff } from "../iroh"
import type { SyncAcceptor, SyncConnection, SyncNode } from "./transport"
import type { WorkspaceReplica } from "./workspaceSet"
import { liveWorkspaceSetSync, workspaceSet, type LiveWorkspaceSync } from "./workspaceSet"
import { startPersistentNode } from "./persistentNode"
import { userMessage } from "./deviceSyncState"
import { showInviteQr } from "./deviceSyncInviteView"
import type { PairingContext } from "./deviceSyncContext"

type WorkspaceOption = { id: string; title: string }

export type WorkspaceHostContext = PairingContext & {
  workspace: WorkspaceReplica
  startMesh: (node?: SyncNode) => Promise<void>
  setNode: (node: SyncNode | undefined) => void
  getNode: () => SyncNode | undefined
  attachLiveSession: (session: LiveWorkspaceSync, run: number) => void
  detachLiveSession: (session: LiveWorkspaceSync) => void
  waitForJoinDecision: (personId: string, displayName: string) => Promise<"visitor" | "editor" | null>
  replaceDirectSession: (personId: string, session: LiveWorkspaceSync) => LiveWorkspaceSync | undefined
  removeDirectSession: (personId: string, session: LiveWorkspaceSync) => void
}

export async function generateWorkspaceInvite(context: WorkspaceHostContext) {
  if (context.state.selectedWorkspaceIds.value.length === 0) return
  try {
    await createWorkspaceHost(context)
  } catch (err) {
    console.error("generateWorkspaceInvite failed", err)
    context.state.step.value = "error"
    context.state.error.value = userMessage(err, "Couldn’t generate invite.")
  }
}

async function createWorkspaceHost(context: WorkspaceHostContext) {
  const profile = await context.getProfile()
  const workspaces = selectedWorkspaces(context)
  const owners = await workspaceOwners(context, workspaces, profile)
  await context.pauseMesh()
  await context.stopNode("Starting workspace host")
  const run = context.nextRun()
  clearHostNotice(context)
  const node = await startPersistentNode(context.transport)
  if (run !== context.currentRun()) return void node.close("Replaced")
  context.setNode(node)
  await context.durableMesh?.ensureOwnerWorkspaces(workspaces.map(item => item.id), node.endpointId, profile)
  const invite = await createHostInvite(context, node, profile, workspaces)
  if (!context.workspaceStore) throw new Error("Workspace sync is unavailable.")
  const replica = workspaceSet(context.meshWorkspaceStore ?? context.workspaceStore, workspaces)
  context.state.liveWorkspaceIds.value = workspaces.map(item => item.id)
  await startWorkspaceHostController({ context, run, node, profile, invite, owners, workspaces, replica })
}

function selectedWorkspaces(context: WorkspaceHostContext) {
  const selected = context.state.selectedWorkspaceIds.value
  const available = context.availableWorkspaces.filter(item => selected.includes(item.id))
  return available.length > 0 ? available : selected.map(id => ({ id, title: "Workspace" }))
}

async function workspaceOwners(context: WorkspaceHostContext, workspaces: WorkspaceOption[], profile: LocalProfile) {
  const owners = new Map<string, string>()
  for (const workspace of workspaces) {
    const owner = context.workspaceOwner ? await context.workspaceOwner(workspace.id) : profile.identity.personId
    if (owner !== profile.identity.personId) throw new Error(`Only the workspace owner can invite peers to ${workspace.title}`)
    owners.set(workspace.id, owner)
  }
  return owners
}

function clearHostNotice(context: WorkspaceHostContext) {
  context.state.copyNotice.value = ""
  context.state.error.value = ""
}

async function createHostInvite(context: WorkspaceHostContext, node: SyncNode, profile: LocalProfile, workspaces: WorkspaceOption[]) {
  const secret = createPairingSecret()
  const invite = createWorkspaceJoinInvite(node.endpointId, secret, profile, workspaces)
  await defaultInvitationService.saveIssuedInvitation(invite)
  await showInviteQr(context.state, invitationUrl(context.origin(), invite))
  context.state.step.value = "workspace-host"
  return invite
}

type HostInput = {
  context: WorkspaceHostContext
  run: number
  node: SyncNode
  profile: LocalProfile
  invite: WorkspaceJoinInvitation
  owners: Map<string, string>
  workspaces: WorkspaceOption[]
  replica: ReturnType<typeof workspaceSet>
}
type HostRuntime = HostInput & {
  acceptor: SyncAcceptor
  peers: Map<string, LiveWorkspaceSync>
  connections: Set<SyncConnection>
  grants: Map<string, { ok: true; grants: WorkspaceGrant[] }>
  group: LiveWorkspaceSync
  stopped: () => boolean
  disconnect: () => void
  handoff: () => Promise<void>
  fail: (error: unknown) => void
}

async function startWorkspaceHostController(input: HostInput) {
  const acceptor = await input.node.accept()
  const peers = new Map<string, LiveWorkspaceSync>()
  const connections = new Set<SyncConnection>()
  const grants = new Map<string, { ok: true; grants: WorkspaceGrant[] }>()
  let stopped = false
  let everConnected = false
  let handoffStarted = false
  let handoffPromise: Promise<void> | undefined
  let fail!: (error: unknown) => void
  const done = new Promise<void>((_, reject) => { fail = reject })
  const offline = () => { for (const connection of connections) void connection.close() }
  window.addEventListener("offline", offline)
  const handoff = () => handoffPromise ??= handoffWorkspaceHost()
  const disconnect = () => {
    if (input.run !== input.context.currentRun() || stopped || peers.size) return
    input.context.state.directLive.value = false
    if (!everConnected) return
    input.context.state.step.value = "workspace-reconnecting"
    if (handoffStarted) return
    handoffStarted = true
    void handoffDisconnectedPeer(input)
  }
  const group = createHostGroup(done, peers, connections, acceptor, () => { stopped = true }, offline)
  const runtime = (): HostRuntime => ({ ...input, acceptor, peers, connections, grants, group, stopped: () => stopped, disconnect, handoff, fail })
  input.context.attachLiveSession(group, input.run)
  input.context.state.directLive.value = false
  void acceptHostPeers(runtime(), () => { everConnected = true }).catch(fail)

  async function handoffWorkspaceHost() {
    handoffStarted = true
    stopped = true
    window.removeEventListener("offline", offline)
    await acceptor.close().catch(() => {})
    input.context.detachLiveSession(group)
    const adoptedNode = input.context.getNode()
    input.context.setNode(undefined)
    await input.context.startMesh(adoptedNode)
    await input.context.durableMesh?.waitUntilListening()
  }
}

function createHostGroup(done: Promise<void>, peers: Map<string, LiveWorkspaceSync>, connections: Set<SyncConnection>, acceptor: SyncAcceptor, stop: () => void, offline: () => void): LiveWorkspaceSync {
  return {
    done,
    async publish() { await Promise.all([...peers.values()].map(session => publishPeer(session))) },
    async close() {
      stop()
      window.removeEventListener("offline", offline)
      await acceptor.close()
      await Promise.all([...connections].map(connection => connection.close()))
    },
  }
}

async function publishPeer(session: LiveWorkspaceSync) {
  try { await session.publish() } catch (error) {
    await session.close()
    if (!isMeshNetworkFailure(error)) throw error
  }
}

async function handoffDisconnectedPeer(input: HostInput) {
  const adoptedNode = input.context.getNode()
  input.context.setNode(undefined)
  await input.context.stopNode("Invitation peer disconnected")
  if (input.run === input.context.currentRun()) await input.context.startMesh(adoptedNode)
  else await adoptedNode?.close("Invitation superseded").catch(() => {})
}

async function acceptHostPeers(runtime: HostRuntime, connected: () => void) {
  while (!runtime.stopped() && runtime.run === runtime.context.currentRun()) {
    const connection = await runtime.acceptor.accept()
    if (!connection) return
    void receivePeer(runtime, meshNetworkConnection(connection), connected).catch(runtime.fail)
  }
}

async function receivePeer(runtime: HostRuntime, connection: SyncConnection, connected: () => void) {
  let session: LiveWorkspaceSync | undefined
  let heartbeat: (() => void) | undefined
  let personId = ""
  const timeout = setTimeout(() => { void connection.close() }, 600_000)
  runtime.connections.add(connection)
  try {
    const stream = await connection.acceptStream()
    const rawRequest = await stream.read()
    if (await receiveMeshPeer(runtime, connection, stream, rawRequest)) return
    const header = inspectPairingFrame(rawRequest)
    if (header.type !== "workspace-join-request" || header.secret !== runtime.invite.secret) return
    const handshake = new BrowserWorkspaceJoinHost(new WasmWorkspaceJoinHandshake(runtime.invite.secret, "host"))
    const result = await handshake.handle(rawRequest, stream, connection, {
      request: payload => readWorkspaceRequest(runtime, payload),
      approve: guest => approveWorkspaceAccess(runtime, guest),
      prepare: result => prepareWorkspaceAccess(runtime, result),
      acknowledged: payload => runtime.replica.receive(payload),
    })
    if (result.kind !== "accepted" || !("value" in result)) return
    personId = result.value.personId
    clearTimeout(timeout)
    session = await startPeerSession(runtime, connection, personId)
    heartbeat = startMeshHeartbeat(session, () => { void session?.close() })
    connected()
    await runtime.group.publish()
    await session.done
  } catch (error) {
    if (!runtime.stopped() && runtime.run === runtime.context.currentRun() && !isMeshNetworkFailure(error)) runtime.fail(error)
  } finally {
    heartbeat?.()
    clearTimeout(timeout)
    removePeer(runtime, personId, session)
    runtime.connections.delete(connection)
    await connection.close()
    runtime.disconnect()
  }
}

async function receiveMeshPeer(runtime: HostRuntime, connection: SyncConnection, stream: Awaited<ReturnType<SyncConnection["acceptStream"]>>, raw: Uint8Array) {
  if (inspectPairingFrame(raw).type !== "mesh-handshake-request" || !runtime.context.durableMesh) return false
  await runtime.context.durableMesh.acceptOnInvitationNode(connection, stream, raw)
  return true
}

function readWorkspaceRequest(runtime: HostRuntime, payload: Uint8Array) {
  const guest = JSON.parse(new TextDecoder().decode(payload))
  if (typeof guest.personId !== "string" || !guest.personId || guest.invitationId !== runtime.invite.invitationId) throw new Error("Invalid workspace join request.")
  return guest as { personId: string; displayName?: unknown; meshPeers?: unknown }
}

async function approveWorkspaceAccess(runtime: HostRuntime, guest: { personId: string; displayName?: unknown; meshPeers?: unknown }) {
  if (guest.personId === runtime.profile.identity.personId) {
    return { ok: false as const, error: "This invite is for another person, but this browser uses the owner's identity. Use a separate identity to join as an editor." }
  }
  const existing = runtime.grants.get(guest.personId)
  if (existing) return { ok: true as const, value: { personId: guest.personId, grants: existing.grants } }
  if (Date.parse(runtime.invite.expiresAt) <= Date.now()) {
    return { ok: false as const, error: "This invitation has expired." }
  }
  const name = typeof guest.displayName === "string" ? guest.displayName.slice(0, 80) : `Participant ${guest.personId.slice(0, 6)}`
  const role = await runtime.context.waitForJoinDecision(guest.personId, name)
  if (!role) {
    return { ok: false as const, error: "The owner declined this request." }
  }
  const accessEpochs = new Map(await Promise.all(runtime.workspaces.map(async item => [item.id,
    await runtime.context.durableMesh?.nextAccessEpoch(item.id) ?? 1] as const)))
  const result = await defaultInvitationService.approveWorkspaceJoinSet(runtime.invite.invitationId, guest.personId,
    runtime.workspaces.map(item => item.id), runtime.profile, runtime.owners, role, accessEpochs)
  if (!result.ok) throw new Error(result.error)
  for (const grant of result.grants) await defaultProofStore.putGrant(grant.payload.grantId, grant)
  await runtime.context.durableMesh?.acceptGuest(runtime.workspaces.map(item => item.id), guest.meshPeers, result.grants)
  runtime.grants.set(guest.personId, result)
  return { ok: true as const, value: { personId: guest.personId, grants: result.grants } }
}

async function prepareWorkspaceAccess(runtime: HostRuntime, approval: { personId: string; grants: WorkspaceGrant[] }) {
  const injectedFailure = (window as Window & { __MATCH_INJECT_SYNC_SNAPSHOT_FAILURE__?: string }).__MATCH_INJECT_SYNC_SNAPSHOT_FAILURE__
  if (injectedFailure) throw new Error(injectedFailure)
  return new TextEncoder().encode(JSON.stringify({ grants: approval.grants,
    snapshot: toBase64Url(await runtime.replica.snapshot()),
    meshWorkspaces: await runtime.context.durableMesh?.invitationPayload(runtime.workspaces.map(item => item.id)),
  }))
}

async function startPeerSession(runtime: HostRuntime, connection: SyncConnection, personId: string) {
  if (runtime.run !== runtime.context.currentRun() || runtime.stopped()) throw new Error("Invitation superseded")
  const handoff = new BrowserWorkspaceJoinHandoffHost(new WasmWorkspaceJoinHandoff(runtime.invite.secret, "host"))
  const session = liveWorkspaceSetSync(connection, runtime.invite.secret, runtime.replica, {
    onHandoffRequest: async (stream, requestFrame) => {
      await handoff.run(stream, requestFrame, connection)
      await runtime.handoff()
    },
  })
  const previous = runtime.context.replaceDirectSession(personId, session)
  runtime.peers.set(personId, session)
  await previous?.close()
  runtime.context.state.directLive.value = true
  runtime.context.state.step.value = "synced"
  return session
}

function removePeer(runtime: HostRuntime, personId: string, session: LiveWorkspaceSync | undefined) {
  if (!session || runtime.peers.get(personId) !== session) return
  runtime.peers.delete(personId)
  runtime.context.removeDirectSession(personId, session)
}
