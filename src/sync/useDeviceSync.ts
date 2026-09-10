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
  type ScopedInvitation,
  type DeviceEnrollmentInvitation,
  type WorkspaceJoinInvitation,
  PairingError,
} from "./protocol"
import { irohTransport } from "./irohTransport"
import { defaultInvitationService, deriveTranscriptAuthCode } from "./invitations"
import { bootstrapIdentity, type LocalProfile } from "../domain/identity"
import { acceptWorkspaceSync, joinWorkspaceSync, liveWorkspaceSync, type LiveWorkspaceSync, type WorkspaceReplica } from "./session"
import type { SyncAcceptor, SyncConnection, SyncNode, SyncTransport } from "./transport"
import { defaultProofStore, certHashDefault } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { ReplicationService } from "./replication"

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
  | "workspace-guest-done"
  | "synced"
  | "error"

export type SyncPhase = "idle" | "preparing" | "ready" | "join-ready" | "joining" | "synced" | "error"

type DeviceSyncOptions = {
  workspace: WorkspaceReplica
  origin: () => string
  transport?: SyncTransport
  availableWorkspaces?: Ref<{ id: string; title: string }[]>
  activeWorkspaceId?: () => string
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
  origin,
  transport = irohTransport,
  availableWorkspaces = ref([]),
  activeWorkspaceId,
}: DeviceSyncOptions) {
  const isOpen = ref(false)
  const isLive = ref(false)
  const step = ref<SyncStep>("idle")
  const qrCode = ref("")
  const inviteUrl = ref("")
  const copyNotice = ref("")
  const error = ref("")
  const authCode = ref("")
  const selectedWorkspaceId = ref("")
  const selectedWorkspaceIds = ref<string[]>([])
  const invitationWorkspaceTitle = ref("")
  const invitationWorkspaces = ref<{ id: string; title: string }[]>([])
  const parsedInvite = ref<ScopedInvitation | null>(null)

  let node: SyncNode | undefined
  let liveSession: LiveWorkspaceSync | undefined
  let stopWatchingWorkspace: (() => void) | undefined
  let run = 0
  let approveResolve: (() => void) | undefined
  let currentIssuedInvite: DeviceEnrollmentInvitation | WorkspaceJoinInvitation | undefined
  let pendingEnrollGuest: { deviceId: string; publicKey: string; displayName?: string } | undefined

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
      } else if (data.type === "workspace-joined" && step.value === "workspace-host") {
        try {
          const profile = await getProfile()
          const invite = currentIssuedInvite as WorkspaceJoinInvitation | undefined
          const guestInfo = data.guestInfo || { personId: "guest_person", publicKey: "" }
          const targetWorkspaces = invite?.workspaces || (invite?.workspaceId ? [{ id: invite.workspaceId, title: invite.workspaceTitle }] : [])
          const invId = data.invitationId || invite?.invitationId || ""
          const grantRes = await defaultInvitationService.approveWorkspaceJoinSet(
            invId,
            guestInfo.personId,
            targetWorkspaces.map((w) => w.id),
            profile
          )
          if (grantRes.ok) {
            for (const g of grantRes.grants) {
              await defaultProofStore.putGrant(g.payload.grantId, g)
            }
            channel.postMessage({
              type: "workspace-join-granted",
              invitationId: invId,
              grants: grantRes.grants,
            })
          }
        } catch (err) {
          console.warn("Failed to approve workspace-joined via channel", err)
        }
        step.value = "workspace-guest-done"
      } else if (data.type === "workspace-join-granted") {
        if (Array.isArray(data.grants)) {
          for (const g of data.grants) {
            if (g?.payload?.grantId) {
              await defaultProofStore.putGrant(g.payload.grantId, g)
            }
          }
        } else if (data.grant?.payload?.grantId) {
          await defaultProofStore.putGrant(data.grant.payload.grantId, data.grant)
        }
        if (invitationWorkspaces.value.length > 0) {
          for (const ws of invitationWorkspaces.value) {
            await defaultStorage.registerWorkspace(ws.id, ws.title)
          }
        } else if (data.workspaceId) {
          await defaultStorage.registerWorkspace(data.workspaceId, invitationWorkspaceTitle.value || "Workspace")
        }
        step.value = "workspace-guest-done"
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
    if (step.value === "workspace-guest" || step.value === "workspace-guest-done") {
      return "Join workspace"
    }
    if (step.value === "synced") return "Live sync on"
    return "Device sync"
  })

  async function stopNode(reason: string) {
    stopWatchingWorkspace?.()
    stopWatchingWorkspace = undefined
    const session = liveSession
    liveSession = undefined
    isLive.value = false
    await session?.close()
    const current = node
    node = undefined
    await current?.close(reason)
  }

  function attachLiveSession(session: LiveWorkspaceSync, currentRun: number) {
    liveSession = session
    isLive.value = true
    // Keep the invitation intact for scanner-to-browser handoff and retries.
    // Remove its secret only after the live session has connected successfully.
    if (typeof window !== "undefined" && window.location.pathname.replace(/\/$/, "") === "/pair" && window.location.hash) {
      window.history.replaceState({}, "", "/")
    }
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
  }

  function dismiss() {
    isOpen.value = false
  }

  // Open workspace selection without starting a node
  function open() {
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
    await stopNode("Starting enroll host")
    const currentRun = ++run
    copyNotice.value = ""
    error.value = ""

    try {
      const profile = await getProfile()
      const started = await transport.start()
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
    await stopNode("Starting workspace host")
    const currentRun = ++run
    copyNotice.value = ""
    error.value = ""

    try {
      const profile = await getProfile()
      const started = await transport.start()
      if (currentRun !== run) return void started.close("Replaced")
      node = started

      const selectedWs = availableWorkspaces.value.filter((w) => selectedWorkspaceIds.value.includes(w.id))
      const workspacesToInvite = selectedWs.length > 0
        ? selectedWs
        : selectedWorkspaceIds.value.map((id) => ({ id, title: "Workspace" }))

      const secret = createPairingSecret()
      const invite = createWorkspaceJoinInvite(started.endpointId, secret, profile, workspacesToInvite)
      currentIssuedInvite = invite
      await defaultInvitationService.saveIssuedInvitation(invite)

      inviteUrl.value = invitationUrl(origin(), invite)
      qrCode.value = await QRCode.toDataURL(inviteUrl.value, { width: 240, margin: 2, errorCorrectionLevel: "M" })
      step.value = "workspace-host"

      const hostWsPoll = setInterval(async () => {
        if (step.value !== "workspace-host") {
          clearInterval(hostWsPoll)
          return
        }
        try {
          const res = await fetch("/api/sync-signal?topic=workspace")
          const ct = res.headers.get("content-type") || ""
          if (res.ok && ct.includes("application/json")) {
            const list = await res.json()
            if (Array.isArray(list)) {
              const req = list.find((m: any) => m.type === "workspace-joined")
              if (req) {
                clearInterval(hostWsPoll)
                const guestInfo = req.guestInfo || { personId: "guest_person", publicKey: "" }
                const targetWsIds = workspacesToInvite.map((w) => w.id)
                const grantRes = await defaultInvitationService.approveWorkspaceJoinSet(
                  req.invitationId || invite.invitationId,
                  guestInfo.personId,
                  targetWsIds,
                  profile
                )
                if (grantRes.ok) {
                  for (const g of grantRes.grants) {
                    await defaultProofStore.putGrant(g.payload.grantId, g)
                  }
                  await fetch("/api/sync-signal?topic=workspace", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      type: "workspace-join-granted",
                      invitationId: req.invitationId || invite.invitationId,
                      workspaceIds: targetWsIds,
                      grants: grantRes.grants,
                    }),
                  })
                }
              }
            }
          }
        } catch {}
      }, 200)

      // Listen for incoming join request
      void (async () => {
        try {
          const acceptor = await started.accept()
          const connection = await acceptor.accept()
          if (!connection) return

          const stream = await connection.acceptStream()
          const raw = await stream.read()
          const requestBytes = decodePairingFrame(raw, "workspace-join-request", secret)
          let guestInfo = { personId: "guest_person", publicKey: "" }
          try {
            guestInfo = JSON.parse(new TextDecoder().decode(requestBytes))
          } catch {}

          const grantRes = await defaultInvitationService.approveWorkspaceJoinSet(
            invite.invitationId,
            guestInfo.personId,
            workspacesToInvite.map((w) => w.id),
            profile
          )

          if (grantRes.ok) {
            for (const g of grantRes.grants) {
              await defaultProofStore.putGrant(g.payload.grantId, g)
            }
          }

          const grantBytes = new TextEncoder().encode(JSON.stringify(grantRes.ok ? grantRes.grants : []))
          await stream.send(encodePairingFrame("workspace-join-response", secret, grantBytes))
          await stream.closeSend()
        } catch (e) {
          console.error("Workspace host connection error", e)
        }
      })()
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
      const started = await transport.start()
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

  // Guest clicks "Accept and join"
  async function acceptWorkspaceJoin() {
    const invite = parsedInvite.value
    if (!invite || invite.kind !== "workspace-join") return

    const profile = await getProfile()
    const guestInfo = {
      personId: profile.identity.personId,
      publicKey: profile.device.publicKey,
      displayName: profile.device.displayName,
    }

    const targetWorkspaces = invite.workspaces || [{ id: invite.workspaceId, title: invite.workspaceTitle }]
    const wsIds = targetWorkspaces.map((w) => w.id)

    if (channel) {
      channel.postMessage({
        type: "workspace-joined",
        invitationId: invite.invitationId,
        workspaceId: invite.workspaceId,
        workspaceIds: wsIds,
        guestInfo,
      })
    }

    try {
      await fetch("/api/sync-signal?topic=workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "workspace-joined",
          invitationId: invite.invitationId,
          workspaceId: invite.workspaceId,
          workspaceIds: wsIds,
          guestInfo,
        }),
      })
    } catch {}

    const wsPoll = setInterval(async () => {
      if (step.value === "workspace-guest-done") {
        clearInterval(wsPoll)
        return
      }
      try {
        const res = await fetch("/api/sync-signal?topic=workspace")
        const ct = res.headers.get("content-type") || ""
        if (res.ok && ct.includes("application/json")) {
          const list = await res.json()
          if (Array.isArray(list)) {
            const granted = list.find((m: any) => m.type === "workspace-join-granted")
            if (granted) {
              clearInterval(wsPoll)
              if (Array.isArray(granted.grants)) {
                for (const g of granted.grants) {
                  if (g?.payload?.grantId) {
                    await defaultProofStore.putGrant(g.payload.grantId, g)
                  }
                }
              } else if (granted.grant?.payload?.grantId) {
                await defaultProofStore.putGrant(granted.grant.payload.grantId, granted.grant)
              }
              for (const ws of targetWorkspaces) {
                await defaultStorage.registerWorkspace(ws.id, ws.title)
              }
              step.value = "workspace-guest-done"
            }
          }
        }
      } catch {}
    }, 200)

    for (const ws of targetWorkspaces) {
      await defaultStorage.registerWorkspace(ws.id, ws.title)
    }
    step.value = "workspace-guest-done"

    void (async () => {
      try {
        const started = await transport.start()
        node = started
        const connection = await started.dial(invite.issuerEndpoint)
        const stream = await connection.openStream()
        const reqBytes = new TextEncoder().encode(JSON.stringify(guestInfo))
        await stream.send(encodePairingFrame("workspace-join-request", invite.secret, reqBytes))

        const response = await stream.read()
        const respBytes = decodePairingFrame(response, "workspace-join-response", invite.secret)
        try {
          const grantsOrGrant = JSON.parse(new TextDecoder().decode(respBytes))
          if (Array.isArray(grantsOrGrant)) {
            for (const g of grantsOrGrant) {
              if (g?.payload?.grantId) {
                await defaultProofStore.putGrant(g.payload.grantId, g)
              }
            }
          } else if (grantsOrGrant?.payload?.grantId) {
            await defaultProofStore.putGrant(grantsOrGrant.payload.grantId, grantsOrGrant)
          }
          for (const ws of targetWorkspaces) {
            await defaultStorage.registerWorkspace(ws.id, ws.title)
          }
        } catch {}
        await stream.closeSend()
      } catch (e) {
        console.warn("P2P workspace join in progress or handled by channel", e)
      }
    })()
  }

  function joinFromLocation(rawUrl: string) {
    const url = new URL(rawUrl)
    if (url.pathname.replace(/\/$/, "") !== "/pair" || !url.hash) return
    void prepareJoin(rawUrl)
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
    const currentRun = ++run
    try {
      const started = await transport.start()
      node = started
      const profile = await getProfile()
      const repl = new ReplicationService(profile.device.deviceId, defaultProofStore)
      if (invite.kind === "device-enrollment") {
        repl.registerPeer("host", { kind: "all" })
      } else {
        const wsIds = invite.workspaces?.map((w) => w.id) || [invite.workspaceId]
        repl.registerPeer("host", { kind: "workspaces", workspaceIds: wsIds })
      }

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
          workspaceId: invite.kind === "workspace-join" ? invite.workspaceId : "default",
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
    isLive,
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
    copyInvite,
    close,
    dismiss,
  }
}
