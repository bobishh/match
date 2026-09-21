import {
  decodePairingFrame,
  encodePairingFrame,
  inspectPairingFrame,
  type WorkspaceJoinInvitation,
} from "@meta-uber/mesh-pairing"
import { isMeshNetworkFailure, meshNetworkConnection, startMeshHeartbeat } from "@meta-uber/mesh-transport"
import { toBase64Url, type LocalProfile } from "../domain/identity"
import { defaultProofStore } from "../domain/proofs"
import { defaultInvitationService } from "./invitations"
import type { SyncAcceptor, SyncConnection, SyncNode } from "./transport"
import { liveWorkspaceSetSync, type LiveWorkspaceSync, type workspaceSet } from "./workspaceSet"
import type { WorkspaceHostContext } from "./deviceSyncHost"

type WorkspaceOption = { id: string; title: string }
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
  grants: Map<string, Awaited<ReturnType<typeof defaultInvitationService.approveWorkspaceJoinSet>>>
  group: LiveWorkspaceSync
  stopped: () => boolean
  disconnect: () => void
  handoff: () => Promise<void>
  fail: (error: unknown) => void
}

export async function startWorkspaceHostController(input: HostInput) {
  const acceptor = await input.node.accept()
  const peers = new Map<string, LiveWorkspaceSync>()
  const connections = new Set<SyncConnection>()
  const grants = new Map<string, Awaited<ReturnType<typeof defaultInvitationService.approveWorkspaceJoinSet>>>()
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
    async publish() {
      await Promise.all([...peers.values()].map(session => publishPeer(session)))
    },
    async close() {
      stop()
      window.removeEventListener("offline", offline)
      await acceptor.close()
      await Promise.all([...connections].map(connection => connection.close()))
    },
  }
}

async function publishPeer(session: LiveWorkspaceSync) {
  try {
    await session.publish()
  } catch (err) {
    await session.close()
    if (!isMeshNetworkFailure(err)) throw err
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
    const rawConnection = await runtime.acceptor.accept()
    if (!rawConnection) return
    void receivePeer(runtime, meshNetworkConnection(rawConnection), connected).catch(runtime.fail)
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
    const guest = readWorkspaceRequest(runtime, rawRequest)
    if (!guest) return
    personId = guest.personId
    const result = await grantWorkspaceAccess(runtime, connection, stream, guest)
    if (!result) return
    await sendWorkspaceAccess(runtime, connection, stream, result)
    clearTimeout(timeout)
    session = await startPeerSession(runtime, connection, personId)
    heartbeat = startMeshHeartbeat(session, () => { void session?.close() })
    connected()
    await runtime.group.publish()
    await session.done
  } catch (err) {
    if (!runtime.stopped() && runtime.run === runtime.context.currentRun() && !isMeshNetworkFailure(err)) runtime.fail(err)
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
  const header = inspectPairingFrame(raw)
  if (header.type !== "mesh-handshake-request" || !runtime.context.durableMesh) return false
  await runtime.context.durableMesh.acceptOnInvitationNode(connection, stream, raw)
  return true
}

function readWorkspaceRequest(runtime: HostRuntime, raw: Uint8Array) {
  const header = inspectPairingFrame(raw)
  if (header.type !== "workspace-join-request" || header.secret !== runtime.invite.secret) return
  const guest = JSON.parse(new TextDecoder().decode(decodePairingFrame(raw, "workspace-join-request", runtime.invite.secret)))
  if (typeof guest.personId !== "string" || !guest.personId || guest.invitationId !== runtime.invite.invitationId) throw new Error("Invalid workspace join request.")
  return guest as { personId: string; displayName?: unknown; meshPeers?: unknown }
}

async function grantWorkspaceAccess(runtime: HostRuntime, connection: SyncConnection, stream: Awaited<ReturnType<SyncConnection["acceptStream"]>>, guest: { personId: string; displayName?: unknown; meshPeers?: unknown }) {
  const existing = runtime.grants.get(guest.personId)
  if (existing) return existing
  if (await rejectExpiredInvite(runtime, connection, stream)) return
  const name = typeof guest.displayName === "string" ? guest.displayName.slice(0, 80) : `Participant ${guest.personId.slice(0, 6)}`
  const role = await runtime.context.waitForJoinDecision(guest.personId, name)
  if (!role) {
    await rejectWorkspaceJoin(connection, stream, runtime.invite.secret, "The owner declined this request.")
    return
  }
  const result = await defaultInvitationService.approveWorkspaceJoinSet(runtime.invite.invitationId, guest.personId, runtime.workspaces.map(item => item.id), runtime.profile, runtime.owners, role)
  if (!result.ok) throw new Error(result.error)
  for (const grant of result.grants) await defaultProofStore.putGrant(grant.payload.grantId, grant)
  await runtime.context.durableMesh?.acceptGuest(runtime.workspaces.map(item => item.id), guest.meshPeers, result.grants)
  runtime.grants.set(guest.personId, result)
  return result
}

async function rejectExpiredInvite(runtime: HostRuntime, connection: SyncConnection, stream: Awaited<ReturnType<SyncConnection["acceptStream"]>>) {
  if (Date.parse(runtime.invite.expiresAt) > Date.now()) return false
  await rejectWorkspaceJoin(connection, stream, runtime.invite.secret, "This invitation has expired.")
  return true
}

async function rejectWorkspaceJoin(connection: SyncConnection, stream: Awaited<ReturnType<SyncConnection["acceptStream"]>>, secret: string, error: string) {
  const payload = new TextEncoder().encode(JSON.stringify({ error }))
  await stream.send(encodePairingFrame("workspace-join-response", secret, payload))
  await stream.closeSend()
  const acknowledgement = await connection.acceptStream()
  decodePairingFrame(await acknowledgement.read(), "sync-ack", secret)
  await acknowledgement.closeSend()
}

async function sendWorkspaceAccess(runtime: HostRuntime, connection: SyncConnection, stream: Awaited<ReturnType<SyncConnection["acceptStream"]>>, result: Awaited<ReturnType<typeof defaultInvitationService.approveWorkspaceJoinSet>>) {
  if (!result.ok) throw new Error(result.error)
  const payload = new TextEncoder().encode(JSON.stringify({
    grants: result.grants,
    snapshot: toBase64Url(await runtime.replica.snapshot()),
    meshWorkspaces: await runtime.context.durableMesh?.invitationPayload(runtime.workspaces.map(item => item.id)),
  }))
  await stream.send(encodePairingFrame("workspace-join-response", runtime.invite.secret, payload))
  await stream.closeSend()
  const acknowledgement = await connection.acceptStream()
  await runtime.replica.receive(decodePairingFrame(await acknowledgement.read(), "sync-ack", runtime.invite.secret))
  await acknowledgement.closeSend()
}

export async function startPeerSession(runtime: HostRuntime, connection: SyncConnection, personId: string) {
  if (runtime.run !== runtime.context.currentRun() || runtime.stopped()) throw new Error("Invitation superseded")
  const session = liveWorkspaceSetSync(connection, runtime.invite.secret, runtime.replica, {
    onHandoffRequest: async stream => {
      await stream.send(encodePairingFrame("mesh-handoff-ready", runtime.invite.secret, new Uint8Array()))
      await stream.closeSend()
      const confirmation = await connection.acceptStream()
      decodePairingFrame(await confirmation.read(), "mesh-handoff-confirmed", runtime.invite.secret)
      await confirmation.closeSend()
      await runtime.handoff()
      // The guest owns the pairing transport teardown after confirmation. The
      // adopted node is already serving durable mesh connections; closing this
      // peer here can close that node before the recovery publish runs.
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
