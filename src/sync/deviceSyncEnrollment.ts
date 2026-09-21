import {
  createDeviceEnrollmentInvite,
  createPairingSecret,
  decodePairingFrame,
  encodePairingFrame,
  inspectPairingFrame,
  invitationUrl,
  type DeviceEnrollmentInvitation,
} from "@meta-uber/mesh-pairing"
import { defaultInvitationService, deriveTranscriptAuthCode } from "./invitations"
import { createEnrollmentRequest, enrollmentPayload, installEnrollment, readEnrollmentRequest } from "./enrollment"
import { defaultProofStore, certHashDefault } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { registerDeviceInRoot } from "../domain/personalRoot"
import { fromBase64Url, type LocalProfile } from "../domain/identity"
import { workspaceSet } from "./workspaceSet"
import { startPersistentNode } from "./persistentNode"
import type { SyncConnection, SyncNode } from "./transport"
import { userMessage } from "./deviceSyncState"
import { showInviteQr } from "./deviceSyncInviteView"
import type { PairingContext } from "./deviceSyncContext"

type EnrollmentContext = PairingContext & {
  activeWorkspaceId?: () => string
  handoffNode: (reason: string) => Promise<void>
  identityChanged?: () => Promise<void>
  waitToReconnect: (milliseconds: number) => Promise<void>
  setApprovalResolver: (resolve: ((approved: boolean) => void) | undefined) => void
  denyPendingApproval: () => void
}

function isCurrent(context: EnrollmentContext, run: number) {
  return context.currentRun() === run
}

function pairingNode(context: EnrollmentContext) {
  return context.durableMesh?.startInstanceNode() ?? startPersistentNode(context.transport)
}

async function makeQr(context: EnrollmentContext, invite: DeviceEnrollmentInvitation) {
  await showInviteQr(context.state, invitationUrl(context.origin(), invite))
}

function enrollmentError(context: EnrollmentContext, run: number, err: unknown, fallback: string) {
  if (!isCurrent(context, run)) return
  context.state.step.value = "error"
  context.state.error.value = userMessage(err, fallback)
}

export async function selectDeviceEnrollment(context: EnrollmentContext) {
  const run = context.nextRun()
  await context.pauseMesh()
  await context.stopNode("Starting device enrollment")
  context.state.copyNotice.value = ""
  context.state.error.value = ""
  context.state.authCode.value = ""
  context.state.enrollmentDeviceName.value = ""
  try {
    if (!context.workspaceStore || !context.durableMesh) throw new Error("Device sync is unavailable.")
    const profile = await context.getProfile()
    const node = await pairingNode(context)
    if (!isCurrent(context, run)) return void node.close("Replaced")
    context.setNode(node)
    const secret = createPairingSecret()
    const invite = createDeviceEnrollmentInvite(node.endpointId, secret, profile)
    await defaultInvitationService.saveIssuedInvitation(invite)
    await makeQr(context, invite)
    context.state.step.value = "enroll-host"
    await hostEnrollment(context, run, node, secret, invite, profile)
  } catch (err) {
    enrollmentError(context, run, err, "Couldn’t start device sync.")
  }
}

async function hostEnrollment(context: EnrollmentContext, run: number, node: SyncNode, secret: string, invite: DeviceEnrollmentInvitation, profile: LocalProfile) {
  const acceptor = await node.accept()
  void receiveEnrollment(context, run, node, acceptor, secret, invite, profile)
}

async function receiveEnrollment(context: EnrollmentContext, run: number, node: SyncNode, acceptor: Awaited<ReturnType<SyncNode["accept"]>>, secret: string, invite: DeviceEnrollmentInvitation, profile: LocalProfile) {
  let connection: SyncConnection | undefined
  const timeout = setTimeout(() => {
    context.denyPendingApproval()
    void node.close("Enrollment timed out").catch(() => {})
  }, 600_000)
  try {
    while (isCurrent(context, run)) {
      connection = await acceptor.accept()
      if (!connection) throw new Error("Device enrollment connection closed. Create a new link.")
      const stream = await connection.acceptStream()
      const raw = await stream.read()
      const header = inspectPairingFrame(raw)
      if (header.type !== "enroll-request" || header.secret !== secret) {
        await connection.close()
        continue
      }
      const guest = await readEnrollmentRequest(decodePairingFrame(raw, "enroll-request", secret), invite)
      const claim = await defaultInvitationService.claimInvitation(invite.invitationId, guest.deviceId)
      if (!claim.ok) throw new Error(claim.error)
      context.state.authCode.value = await deriveTranscriptAuthCode(secret, invite.invitationId, guest.publicKey)
      context.state.enrollmentDeviceName.value = guest.displayName
      context.state.step.value = "enroll-host-pending"
      context.state.isOpen.value = true
      const approved = await waitForApproval(context, run)
      if (!approved) {
        await rejectEnrollment(stream, secret)
        await awaitEnrollmentDeclineAcknowledgement(connection, secret).catch(() => undefined)
        throw new Error("Device enrollment was declined or cancelled.")
      }
      context.state.step.value = "enroll-syncing"
      await approveEnrollment(context, node, stream, connection, secret, invite, profile, guest)
      return
    }
  } catch (err) {
    if (isCurrent(context, run)) console.error("Device enrollment host failed", err)
    enrollmentError(context, run, err, "Couldn’t add this device.")
  } finally {
    clearTimeout(timeout)
    await connection?.close().catch(() => {})
    await acceptor.close().catch(() => {})
    if (isCurrent(context, run)) await context.handoffNode("Enrollment finished")
  }
}

async function waitForApproval(context: EnrollmentContext, run: number) {
  return new Promise<boolean>(resolve => {
    const timer = setInterval(() => {
      if (!isCurrent(context, run)) {
        clearInterval(timer)
        resolve(false)
      }
    }, 100)
    context.setApprovalResolver((approved: boolean) => {
      clearInterval(timer)
      resolve(approved)
    })
  })
}

async function rejectEnrollment(stream: Awaited<ReturnType<SyncConnection["acceptStream"]>>, secret: string) {
  const error = new TextEncoder().encode(JSON.stringify({ error: "Device enrollment was declined or cancelled." }))
  await stream.send(encodePairingFrame("enroll-approved", secret, error))
  await stream.closeSend()
}

async function awaitEnrollmentDeclineAcknowledgement(connection: SyncConnection, secret: string) {
  const acknowledgement = await connection.acceptStream()
  decodePairingFrame(await acknowledgement.read(), "enroll-ack", secret)
  await acknowledgement.closeSend()
}

async function acknowledgeEnrollmentDecline(connection: SyncConnection, secret: string) {
  const acknowledgement = await connection.openStream()
  await acknowledgement.send(encodePairingFrame("enroll-ack", secret, new Uint8Array()))
  await acknowledgement.closeSend()
}

async function approveEnrollment(
  context: EnrollmentContext,
  node: SyncNode,
  stream: Awaited<ReturnType<SyncConnection["acceptStream"]>>,
  connection: SyncConnection,
  secret: string,
  invite: DeviceEnrollmentInvitation,
  profile: LocalProfile,
  guest: { deviceId: string; publicKey: string; displayName: string },
) {
  const result = await defaultInvitationService.approveEnrollment(invite.invitationId, guest, profile)
  if (!result.ok) throw new Error(result.error)
  const certificateHash = await certHashDefault(result.certificate)
  await defaultProofStore.putCertificate(certificateHash, result.certificate)
  const root = await defaultStorage.loadPersonalRoot()
  if (!root) throw new Error("Personal identity is unavailable. Reload and try again.")
  registerDeviceInRoot(root, { ...guest, certificateHash, addedAt: new Date().toISOString() })
  await defaultStorage.savePersonalRoot(root)
  const workspaces = await ownedWorkspaces(context, profile)
  const ids = workspaces.map(item => item.id)
  const active = selectActiveWorkspace(context, ids)
  await context.durableMesh?.forgetEnrolledDevice(ids, guest.deviceId)
  await context.durableMesh?.ensureOwnerWorkspaces(ids, node.endpointId, profile)
  const replica = workspaceSet(context.meshWorkspaceStore ?? context.workspaceStore!, ids)
  const payload = await enrollmentPayload(invite, profile, result.certificate, root, workspaces, active,
    await context.durableMesh!.invitationPayload(ids), await replica.snapshot())
  await stream.send(encodePairingFrame("enroll-approved", secret, payload))
  await stream.closeSend()
  const ack = await connection.acceptStream()
  await replica.receive(decodePairingFrame(await ack.read(), "enroll-ack", secret))
  await ack.send(encodePairingFrame("enroll-complete", secret, new Uint8Array()))
  await ack.closeSend()
  const confirmation = await connection.acceptStream()
  decodePairingFrame(await confirmation.read(), "mesh-handoff-confirmed", secret)
  context.state.step.value = "enroll-host-done"
}

async function ownedWorkspaces(context: EnrollmentContext, profile: LocalProfile) {
  const workspaces = [] as { id: string; title: string }[]
  for (const item of context.availableWorkspaces) {
    if (!context.workspaceOwner || await context.workspaceOwner(item.id) === profile.identity.personId) workspaces.push(item)
  }
  if (!workspaces.length) throw new Error("No owned workspaces are available to sync.")
  return workspaces
}

function selectActiveWorkspace(context: EnrollmentContext, ids: string[]) {
  const requested = context.activeWorkspaceId?.()
  return requested && ids.includes(requested) ? requested : ids[0]!
}

export async function requestDeviceEnrollment(context: EnrollmentContext, invite: DeviceEnrollmentInvitation) {
  const run = context.nextRun()
  let connection: SyncConnection | undefined
  let handedOff = false
  context.state.step.value = "enroll-guest-waiting"
  context.state.error.value = ""
  try {
    if (!context.workspaceStore || !context.durableMesh) throw new Error("Device sync is unavailable.")
    await context.pauseMesh()
    await context.stopNode("Starting device enrollment")
    const profile = await context.getProfile()
    context.state.authCode.value = await deriveTranscriptAuthCode(invite.secret, invite.invitationId, profile.device.publicKey)
    const node = await startPersistentNode(context.transport)
    if (!isCurrent(context, run)) return void node.close("Replaced")
    context.setNode(node)
    connection = await dialEnrollmentPeer(context, run, node, invite)
    if (!connection || !isCurrent(context, run)) return
    await receiveEnrollmentApproval(context, run, node, connection, invite, profile)
    connection = undefined
    handedOff = true
  } catch (err) {
    if (isCurrent(context, run)) console.error("Device enrollment guest failed", err)
    enrollmentError(context, run, err, "Couldn’t add this device. Create a new link and try again.")
  } finally {
    await connection?.close().catch(() => {})
    if (isCurrent(context, run) && !handedOff) await context.handoffNode("Enrollment finished")
  }
}

async function dialEnrollmentPeer(context: EnrollmentContext, run: number, node: SyncNode, invite: DeviceEnrollmentInvitation) {
  for (let attempt = 0; isCurrent(context, run); attempt++) {
    try {
      return await (node.dialRelay ? node.dialRelay(invite.issuerEndpoint) : node.dial(invite.issuerEndpoint))
    } catch (err) {
      if (attempt >= 4) throw err
      await context.waitToReconnect(Math.min(1000 * 2 ** attempt, 5000))
    }
  }
}

async function receiveEnrollmentApproval(context: EnrollmentContext, run: number, node: SyncNode, connection: SyncConnection, invite: DeviceEnrollmentInvitation, profile: LocalProfile) {
  const stream = await connection.openStream()
  await stream.send(encodePairingFrame("enroll-request", invite.secret, await createEnrollmentRequest(invite, profile)))
  await stream.closeSend()
  const response = decodePairingFrame(await stream.read(), "enroll-approved", invite.secret)
  const declined = enrollmentDecline(response)
  if (declined) {
    await acknowledgeEnrollmentDecline(connection, invite.secret)
    throw new Error(declined)
  }
  if (!isCurrent(context, run)) return
  context.state.step.value = "enroll-syncing"
  const enrolled = await installEnrollment(response, invite, profile)
  await context.identityChanged?.()
  const ids = enrolled.workspaces.map(item => item.id)
  await context.durableMesh!.receiveInvitation(enrolled.meshWorkspaces, ids, enrolled.profile, [])
  const replica = workspaceSet(context.meshWorkspaceStore ?? context.workspaceStore!, ids)
  await replica.receive(fromBase64Url(enrolled.snapshot))
  await context.durableMesh!.ensureOwnerWorkspaces(ids, node.endpointId, enrolled.profile)
  await context.workspaceStore!.activate(enrolled.activeWorkspaceId)
  const ack = await connection.openStream()
  await ack.send(encodePairingFrame("enroll-ack", invite.secret, await replica.snapshot()))
  await ack.closeSend()
  decodePairingFrame(await ack.read(), "enroll-complete", invite.secret)
  await context.handoffNode("Enrollment finished")
  await context.durableMesh!.waitUntilListening()
  const confirmation = await connection.openStream()
  await confirmation.send(encodePairingFrame("mesh-handoff-confirmed", invite.secret, new Uint8Array()))
  await confirmation.closeSend()
  context.state.step.value = "enroll-guest-done"
  if (typeof window !== "undefined") window.history.replaceState(window.history.state, "", "/")
}

function enrollmentDecline(bytes: Uint8Array) {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : undefined
  } catch { return undefined }
}
