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
  PairingError,
} from "./protocol"
import { irohTransport } from "./irohTransport"
import { defaultInvitationService, deriveTranscriptAuthCode } from "./invitations"
import { bootstrapIdentity, fromBase64Url, toBase64Url, type LocalProfile } from "../domain/identity"
import { acceptWorkspaceSync, joinWorkspaceSync, liveWorkspaceSync, type LiveWorkspaceSync, type WorkspaceReplica } from "./session"
import type { SyncAcceptor, SyncConnection, SyncNode, SyncTransport } from "./transport"
import { defaultProofStore, certHashDefault } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { ReplicationService } from "./replication"
import { workspaceSet, liveWorkspaceSetSync, networkConnection, networkIO, SyncNetworkError, isNetworkFailure, type WorkspaceSetStore } from "./workspaceSet"
import { DurableMesh, startPersistentNode, type MeshPeerView } from "./durableMesh"

export type SyncStep =
  | "idle"
  | "chooser"
  | "workspace-select"
  | "enroll-host"
  | "enroll-host-pending"
  | "enroll-host-done"
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
  const meshLiveWorkspaceIds = ref<string[]>([])
  const revokedWorkspaceIds = ref<string[]>([])

  let node: SyncNode | undefined
  let liveSession: LiveWorkspaceSync | undefined
  const directPeerSessions = new Map<string, LiveWorkspaceSync>()
  let stopWatchingWorkspace: (() => void) | undefined
  let run = 0
  let wakeRetry: (() => void) | undefined
  let approveResolve: (() => void) | undefined
  let currentIssuedInvite: DeviceEnrollmentInvitation | WorkspaceJoinInvitation | undefined
  let pendingEnrollGuest: { deviceId: string; publicKey: string; displayName?: string } | undefined
  const meshWorkspaceStore: WorkspaceSetStore | undefined = workspaceStore ? { ...workspaceStore } : undefined
  const durableMesh = workspaceStore && meshWorkspaceStore ? new DurableMesh({
    transport,
    workspaceStore: meshWorkspaceStore,
    workspace,
    getProfile,
    onChange(ids, peers) {
      meshLiveWorkspaceIds.value = ids
      meshPeers.value = peers
      if (ids.length > 0) isLive.value = true
      else if (!liveSession) isLive.value = false
    },
  }) : undefined
  if (durableMesh && meshWorkspaceStore) {
    meshWorkspaceStore.readMesh = id => durableMesh.exportWorkspace(id)
    meshWorkspaceStore.mergeMesh = (id, value) => durableMesh.mergeWorkspace(id, value)
  }

  const channel = typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("match-scoped-sync")
    : null

  if (channel) {
    channel.onmessage = async (event) => {
      const data = event.data
      if (!data) return
      if (data.type === "enroll-request" && step.value === "enroll-host") {
        authCode.value = data.authCode
        if (data.guestInfo) {
          pendingEnrollGuest = data.guestInfo
        }
        step.value = "enroll-host-pending"
      } else if (data.type === "enroll-approved") {
        if (data.certificate) {
          try {
            const certHash = await certHashDefault(data.certificate)
            await defaultProofStore.putCertificate(certHash, data.certificate)
          } catch {}
        }
        if (data.personalRoot) {
          try {
            await defaultStorage.savePersonalRoot(data.personalRoot)
          } catch {}
        }
        if (step.value === "enroll-guest-waiting") {
          step.value = "enroll-guest-done"
        }

      }
    }
  }

  const phase = computed<SyncPhase>(() => {
    if (step.value === "error") return "error"
    if (step.value === "synced") return "synced"
    return "idle"
  })

  const title = computed(() => {
    if (step.value === "error") return "Couldn’t sync"
    if (step.value === "enroll-guest" || step.value === "enroll-guest-waiting" || step.value === "enroll-guest-done") {
      return "Enroll this device"
    }
    if (step.value === "workspace-guest" || step.value === "workspace-guest-waiting" || step.value === "workspace-guest-done") {
      return "Join workspace"
    }
    if (step.value === "synced") return "Live sync on"
    return "Device sync"
  })

  async function stopNode(reason: string) {
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
    await current?.close(reason)
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
    await durableMesh?.dispose()
    await stopNode("Page closed")
    channel?.close()
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
    approveResolve = undefined
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
    if (step.value === "workspace-reconnecting" || step.value === "workspace-guest-waiting") {
      isOpen.value = true
      return
    }
    if (isLive.value) {
      isOpen.value = true
      step.value = "synced"
      return
    }
    isOpen.value = true
    step.value = "workspace-select"
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
    return bootstrapIdentity("My Device")
  }

  // Flow 1: Host selects "Sync all"
  async function selectSyncAll() {
    await pauseDurableMesh()
    await stopNode("Starting enroll host")
    const currentRun = ++run
    copyNotice.value = ""
    error.value = ""

    try {
      const profile = await getProfile()
      const started = await startPersistentNode(transport)
      if (currentRun !== run) return void started.close("Replaced")
      node = started

      const secret = createPairingSecret()
      const invite = createDeviceEnrollmentInvite(started.endpointId, secret, profile)
      currentIssuedInvite = invite
      await defaultInvitationService.saveIssuedInvitation(invite)

      inviteUrl.value = invitationUrl(origin(), invite)
      qrCode.value = await QRCode.toDataURL(inviteUrl.value, { width: 240, margin: 2, errorCorrectionLevel: "M" })

      // Pre-compute expected auth code
      const computedAuthCode = await deriveTranscriptAuthCode(secret, invite.invitationId, invite.issuerPublicKey)
      authCode.value = computedAuthCode
      step.value = "enroll-host"

      const hostEnrollPoll = setInterval(async () => {
        if (step.value !== "enroll-host") {
          clearInterval(hostEnrollPoll)
          return
        }
        try {
          const res = await fetch("/api/sync-signal?topic=enroll")
          const ct = res.headers.get("content-type") || ""
          if (res.ok && ct.includes("application/json")) {
            const list = await res.json()
            if (Array.isArray(list)) {
              const req = list.find((m: any) => m.type === "enroll-request")
              if (req) {
                authCode.value = req.authCode
                if (req.guestInfo) pendingEnrollGuest = req.guestInfo
                step.value = "enroll-host-pending"
              }
            }
          }
        } catch {}
      }, 200)

      // Unified incoming connection handler
      void (async () => {
        let acceptor: SyncAcceptor | undefined
        try {
          acceptor = await started.accept()
          const connection = await acceptor.accept()
          if (!connection) return

          const stream = await connection.acceptStream()
          const rawBytes = await stream.read()
          const separator = rawBytes.indexOf(10)
          if (separator < 0) return

          let header: { type?: string } = {}
          try {
            header = JSON.parse(new TextDecoder().decode(rawBytes.slice(0, separator)))
          } catch {}

          if (header.type === "enroll-request") {
            const reqBytes = decodePairingFrame(rawBytes, "enroll-request", secret)
            let guestInfo = { deviceId: "guest_device", publicKey: "guest_pubkey", displayName: "Guest device" }
            try {
              guestInfo = JSON.parse(new TextDecoder().decode(reqBytes))
            } catch {}
            pendingEnrollGuest = guestInfo

            step.value = "enroll-host-pending"
            await new Promise<void>((resolve) => {
              approveResolve = resolve
            })

            const certRes = await defaultInvitationService.approveEnrollment(
              invite.invitationId,
              { deviceId: guestInfo.deviceId, publicKey: guestInfo.publicKey },
              profile
            )

            if (certRes.ok) {
              const certHash = await certHashDefault(certRes.certificate)
              await defaultProofStore.putCertificate(certHash, certRes.certificate)
            }

            const personalRoot = await defaultStorage.loadPersonalRoot()
            const responsePayload = {
              certificate: certRes.ok ? certRes.certificate : null,
              personalRoot,
            }

            const certBytes = new TextEncoder().encode(JSON.stringify(responsePayload))
            await stream.send(encodePairingFrame("enroll-approved", secret, certBytes))
            await stream.closeSend()
            step.value = "enroll-host-done"
          } else if (header.type === "sync-request") {
            await workspace.mergeBytes(decodePairingFrame(rawBytes, "sync-request", secret))
            await stream.send(encodePairingFrame("sync-response", secret, workspace.getBytes()))
            await stream.closeSend()

            const ackStream = await connection.acceptStream()
            decodePairingFrame(await ackStream.read(), "sync-ack", secret)
            await ackStream.closeSend()

            const repl = new ReplicationService(profile.device.deviceId, defaultProofStore)
            repl.registerPeer("guest", { kind: "all" })

            const session = liveWorkspaceSync(connection, secret, workspace, {
              peerId: "guest",
              workspaceId: "default",
              replicationService: repl,
            })
            attachLiveSession(session, currentRun)
            step.value = "synced"
          }
        } catch (e) {
          console.warn("Unified host connection error", e)
        } finally {
          await acceptor?.close()
        }
      })()
    } catch (err) {
      console.error("selectSyncAll failed", err)
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
      currentIssuedInvite = invite
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
          // A durable peer may dial this stable endpoint while a fresh invitation is open.
          // Its mesh handshake belongs to the background mesh listener, not this invitation.
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

  // Host clicks "Approve device"
  async function approveEnrollment() {
    let certRes: any
    let personalRoot: any
    try {
      const profile = await getProfile()
      const invite = currentIssuedInvite as DeviceEnrollmentInvitation | undefined
      if (invite && pendingEnrollGuest) {
        certRes = await defaultInvitationService.approveEnrollment(
          invite.invitationId,
          { deviceId: pendingEnrollGuest.deviceId, publicKey: pendingEnrollGuest.publicKey },
          profile
        )
        if (certRes.ok) {
          const certHash = await certHashDefault(certRes.certificate)
          await defaultProofStore.putCertificate(certHash, certRes.certificate)
        }
      }
      personalRoot = await defaultStorage.loadPersonalRoot()
    } catch (e) {
      console.warn("approveEnrollment error", e)
    }

    if (approveResolve) {
      approveResolve()
      approveResolve = undefined
    }
    step.value = "enroll-host-done"
    const approvalPayload = {
      type: "enroll-approved",
      certificate: certRes?.ok ? certRes.certificate : null,
      personalRoot,
    }
    if (channel) {
      channel.postMessage(approvalPayload)
    }
    try {
      await fetch("/api/sync-signal?topic=enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(approvalPayload),
      })
    } catch {}
  }

  // Guest visits /pair#...
  async function prepareJoin(rawInvite: string) {
    await close()
    await pauseDurableMesh()
    isOpen.value = true

    try {
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

  // Guest clicks "Request enrollment"
  async function requestEnrollment() {
    const invite = parsedInvite.value
    if (!invite || invite.kind !== "device-enrollment") return
    await pauseDurableMesh()

    step.value = "enroll-guest-waiting"
    const profile = await getProfile()
    const guestInfo = {
      deviceId: profile.device.deviceId,
      publicKey: profile.device.publicKey,
      displayName: profile.device.displayName,
    }

    if (channel) {
      channel.postMessage({
        type: "enroll-request",
        invitationId: invite.invitationId,
        authCode: authCode.value,
        guestInfo,
      })
    }

    try {
      await fetch("/api/sync-signal?topic=enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "enroll-request",
          invitationId: invite.invitationId,
          authCode: authCode.value,
          guestInfo,
        }),
      })
    } catch {}

    const pollInterval = setInterval(async () => {
      if (step.value === "enroll-guest-done") {
        clearInterval(pollInterval)
        return
      }
      try {
        const res = await fetch("/api/sync-signal?topic=enroll")
        const contentType = res.headers.get("content-type") || ""
        if (res.ok && contentType.includes("application/json")) {
          const list = await res.json()
          if (Array.isArray(list)) {
            const approved = list.find((m: any) => m.type === "enroll-approved")
            if (approved) {
              if (approved.certificate) {
                const certHash = await certHashDefault(approved.certificate)
                await defaultProofStore.putCertificate(certHash, approved.certificate)
              }
              if (approved.personalRoot) {
                await defaultStorage.savePersonalRoot(approved.personalRoot)
              }
              clearInterval(pollInterval)
              step.value = "enroll-guest-done"
            }
          }
        }
      } catch {}
    }, 200)

    try {
      const started = await startPersistentNode(transport)
      node = started
      const connection = await started.dial(invite.issuerEndpoint)
      const stream = await connection.openStream()
      const reqBytes = new TextEncoder().encode(JSON.stringify(guestInfo))
      await stream.send(encodePairingFrame("enroll-request", invite.secret, reqBytes))

      const response = await stream.read()
      const respBytes = decodePairingFrame(response, "enroll-approved", invite.secret)
      try {
        const payload = JSON.parse(new TextDecoder().decode(respBytes))
        if (payload.certificate) {
          const certHash = await certHashDefault(payload.certificate)
          await defaultProofStore.putCertificate(certHash, payload.certificate)
        }
        if (payload.personalRoot) {
          await defaultStorage.savePersonalRoot(payload.personalRoot)
        }
      } catch {}
      await stream.closeSend()

      clearInterval(pollInterval)
      step.value = "enroll-guest-done"
    } catch (e) {
      console.warn("P2P enrollment dial in progress or handled by channel", e)
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
          connection = networkConnection(await networkIO(started.dial(invite.issuerEndpoint)))
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
          if (typeof payload.error === "string") throw new Error(payload.error)
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
          attempts = 0
          const currentSession = session
          stopWatchingWorkspace = workspace.subscribe?.(() => {
            void currentSession.publish().catch(err => {
              disconnectError = err
              void currentSession.close()
            })
          })
          await session.publish()
          await session.done
          if (disconnectError) throw disconnectError
          if (currentRun === run) throw new SyncNetworkError("Connection closed")
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

  async function connectToMesh() {
    const invite = parsedInvite.value
    if (!invite) return
    await pauseDurableMesh()
    if (invite.kind === "workspace-join") return acceptWorkspaceJoin()
    const currentRun = ++run
    try {
      const started = await startPersistentNode(transport)
      node = started
      const profile = await getProfile()
      const repl = new ReplicationService(profile.device.deviceId, defaultProofStore)
      repl.registerPeer("host", { kind: "all" })

      const session = await joinWorkspaceSync(
        started,
        {
          version: "0.0.1",
          endpoint: invite.issuerEndpoint,
          secret: invite.secret,
        },
        workspace,
        {
          peerId: "host",
          workspaceId: "default",
          replicationService: repl,
        }
      )
      if (currentRun !== run) return void session.close()
      attachLiveSession(session, currentRun)
      step.value = "synced"
    } catch (e) {
      console.warn("connectToMesh error", e)
      step.value = "error"
      error.value = userMessage(e, "Couldn’t connect to peer.")
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
    requestEnrollment,
    acceptWorkspaceJoin,
    connectToMesh,
    prepareJoin,
    joinFromLocation,
    startDurableMesh,
    shutdown,
    revokePeer,
    copyInvite,
    close,
    dismiss,
  }
}
