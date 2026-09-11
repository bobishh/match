import { computed, ref, type Ref } from "vue"
import QRCode from "qrcode"
import {
  createPairingSecret,
  createDeviceEnrollmentInvite,
  createWorkspaceJoinInvite,
  invitationUrl,
  parseInvitation,
  encodePairingFrame,
  decodePairingFrame,
  inspectPairingFrame,
  type ScopedInvitation,
  type DeviceEnrollmentInvitation,
  type WorkspaceJoinInvitation,
} from "./protocol"
import { irohTransport } from "./irohTransport"
import { defaultInvitationService, deriveTranscriptAuthCode } from "./invitations"
import { bootstrapIdentity, fromBase64Url, toBase64Url, type LocalProfile } from "../domain/identity"
import { type LiveWorkspaceSync, type WorkspaceReplica } from "./session"
import type { SyncAcceptor, SyncConnection, SyncNode, SyncTransport } from "./transport"
import { defaultProofStore, certHashDefault } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { createEnrollmentRequest, readEnrollmentRequest, installEnrollment, enrollmentPayload } from "./enrollment"
import { registerDeviceInRoot } from "../domain/personalRoot"
import { workspaceSet, liveWorkspaceSetSync, networkConnection, networkIO, SyncNetworkError, isNetworkFailure, type WorkspaceSetStore } from "./workspaceSet"
import { DurableMesh, startPersistentNode, type MeshPeerView } from "./durableMesh"

function dialPairingPeer(node: SyncNode, endpoint: string) {
  return node.dialRelay ? node.dialRelay(endpoint) : node.dial(endpoint)
}

export type SyncStep =
  | "idle"
  | "members"
  | "chooser"
  | "workspace-select"
  | "enroll-host"
  | "enroll-host-pending"
  | "enroll-host-done"
  | "enroll-syncing"
  | "workspace-host-select"
  | "workspace-host"
  | "enroll-guest"
  | "enroll-guest-waiting"
  | "enroll-guest-done"
  | "workspace-guest"
  | "workspace-reconnecting"
  | "workspace-guest-waiting"
  | "workspace-guest-done"
  | "synced"
  | "error"

export type SyncPhase = "idle" | "preparing" | "ready" | "join-ready" | "joining" | "synced" | "error"

type DeviceSyncOptions = {
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

export function userMessage(err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : String(err)
  if (message === "Invalid pairing link" || message === "This pairing link is invalid.") {
    return "This pairing link is invalid."
  }
  if (/This invitation has expired/i.test(message)) {
    return "This invitation has expired."
  }
  if (/older version of Match/i.test(message)) {
    return "This sync link was created by an older version of Match. Please create a new invitation."
  }
  if (/Pairing cancelled/i.test(message)) {
    return "Pairing was cancelled on the other device. Generate a new QR and try again."
  }
  if (/out of date document|outdated document/i.test(message)) {
    return "Couldn’t merge workspace changes. Keep this tab open and try pairing again."
  }
  if (/bootstrap|connection|relay|network/i.test(message)) {
    return "Couldn’t reach the other device. Check both connections and try again."
  }
  return message || fallback
}

export function useDeviceSync({
  workspace,
  workspaceStore,
  origin,
  transport = irohTransport,
  availableWorkspaces = ref([]),
  activeWorkspaceId,
  workspaceOwner,
  displayName,
  identityChanged,
}: DeviceSyncOptions) {
  const isOpen = ref(false)
  const isLive = ref(false)
  const liveWorkspaceIds = ref<string[]>([])
  const step = ref<SyncStep>("idle")
  const qrCode = ref("")
  const inviteUrl = ref("")
  const copyNotice = ref("")
  const error = ref("")
  const authCode = ref("")
  const pendingJoins = ref<{ id: string; name: string; personId: string; role: "visitor" | "editor" }[]>([])
  const joinDecisions = new Map<string, (role: "visitor" | "editor" | null) => void>()
  function decideJoin(id: string, approve: boolean) {
    const request = pendingJoins.value.find(item => item.id === id)
    joinDecisions.get(id)?.(approve ? request?.role ?? "visitor" : null)
    joinDecisions.delete(id)
    pendingJoins.value = pendingJoins.value.filter(item => item.id !== id)
  }
  const selectedWorkspaceId = ref("")
  const selectedWorkspaceIds = ref<string[]>([])
  const invitationWorkspaceTitle = ref("")
  const invitationWorkspaces = ref<{ id: string; title: string }[]>([])
  const parsedInvite = ref<ScopedInvitation | null>(null)
  const meshPeers = ref<MeshPeerView[]>([])
  const localDeviceId = ref("")
  const meshLiveWorkspaceIds = ref<string[]>([])
  const revokedWorkspaceIds = ref<string[]>([])
  const ownershipRevision = ref(0)
  const meshReachableUntil = new Map<string, number>()
  let reachabilityTimer: ReturnType<typeof setTimeout> | undefined

  let node: SyncNode | undefined
  let liveSession: LiveWorkspaceSync | undefined
  const directPeerSessions = new Map<string, LiveWorkspaceSync>()
  let stopWatchingWorkspace: (() => void) | undefined
  let run = 0
  let wakeRetry: (() => void) | undefined
  let approveResolve: ((approved: boolean) => void) | undefined
  const enrollmentDeviceName = ref("")
  const meshWorkspaceStore: WorkspaceSetStore | undefined = workspaceStore ? { ...workspaceStore } : undefined
  const durableMesh = workspaceStore && meshWorkspaceStore ? new DurableMesh({
    transport,
    workspaceStore: meshWorkspaceStore,
    workspace,
    getProfile,
    onChange(ids, peers, revoked) {
      const now = Date.now()
      const browserOffline = typeof navigator !== "undefined" && !navigator.onLine
      if (browserOffline) meshReachableUntil.clear()
      else for (const id of ids) meshReachableUntil.set(id, now + 15_000)
      meshLiveWorkspaceIds.value = [...new Set([...ids, ...[...meshReachableUntil]
        .filter(([, until]) => until > now).map(([id]) => id)])]
      meshPeers.value = peers
      revokedWorkspaceIds.value = revoked
      ownershipRevision.value += 1
      if (ids.length > 0) isLive.value = true
      else if (!liveSession) isLive.value = false
      if (ids.length > 0 && step.value === "workspace-reconnecting") step.value = "members"
      clearTimeout(reachabilityTimer)
      const nextExpiry = Math.min(...[...meshReachableUntil.values()].filter(until => until > now))
      if (Number.isFinite(nextExpiry)) reachabilityTimer = setTimeout(() => {
        const current = Date.now()
        for (const [id, until] of meshReachableUntil) if (until <= current) meshReachableUntil.delete(id)
        meshLiveWorkspaceIds.value = meshLiveWorkspaceIds.value.filter(id => ids.includes(id) || meshReachableUntil.has(id))
      }, Math.max(0, nextExpiry - now + 10))
    },
  }) : undefined
  if (durableMesh && meshWorkspaceStore) {
    meshWorkspaceStore.readMesh = id => durableMesh.exportWorkspace(id)
    meshWorkspaceStore.mergeMesh = (id, value) => durableMesh.mergeWorkspace(id, value)
  }

  const phase = computed<SyncPhase>(() => {
    if (step.value === "error") return "error"
    if (step.value === "synced") return "synced"
    return "idle"
  })

  const title = computed(() => {
    if (step.value === "error") return "Couldn’t sync"
    if (step.value === "enroll-guest" || step.value === "enroll-guest-waiting" || step.value === "enroll-guest-done") {
      return "Add your device"
    }
    if (step.value === "workspace-guest" || step.value === "workspace-guest-waiting" || step.value === "workspace-guest-done") {
      return "Join workspace"
    }
    if (step.value === "synced") return "Live sync on"
    return "Device sync"
  })

  async function stopNode(reason: string) {
    approveResolve?.(false)
    approveResolve = undefined
    for (const resolve of joinDecisions.values()) resolve(null)
    joinDecisions.clear()
    pendingJoins.value = []
    stopWatchingWorkspace?.()
    stopWatchingWorkspace = undefined
    const session = liveSession
    liveSession = undefined
    isLive.value = false
    liveWorkspaceIds.value = []
    await session?.close()
    const current = node
    node = undefined
    await current?.close(reason).catch(() => {})
  }

  async function pauseDurableMesh() {
    await durableMesh?.pauseAll()
  }

  async function startDurableMesh() {
    revokedWorkspaceIds.value = await durableMesh?.revokedWorkspaceIds() ?? []
    await durableMesh?.resumeAll()
  }

  async function shutdown() {
    run += 1
    wakeRetry?.()
    clearTimeout(reachabilityTimer)
    await durableMesh?.dispose()
    await stopNode("Page closed")
  }

  async function revokePeer(personId: string) {
    const workspaceId = activeWorkspaceId?.()
    if (!workspaceId) throw new Error("No active workspace")
    await durableMesh?.revokePerson(workspaceId, personId)
    await liveSession?.publish().catch(() => {})
    const direct = directPeerSessions.get(personId)
    directPeerSessions.delete(personId)
    await direct?.close()
  }

  async function transferOwnership(personId: string) {
    const workspaceId = activeWorkspaceId?.()
    if (!workspaceId || !durableMesh) throw new Error("No active workspace")
    await durableMesh.transferOwnership(workspaceId, personId)
    ownershipRevision.value += 1
  }

  function attachLiveSession(session: LiveWorkspaceSync, currentRun: number) {
    liveSession = session
    isLive.value = true
    stopWatchingWorkspace = workspace.subscribe?.(() => {
      void session.publish().catch((syncError) => {
        if (currentRun !== run) return
        console.error("Match live sync publish failed", syncError)
        step.value = "error"
        error.value = "Live sync stopped. Pair again."
        void stopNode("Live sync failed")
      })
    })
    void session.done.catch((syncError) => {
      if (currentRun !== run) return
      console.error("Match live sync receive failed", syncError)
      step.value = "error"
      error.value = "Live sync stopped. Pair again."
      void stopNode("Live sync failed")
    })
  }

  async function close() {
    run += 1
    wakeRetry?.()
    isOpen.value = false
    step.value = "idle"
    qrCode.value = ""
    inviteUrl.value = ""
    copyNotice.value = ""
    error.value = ""
    authCode.value = ""
    parsedInvite.value = null
    await stopNode("Pairing closed")
    void startDurableMesh()
  }

  async function dismiss() {
    if (step.value === "error") {
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href)
        if (url.pathname.replace(/\/$/, "") === "/pair") {
          url.pathname = "/"
          url.hash = ""
          window.history.replaceState(window.history.state, "", url)
        }
      }
      await close()
      return
    }
    isOpen.value = false
  }

  // Open workspace selection without starting a node
  function open() {
    if (["workspace-reconnecting", "workspace-guest-waiting", "enroll-host-pending", "enroll-guest-waiting", "enroll-syncing"].includes(step.value)) {
      isOpen.value = true
      return
    }
    isOpen.value = true
    step.value = "members"
    error.value = ""
    copyNotice.value = ""

    const currentActive = activeWorkspaceId?.() || (availableWorkspaces.value.length > 0 ? availableWorkspaces.value[0].id : undefined)
    if (currentActive) {
      selectedWorkspaceIds.value = [currentActive]
      selectedWorkspaceId.value = currentActive
    } else if (availableWorkspaces.value.length > 0) {
      selectedWorkspaceIds.value = [availableWorkspaces.value[0].id]
      selectedWorkspaceId.value = availableWorkspaces.value[0].id
    } else {
      selectedWorkspaceIds.value = []
      selectedWorkspaceId.value = ""
    }
  }

  async function getProfile(): Promise<LocalProfile> {
    const profile = await bootstrapIdentity("My Device")
    localDeviceId.value = profile.device.deviceId
    return profile
  }

  // Device enrollment uses the same authenticated transport and workspace mesh as invitations.
  async function selectSyncAll() {
    const currentRun = ++run
    await pauseDurableMesh()
    await stopNode("Starting device enrollment")
    copyNotice.value = ""
    error.value = ""
    authCode.value = ""
    enrollmentDeviceName.value = ""
    try {
      if (!workspaceStore || !durableMesh) throw new Error("Device sync is unavailable.")
      const profile = await getProfile()
      const started = await startPersistentNode(transport)
      if (currentRun !== run) return void started.close("Replaced")
      node = started
      const secret = createPairingSecret()
      const invite = createDeviceEnrollmentInvite(started.endpointId, secret, profile)
      await defaultInvitationService.saveIssuedInvitation(invite)
      inviteUrl.value = invitationUrl(origin(), invite)
      qrCode.value = await QRCode.toDataURL(inviteUrl.value, { width: 240, margin: 2, errorCorrectionLevel: "M" })
      step.value = "enroll-host"
      const acceptor = await started.accept()
      void (async () => {
        let connection: SyncConnection | undefined
        const timeout = setTimeout(() => {
          approveResolve?.(false)
          void started.close("Enrollment timed out").catch(() => {})
        }, 600_000)
        try {
          while (currentRun === run) {
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
            authCode.value = await deriveTranscriptAuthCode(secret, invite.invitationId, guest.publicKey)
            enrollmentDeviceName.value = guest.displayName
            const decision = new Promise<boolean>(resolve => { approveResolve = resolve })
            step.value = "enroll-host-pending"
            isOpen.value = true
            if (!await decision) {
              await stream.send(encodePairingFrame("enroll-approved", secret, new TextEncoder().encode(JSON.stringify({ error: "Device enrollment was declined or cancelled." }))))
              await stream.closeSend()
              throw new Error("Device enrollment was declined or cancelled.")
            }
            approveResolve = undefined
            step.value = "enroll-syncing"
            const result = await defaultInvitationService.approveEnrollment(invite.invitationId, guest, profile)
            if (!result.ok) throw new Error(result.error)
            const certificateHash = await certHashDefault(result.certificate)
            await defaultProofStore.putCertificate(certificateHash, result.certificate)
            const root = await defaultStorage.loadPersonalRoot()
            if (!root) throw new Error("Personal identity is unavailable. Reload and try again.")
            registerDeviceInRoot(root, { deviceId: guest.deviceId, publicKey: guest.publicKey, displayName: guest.displayName, certificateHash, addedAt: new Date().toISOString() })
            await defaultStorage.savePersonalRoot(root)
            const workspaces = []
            for (const item of availableWorkspaces.value) {
              if (!workspaceOwner || await workspaceOwner(item.id) === profile.identity.personId) workspaces.push(item)
            }
            if (!workspaces.length) throw new Error("No owned workspaces are available to sync.")
            const ids = workspaces.map(item => item.id)
            await durableMesh.ensureOwnerWorkspaces(ids, started.endpointId, profile)
            const replica = workspaceSet(meshWorkspaceStore ?? workspaceStore!, ids)
            const payload = await enrollmentPayload(invite, profile, result.certificate, root, workspaces,
              await durableMesh.invitationPayload(ids), await replica.snapshot())
            await stream.send(encodePairingFrame("enroll-approved", secret, payload))
            await stream.closeSend()
            const ack = await connection.acceptStream()
            await replica.receive(decodePairingFrame(await ack.read(), "enroll-ack", secret))
            await ack.send(encodePairingFrame("enroll-complete", secret, new Uint8Array()))
            await ack.closeSend()
            if (currentRun !== run) return
            step.value = "enroll-host-done"
            return
          }
        } catch (err) {
          if (currentRun !== run) return
          step.value = "error"
          console.error("Device enrollment host failed", err)
          error.value = userMessage(err, "Couldn’t add this device.")
        } finally {
          clearTimeout(timeout)
          approveResolve = undefined
          await connection?.close().catch(() => {})
          await acceptor.close().catch(() => {})
          if (currentRun === run) {
            await stopNode("Enrollment finished")
            void startDurableMesh()
          }
        }
      })()
    } catch (err) {
      if (currentRun !== run) return
      step.value = "error"
      error.value = userMessage(err, "Couldn’t start device sync.")
    }
  }

  // Flow 2: Host selects "Sync workspace"
  function selectSyncWorkspace() {
    step.value = "workspace-select"
    if (availableWorkspaces.value.length && selectedWorkspaceIds.value.length === 0) {
      selectedWorkspaceIds.value = [availableWorkspaces.value[0].id]
    }
  }

  async function generateWorkspaceInvite() {
    if (selectedWorkspaceIds.value.length === 0) {
      return
    }
    try {
      const profile = await getProfile()
      const selectedWs = availableWorkspaces.value.filter((w) => selectedWorkspaceIds.value.includes(w.id))
      const workspacesToInvite = selectedWs.length > 0
        ? selectedWs
        : selectedWorkspaceIds.value.map((id) => ({ id, title: "Workspace" }))

      const owners = new Map<string, string>()
      for (const item of workspacesToInvite) {
        const owner = workspaceOwner ? await workspaceOwner(item.id) : profile.identity.personId
        if (owner !== profile.identity.personId) throw new Error(`Only the workspace owner can invite peers to ${item.title}`)
        owners.set(item.id, owner)
      }

      await pauseDurableMesh()
      await stopNode("Starting workspace host")
      const currentRun = ++run
      copyNotice.value = ""
      error.value = ""
      const started = await startPersistentNode(transport)
      if (currentRun !== run) return void started.close("Replaced")
      node = started

      await durableMesh?.ensureOwnerWorkspaces(workspacesToInvite.map(w => w.id), started.endpointId, profile)

      const secret = createPairingSecret()
      const invite = createWorkspaceJoinInvite(started.endpointId, secret, profile, workspacesToInvite)
      await defaultInvitationService.saveIssuedInvitation(invite)

      inviteUrl.value = invitationUrl(origin(), invite)
      qrCode.value = await QRCode.toDataURL(inviteUrl.value, { width: 240, margin: 2, errorCorrectionLevel: "M" })
      step.value = "workspace-host"

      if (!workspaceStore) throw new Error("Workspace sync is unavailable.")
      const replica = workspaceSet(meshWorkspaceStore ?? workspaceStore, workspacesToInvite.map(w => w.id))
      liveWorkspaceIds.value = workspacesToInvite.map(w => w.id)
      const acceptor = await started.accept()
      const peers = new Map<string, LiveWorkspaceSync>()
      const connections = new Set<SyncConnection>()
      const grants = new Map<string, Awaited<ReturnType<typeof defaultInvitationService.approveWorkspaceJoinSet>>>()
      let stopped = false
      let everConnected = false
      let handoffStarted = false
      let fail!: (error: unknown) => void
      const done = new Promise<void>((_, reject) => { fail = reject })
      function disconnected() {
        if (currentRun !== run || stopped || peers.size) return
        isLive.value = false
        if (everConnected) {
          step.value = "workspace-reconnecting"
          if (!handoffStarted) {
            handoffStarted = true
            void (async () => {
              await stopNode("Invitation peer disconnected")
              if (currentRun === run) await startDurableMesh()
            })()
          }
        }
      }
      const offline = () => {
        for (const connection of connections) void connection.close()
      }
      window.addEventListener("offline", offline)
      const group: LiveWorkspaceSync = {
        done,
        async publish() {
          await Promise.all([...peers.values()].map(async session => {
            try { await session.publish() } catch (err) {
              await session.close()
              if (!isNetworkFailure(err)) throw err
            }
          }))
        },
        async close() {
          stopped = true
          window.removeEventListener("offline", offline)
          await acceptor.close()
          await Promise.all([...connections].map(connection => connection.close()))
        },
      }
      attachLiveSession(group, currentRun)
      isLive.value = false
      async function receivePeer(connection: SyncConnection) {
        let session: LiveWorkspaceSync | undefined
        let personId = ""
        const timeout = setTimeout(() => { void connection.close() }, 600_000)
        connections.add(connection)
        try {
          const stream = await connection.acceptStream()
          const rawRequest = await stream.read()
          const header = inspectPairingFrame(rawRequest)
          // Trusted peers reconnect on the same endpoint even while an invitation is open.
          if (header.type === "mesh-handshake-request" && durableMesh) {
            await durableMesh.acceptOnInvitationNode(connection, stream, rawRequest)
            return
          }
          if (header.type !== "workspace-join-request" || header.secret !== secret) return
          const request = decodePairingFrame(rawRequest, "workspace-join-request", secret)
          const guest = JSON.parse(new TextDecoder().decode(request))
          if (typeof guest.personId !== "string" || !guest.personId || guest.invitationId !== invite.invitationId) {
            throw new Error("Invalid workspace join request.")
          }
          personId = guest.personId
          let result = grants.get(personId)
          if (!result) {
            if (Date.parse(invite.expiresAt) <= Date.now()) {
              await stream.send(encodePairingFrame("workspace-join-response", secret,
                new TextEncoder().encode(JSON.stringify({ error: "This invitation has expired." }))))
              await stream.closeSend()
              const rejectionAck = await connection.acceptStream()
              decodePairingFrame(await rejectionAck.read(), "sync-ack", secret)
              await rejectionAck.closeSend()
              return
            }
            const requestId = crypto.randomUUID()
            pendingJoins.value.push({ id: requestId, personId, name: typeof guest.displayName === "string" ? guest.displayName.slice(0, 80) : `Participant ${personId.slice(0, 6)}`, role: "visitor" })
            isOpen.value = true
            step.value = "workspace-host"
            const role = await new Promise<"visitor" | "editor" | null>(resolve => {
              const timer = setTimeout(() => decideJoin(requestId, false), 600_000)
              joinDecisions.set(requestId, value => { clearTimeout(timer); resolve(value) })
            })
            if (!role) {
              await stream.send(encodePairingFrame("workspace-join-response", secret, new TextEncoder().encode(JSON.stringify({ error: "The owner declined this request." }))))
              await stream.closeSend()
              const rejectionAck = await connection.acceptStream()
              decodePairingFrame(await rejectionAck.read(), "sync-ack", secret)
              await rejectionAck.closeSend()
              return
            }
            result = await defaultInvitationService.approveWorkspaceJoinSet(
              invite.invitationId, personId, workspacesToInvite.map(w => w.id), profile, owners, role,
            )
            if (!result.ok) throw new Error(result.error)
            for (const grant of result.grants) await defaultProofStore.putGrant(grant.payload.grantId, grant)
            await durableMesh?.acceptGuest(workspacesToInvite.map(w => w.id), guest.meshPeers, result.grants)
            grants.set(personId, result)
          }
          if (!result.ok) throw new Error(result.error)
          const payload = new TextEncoder().encode(JSON.stringify({
            grants: result.grants,
            snapshot: toBase64Url(await replica.snapshot()),
            meshWorkspaces: await durableMesh?.invitationPayload(workspacesToInvite.map(w => w.id)),
          }))
          await stream.send(encodePairingFrame("workspace-join-response", secret, payload))
          await stream.closeSend()
          const acknowledgement = await connection.acceptStream()
          await replica.receive(decodePairingFrame(await acknowledgement.read(), "sync-ack", secret))
          await acknowledgement.closeSend()
          if (currentRun !== run || stopped) return
          clearTimeout(timeout)
          session = liveWorkspaceSetSync(connection, secret, replica)
          const previous = peers.get(personId)
          peers.set(personId, session)
          directPeerSessions.set(personId, session)
          await previous?.close()
          everConnected = true
          isLive.value = true
          step.value = "synced"
          // Share merged offline changes with all connected devices.
          await group.publish()
          await session.done
        } catch (err) {
          if (!stopped && currentRun === run && !isNetworkFailure(err)) fail(err)
        } finally {
          clearTimeout(timeout)
          if (session && peers.get(personId) === session) peers.delete(personId)
          if (session && directPeerSessions.get(personId) === session) directPeerSessions.delete(personId)
          connections.delete(connection)
          await connection.close()
          disconnected()
        }
      }
      void (async () => {
        while (!stopped && currentRun === run) {
          const connection = await acceptor.accept()
          if (!connection) return
          void receivePeer(networkConnection(connection)).catch(fail)
        }
      })().catch(fail)
    } catch (err) {
      console.error("generateWorkspaceInvite failed", err)
      step.value = "error"
      error.value = userMessage(err, "Couldn’t generate invite.")
    }
  }

  function approveEnrollment() {
    if (step.value !== "enroll-host-pending") return
    approveResolve?.(true)
    approveResolve = undefined
  }

  function declineEnrollment() {
    approveResolve?.(false)
    approveResolve = undefined
  }

  // Guest visits /pair#...
  async function prepareJoin(rawInvite: string) {
    await close()
    isOpen.value = true

    try {
      // A saved relationship outlives its invitation. Never re-enroll or replace its grant.
      let savedInvite: ScopedInvitation | undefined
      try { savedInvite = parseInvitation(rawInvite, Number.NEGATIVE_INFINITY) } catch { /* Normal parsing below reports the invitation error. */ }
      if (savedInvite?.kind === "workspace-join" &&
        savedInvite.workspaces.every(ws => availableWorkspaces.value.some(item => item.id === ws.id)) &&
        await durableMesh?.knowsWorkspaceIssuer(savedInvite.workspaces.map(ws => ws.id), savedInvite.issuerPersonId, savedInvite.issuerDeviceId)) {
        await workspaceStore?.activate(savedInvite.workspaces[0]!.id)
        clearPairingLocation()
        isOpen.value = false
        await startDurableMesh()
        return
      }
      const invite = parseInvitation(rawInvite)
      parsedInvite.value = invite

      if (invite.kind === "device-enrollment") {
        step.value = "enroll-guest"
        authCode.value = await deriveTranscriptAuthCode(invite.secret, invite.invitationId, invite.issuerPublicKey)
      } else if (invite.kind === "workspace-join") {
        step.value = "workspace-guest"
        invitationWorkspaces.value = invite.workspaces || [{ id: invite.workspaceId, title: invite.workspaceTitle }]
        invitationWorkspaceTitle.value = invitationWorkspaces.value.map((w) => w.title).join(", ")
      }
    } catch (err) {
      step.value = "error"
      error.value = userMessage(err, "This pairing link is invalid.")
    }
  }

  function clearPairingLocation() {
    if (typeof window === "undefined") return
    const url = new URL(window.location.href)
    if (url.pathname.replace(/\/$/, "") !== "/pair") return
    url.pathname = "/"
    url.hash = ""
    window.history.replaceState(window.history.state, "", url)
  }

  async function requestEnrollment() {
    const invite = parsedInvite.value
    if (!invite || invite.kind !== "device-enrollment" || step.value !== "enroll-guest") return
    const currentRun = ++run
    let connection: SyncConnection | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    step.value = "enroll-guest-waiting"
    error.value = ""
    try {
      if (!workspaceStore || !durableMesh) throw new Error("Device sync is unavailable.")
      await pauseDurableMesh()
      await stopNode("Starting device enrollment")
      step.value = "enroll-guest-waiting"
      const profile = await getProfile()
      authCode.value = await deriveTranscriptAuthCode(invite.secret, invite.invitationId, profile.device.publicKey)
      const started = await startPersistentNode(transport)
      if (currentRun !== run) return void started.close("Replaced")
      node = started
      timeout = setTimeout(() => { void started.close("Enrollment timed out").catch(() => {}) }, 600_000)
      // Endpoint discovery may lag behind the QR. Retry dialing before sending a request.
      for (let attempt = 0; currentRun === run; attempt++) {
        try { connection = await dialPairingPeer(started, invite.issuerEndpoint); break }
        catch (err) {
          if (attempt >= 4) throw err
          await waitToReconnect(Math.min(1000 * 2 ** attempt, 5000))
        }
      }
      if (!connection || currentRun !== run) return
      const stream = await connection.openStream()
      await stream.send(encodePairingFrame("enroll-request", invite.secret, await createEnrollmentRequest(invite, profile)))
      await stream.closeSend()
      const response = decodePairingFrame(await stream.read(), "enroll-approved", invite.secret)
      if (currentRun !== run) return
      step.value = "enroll-syncing"
      const enrolled = await installEnrollment(response, invite, profile)
      await identityChanged?.()
      const ids = enrolled.workspaces.map(item => item.id)
      await durableMesh.receiveInvitation(enrolled.meshWorkspaces, ids, enrolled.profile, [])
      const replica = workspaceSet(meshWorkspaceStore ?? workspaceStore, ids)
      await replica.receive(fromBase64Url(enrolled.snapshot))
      await durableMesh.ensureOwnerWorkspaces(ids, started.endpointId, enrolled.profile)
      await workspaceStore.activate(ids[0]!)
      const ack = await connection.openStream()
      await ack.send(encodePairingFrame("enroll-ack", invite.secret, await replica.snapshot()))
      await ack.closeSend()
      decodePairingFrame(await ack.read(), "enroll-complete", invite.secret)
      if (currentRun !== run) return
      step.value = "enroll-guest-done"
      if (typeof window !== "undefined") window.history.replaceState(window.history.state, "", "/")
    } catch (err) {
      if (currentRun !== run) return
      step.value = "error"
      console.error("Device enrollment guest failed", err)
      error.value = userMessage(err, "Couldn’t add this device. Create a new link and try again.")
    } finally {
      clearTimeout(timeout)
      await connection?.close().catch(() => {})
      if (currentRun === run) {
        await stopNode("Enrollment finished")
        void startDurableMesh()
      }
    }
  }

  async function waitToReconnect(milliseconds: number) {
    await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(timer)
        window.removeEventListener("online", finish)
        if (wakeRetry === finish) wakeRetry = undefined
        resolve()
      }
      const timer = setTimeout(finish, milliseconds)
      wakeRetry = finish
      window.addEventListener("online", finish, { once: true })
    })
  }

  // Retry transport failures with the same invitation; saved documents are merged idempotently.
  async function acceptWorkspaceJoin() {
    const invite = parsedInvite.value
    if (!invite || invite.kind !== "workspace-join" || step.value === "workspace-guest-waiting") return
    await pauseDurableMesh()
    const currentRun = ++run
    step.value = "workspace-guest-waiting"
    error.value = ""
    try {
      if (!workspaceStore) throw new Error("Workspace sync is unavailable.")
      if (Date.parse(invite.expiresAt) <= Date.now()) throw new Error("This invitation has expired.")
      const profile = await getProfile()
      const replica = workspaceSet(meshWorkspaceStore ?? workspaceStore, invite.workspaces.map(w => w.id))
      let connectedBefore = false
      let attempts = 0
      while (currentRun === run) {
        let handoffToMesh = false
        if (!navigator.onLine) {
          step.value = "workspace-reconnecting"
          await waitToReconnect(15_000)
          continue
        }
        let connection: SyncConnection | undefined
        let session: LiveWorkspaceSync | undefined
        let started: SyncNode | undefined
        let disconnectError: unknown
        let timeout: ReturnType<typeof setTimeout> | undefined
        const offline = () => {
          if (currentRun !== run) return
          disconnectError = new SyncNetworkError("Network offline")
          isLive.value = false
          step.value = "workspace-reconnecting"
          void connection?.close()
          if (!connection) void started?.close("Network offline").catch(() => {})
        }
        window.addEventListener("offline", offline)
        try {
          started = await startPersistentNode(transport)
          if (currentRun !== run) return
          node = started
          timeout = setTimeout(() => { void started?.close("Connection timed out").catch(() => {}) }, 600_000)
          connection = networkConnection(await networkIO(dialPairingPeer(started, invite.issuerEndpoint)))
          if (currentRun !== run) return
          const stream = await connection.openStream()
          if (!connectedBefore) step.value = "workspace-guest-waiting"
          const request = new TextEncoder().encode(JSON.stringify({
            invitationId: invite.invitationId,
            personId: profile.identity.personId,
            displayName: displayName?.() || profile.identity.displayName,
            meshPeers: await durableMesh?.createGuestAdvertisements(invite.workspaces.map(w => w.id), started.endpointId, profile),
          }))
          await stream.send(encodePairingFrame("workspace-join-request", invite.secret, request))
          await stream.closeSend()
          const response = decodePairingFrame(await stream.read(), "workspace-join-response", invite.secret)
          const payload = JSON.parse(new TextDecoder().decode(response))
          if (typeof payload.error === "string") {
            const rejectionAck = await connection.openStream()
            await rejectionAck.send(encodePairingFrame("sync-ack", invite.secret, new Uint8Array()))
            await rejectionAck.closeSend()
            throw new Error(payload.error)
          }
          if (durableMesh && payload.meshWorkspaces === undefined) {
            throw new Error("The other device needs an update. Reload it and generate a new invitation.")
          }
          if (typeof payload.snapshot !== "string" || !Array.isArray(payload.grants) ||
            payload.grants.length !== invite.workspaces.length ||
            new Set(payload.grants.map((g: any) => g?.payload?.workspaceId)).size !== invite.workspaces.length ||
            payload.grants.some((g: any) => g?.payload?.personId !== profile.identity.personId ||
              !invite.workspaces.some(w => w.id === g?.payload?.workspaceId))) {
            throw new Error("The other device needs an update. Reload it and generate a new invitation.")
          }
          for (const grant of payload.grants) await defaultProofStore.putGrant(grant.payload.grantId, grant)
          if (currentRun !== run) return
          if (Array.isArray(payload.meshWorkspaces) && payload.meshWorkspaces.some((item: any) => item?.ownerPersonId !== invite.issuerPersonId)) throw new Error("Invitation owner mismatch")
          await durableMesh?.receiveInvitation(payload.meshWorkspaces, invite.workspaces.map(w => w.id), profile, payload.grants)
          await replica.receive(fromBase64Url(payload.snapshot))
          if (currentRun !== run) return
          if (!connectedBefore) await workspaceStore.activate(invite.workspaces[0]!.id)
          const acknowledgement = await connection.openStream()
          await acknowledgement.send(encodePairingFrame("sync-ack", invite.secret, await replica.snapshot()))
          await acknowledgement.closeSend()
          clearTimeout(timeout)
          session = liveWorkspaceSetSync(connection, invite.secret, replica)
          liveSession = session
          isLive.value = true
          step.value = "workspace-guest-done"
          liveWorkspaceIds.value = invite.workspaces.map(w => w.id)
          connectedBefore = true
          clearPairingLocation()
          attempts = 0
          const currentSession = session
          stopWatchingWorkspace = workspace.subscribe?.(() => {
            void currentSession.publish().catch(err => {
              disconnectError = err
              void currentSession.close()
            })
          })
          await session.publish()
          // Pairing has durably installed trust and data. Start the mesh immediately;
          // do not wait for a dead invitation connection to be detected by the transport.
          handoffToMesh = true
        } catch (err) {
          if (currentRun !== run) return
          if (!isNetworkFailure(err)) throw err
          step.value = "workspace-reconnecting"
          handoffToMesh = connectedBefore
        } finally {
          clearTimeout(timeout)
          window.removeEventListener("offline", offline)
          if (liveSession === session) {
            stopWatchingWorkspace?.()
            stopWatchingWorkspace = undefined
            liveSession = undefined
            isLive.value = false
          }
          await session?.close()
          await connection?.close()
          await started?.close("Reconnecting").catch(() => {})
          if (node === started) node = undefined
        }
        if (currentRun !== run) return
        if (handoffToMesh) {
          await startDurableMesh()
          return
        }
        await waitToReconnect(Math.min(1_000 * 2 ** attempts++, 15_000))
      }
    } catch (err) {
      if (currentRun !== run) return
      isLive.value = false
      step.value = "error"
      if (/access revoked/i.test(err instanceof Error ? err.message : String(err))) {
        revokedWorkspaceIds.value = [...new Set([...revokedWorkspaceIds.value, ...invite.workspaces.map(w => w.id)])]
      }
      console.error("Workspace sync failed", err)
      error.value = userMessage(err, "Couldn’t save the received workspaces.")
    }
  }

  function joinFromLocation(rawUrl: string) {
    const url = new URL(rawUrl)
    if (url.pathname.replace(/\/$/, "") !== "/pair" || !url.hash) return false
    void prepareJoin(rawUrl)
    return true
  }

  async function copyInvite(targetUrl?: string) {
    const urlToCopy = targetUrl || inviteUrl.value
    if (!urlToCopy) return
    try {
      await navigator.clipboard.writeText(urlToCopy)
      copyNotice.value = "Pairing link copied."
    } catch {
      copyNotice.value = "Clipboard unavailable. Select the pairing link and copy it manually."
    }
  }

  return {
    isOpen,
    pendingJoins,
    decideJoin,
    isLive,
    isWorkspaceLive: (id: string) => (isLive.value && liveWorkspaceIds.value.includes(id)) || meshLiveWorkspaceIds.value.includes(id),
    isWorkspaceAccessRevoked: (id: string) => revokedWorkspaceIds.value.includes(id),
    meshPeers,
    localDeviceId,
    ownershipRevision,
    step,
    phase,
    title,
    qrCode,
    inviteUrl,
    copyNotice,
    error,
    authCode,
    selectedWorkspaceId,
    selectedWorkspaceIds,
    invitationWorkspaceTitle,
    invitationWorkspaces,
    availableWorkspaces,
    open,
    selectSyncAll,
    selectSyncWorkspace,
    generateWorkspaceInvite,
    approveEnrollment,
    declineEnrollment,
    enrollmentDeviceName,
    requestEnrollment,
    acceptWorkspaceJoin,
    prepareJoin,
    joinFromLocation,
    startDurableMesh,
    shutdown,
    revokePeer,
    transferOwnership,
    copyInvite,
    close,
    dismiss,
  }
}
