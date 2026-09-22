import {
  decodePairingFrame,
  encodePairingFrame,
  type WorkspaceJoinInvitation,
} from "@meta-uber/mesh-pairing"
import { isMeshNetworkFailure, meshNetworkConnection, meshNetworkIO } from "@meta-uber/mesh-transport"
import { fromBase64Url, type LocalProfile } from "../domain/identity"
import { defaultProofStore } from "../domain/proofs"
import { liveWorkspaceSetSync, workspaceSet, type LiveWorkspaceSync, type WorkspaceReplica, type WorkspaceSetStore } from "./workspaceSet"
import type { DurableMesh } from "./durableMesh"
import { startPersistentNode } from "./persistentNode"
import type { SyncConnection, SyncNode, SyncTransport } from "./transport"
import { meshOwnersMatch, type DeviceSyncState, userMessage, validWorkspaceJoinPayload, type WorkspaceJoinPayload } from "./deviceSyncState"
import { offlineRetryDelay } from "./offlineRetry"

type GuestContext = {
  state: DeviceSyncState
  workspace: WorkspaceReplica
  workspaceStore?: WorkspaceSetStore
  meshWorkspaceStore?: WorkspaceSetStore
  durableMesh?: DurableMesh
  transport: SyncTransport
  getProfile: () => Promise<LocalProfile>
  displayName?: () => string
  nextRun: () => number
  currentRun: () => number
  pauseMesh: () => Promise<void>
  waitToReconnect: (milliseconds: number) => Promise<void>
  setNode: (node: SyncNode | undefined) => void
  setLiveSession: (session: LiveWorkspaceSync | undefined) => void
  setStopWatching: (stop: (() => void) | undefined) => void
  clearPairingLocation: () => void
}

type ConnectionCycle = {
  connection?: SyncConnection
  session?: LiveWorkspaceSync
  node?: SyncNode
  handoff: boolean
  acknowledged: boolean
}

function current(context: GuestContext, run: number) {
  return context.currentRun() === run
}

function dial(node: SyncNode, endpoint: string) {
  return node.dialRelay ? node.dialRelay(endpoint) : node.dial(endpoint)
}

export async function acceptWorkspaceInvitation(context: GuestContext, invite: WorkspaceJoinInvitation) {
  const run = context.nextRun()
  await context.pauseMesh()
  context.state.step.value = "workspace-guest-waiting"
  context.state.error.value = ""
  try {
    if (!context.workspaceStore) throw new Error("Workspace sync is unavailable.")
    if (Date.parse(invite.expiresAt) <= Date.now()) throw new Error("This invitation has expired.")
    const profile = await context.getProfile()
    const replica = workspaceSet(context.meshWorkspaceStore ?? context.workspaceStore, invite.workspaces.map(item => item.id))
    await reconnectGuest(context, run, invite, profile, replica)
  } catch (err) {
    showGuestError(context, run, invite, err)
  }
}

async function reconnectGuest(context: GuestContext, run: number, invite: WorkspaceJoinInvitation, profile: LocalProfile, replica: ReturnType<typeof workspaceSet>) {
  let connectedBefore = false
  let attempts = 0
  while (current(context, run)) {
    if (!navigator.onLine) {
      context.state.step.value = "workspace-reconnecting"
      await context.waitToReconnect(offlineRetryDelay(attempts + 1))
      continue
    }
    const cycle = await connectOnce(context, run, invite, profile, replica, connectedBefore, attempts)
    if (!current(context, run)) return
    if (cycle.handoff) {
      await finishHandoff(context, run, invite, cycle)
      return
    }
    connectedBefore ||= Boolean(cycle.session)
    attempts += 1
    await context.waitToReconnect(offlineRetryDelay(attempts))
  }
}

async function connectOnce(context: GuestContext, run: number, invite: WorkspaceJoinInvitation, profile: LocalProfile, replica: ReturnType<typeof workspaceSet>, connectedBefore: boolean, attempts: number) {
  const cycle: ConnectionCycle = { handoff: false, acknowledged: false }
  const offline = () => {
    if (!current(context, run)) return
    context.state.directLive.value = false
    context.state.step.value = "workspace-reconnecting"
    void cycle.connection?.close()
    if (!cycle.connection) void cycle.node?.close("Network offline").catch(() => {})
  }
  window.addEventListener("offline", offline)
  try {
    cycle.node = context.durableMesh ? await context.durableMesh.startInstanceNode() :
      attempts === 0 ? await startPersistentNode(context.transport) : await context.transport.start()
    if (!current(context, run)) return cycle
    context.setNode(cycle.node)
    cycle.connection = meshNetworkConnection(await meshNetworkIO(dial(cycle.node, invite.issuerEndpoint)))
    await exchangeInvitation(context, run, invite, profile, replica, cycle, connectedBefore)
  } catch (err) {
    if (!current(context, run)) return cycle
    if (!isMeshNetworkFailure(err)) throw err
    context.state.step.value = "workspace-reconnecting"
    cycle.handoff = connectedBefore
  } finally {
    window.removeEventListener("offline", offline)
    await closeCycle(context, cycle)
  }
  return cycle
}

async function exchangeInvitation(context: GuestContext, run: number, invite: WorkspaceJoinInvitation, profile: LocalProfile, replica: ReturnType<typeof workspaceSet>, cycle: ConnectionCycle, connectedBefore: boolean) {
  const connection = cycle.connection!
  const stream = await connection.openStream()
  const request = new TextEncoder().encode(JSON.stringify({
    invitationId: invite.invitationId,
    personId: profile.identity.personId,
    displayName: context.displayName?.() || profile.identity.displayName,
    meshPeers: await context.durableMesh?.createGuestAdvertisements(invite.workspaces.map(item => item.id), cycle.node!.endpointId, profile),
  }))
  await stream.send(encodePairingFrame("workspace-join-request", invite.secret, request))
  await stream.closeSend()
  if (current(context, run)) context.state.step.value = "workspace-guest-waiting"
  const payload = await readInvitationResponse(stream, connection, invite)
  await installInvitation(context, run, invite, profile, replica, connection, payload, connectedBefore)
  cycle.session = liveWorkspaceSetSync(connection, invite.secret, replica)
  context.setLiveSession(cycle.session)
  await watchGuestWorkspace(context, cycle.session)
  context.clearPairingLocation()
  await cycle.session.publish()
  const handoff = await connection.openStream()
  await handoff.send(encodePairingFrame("mesh-handoff-request", invite.secret, new Uint8Array()))
  await handoff.closeSend()
  decodePairingFrame(await handoff.read(), "mesh-handoff-ready", invite.secret)
  await context.durableMesh?.resumeAll(cycle.node)
  await context.durableMesh?.waitUntilListening()
  const confirmation = await connection.openStream()
  await confirmation.send(encodePairingFrame("mesh-handoff-confirmed", invite.secret, new Uint8Array()))
  await confirmation.closeSend()
  cycle.acknowledged = true
  cycle.handoff = true
}

async function readInvitationResponse(stream: Awaited<ReturnType<SyncConnection["openStream"]>>, connection: SyncConnection, invite: WorkspaceJoinInvitation) {
  const response = decodePairingFrame(await stream.read(), "workspace-join-response", invite.secret)
  const payload = JSON.parse(new TextDecoder().decode(response)) as WorkspaceJoinPayload
  if (typeof payload.error !== "string") return payload
  const acknowledgement = await connection.openStream()
  await acknowledgement.send(encodePairingFrame("sync-ack", invite.secret, new Uint8Array()))
  await acknowledgement.closeSend()
  throw new Error(payload.error)
}

async function installInvitation(context: GuestContext, run: number, invite: WorkspaceJoinInvitation, profile: LocalProfile, replica: ReturnType<typeof workspaceSet>, connection: SyncConnection, payload: WorkspaceJoinPayload, connectedBefore: boolean) {
  const workspaceIds = invite.workspaces.map(item => item.id)
  if (context.durableMesh && payload.meshWorkspaces === undefined) throw new Error("The other device needs an update. Reload it and generate a new invitation.")
  if (!validWorkspaceJoinPayload(payload, workspaceIds, profile.identity.personId)) throw new Error("The other device needs an update. Reload it and generate a new invitation.")
  if (!current(context, run)) return
  if (!meshOwnersMatch(payload.meshWorkspaces, invite.issuerPersonId)) throw new Error("Invitation owner mismatch")
  // Both durable authority and every received document must validate before
  // either is persisted. This prevents a later malformed workspace from
  // leaving an earlier board or credential stranded after an interrupted join.
  await replica.validate(fromBase64Url(payload.snapshot))
  await context.durableMesh?.validateInvitation(payload.meshWorkspaces, workspaceIds, profile, payload.grants)
  for (const grant of payload.grants) await defaultProofStore.putGrant(grant.payload.grantId, grant)
  await replica.receive(fromBase64Url(payload.snapshot))
  await context.durableMesh?.receiveInvitation(payload.meshWorkspaces, workspaceIds, profile, payload.grants)
  if (!connectedBefore) await context.workspaceStore!.activate(invite.workspaces[0]!.id)
  const acknowledgement = await connection.openStream()
  await acknowledgement.send(encodePairingFrame("sync-ack", invite.secret, await replica.snapshot()))
  await acknowledgement.closeSend()
}

async function watchGuestWorkspace(context: GuestContext, session: LiveWorkspaceSync) {
  context.setStopWatching(context.workspace.subscribe?.(() => {
    void session.publish().catch(() => {
      void session.close()
    })
  }))
}

async function closeCycle(context: GuestContext, cycle: ConnectionCycle) {
  context.setStopWatching(undefined)
  context.setLiveSession(undefined)
  context.state.directLive.value = false
  await cycle.session?.close()
  await cycle.connection?.close()
  if (!cycle.handoff) await cycle.node?.close("Reconnecting").catch(() => {})
  context.setNode(undefined)
}

async function finishHandoff(context: GuestContext, run: number, invite: WorkspaceJoinInvitation, cycle: ConnectionCycle) {
  if (!cycle.acknowledged) throw new Error("Mesh handoff was not confirmed")
  if (!current(context, run)) return
  context.state.liveWorkspaceIds.value = invite.workspaces.map(item => item.id)
  context.state.step.value = "workspace-guest-done"
}

function showGuestError(context: GuestContext, run: number, invite: WorkspaceJoinInvitation, err: unknown) {
  if (!current(context, run)) return
  context.state.directLive.value = false
  context.state.step.value = "error"
  if (/access revoked/i.test(err instanceof Error ? err.message : String(err))) {
    context.state.revokedWorkspaceIds.value = [...new Set([...context.state.revokedWorkspaceIds.value, ...invite.workspaces.map(item => item.id)])]
  }
  console.error("Workspace sync failed", err)
  context.state.error.value = userMessage(err, "Couldn’t save the received workspaces.")
}
