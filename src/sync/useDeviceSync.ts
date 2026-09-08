import { computed, ref } from "vue"
import QRCode from "qrcode"
import { createPairingInvite, createPairingSecret, pairingInviteUrl, parsePairingInvite } from "./protocol"
import { irohTransport } from "./irohTransport"
import { acceptWorkspaceSync, joinWorkspaceSync, type LiveWorkspaceSync, type WorkspaceReplica } from "./session"
import type { SyncNode, SyncTransport } from "./transport"

export type SyncPhase = "idle" | "preparing" | "ready" | "join-ready" | "joining" | "synced" | "error"

type DeviceSyncOptions = {
  workspace: WorkspaceReplica
  origin: () => string
  transport?: SyncTransport
}

function userMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message === "Invalid pairing link") return "This pairing link is invalid."
  return fallback
}

export function useDeviceSync({ workspace, origin, transport = irohTransport }: DeviceSyncOptions) {
  const isOpen = ref(false)
  const isLive = ref(false)
  const phase = ref<SyncPhase>("idle")
  const qrCode = ref("")
  const inviteUrl = ref("")
  const copyNotice = ref("")
  const error = ref("")
  const pendingInvite = ref("")
  let node: SyncNode | undefined
  let liveSession: LiveWorkspaceSync | undefined
  let stopWatchingWorkspace: (() => void) | undefined
  let run = 0

  const title = computed(() => {
    if (phase.value === "synced") return "Live sync on"
    if (phase.value === "error") return "Couldn’t sync"
    return "Pair a device"
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

  async function close() {
    run += 1
    isOpen.value = false
    phase.value = "idle"
    qrCode.value = ""
    inviteUrl.value = ""
    copyNotice.value = ""
    error.value = ""
    pendingInvite.value = ""
    await stopNode("Pairing closed")
  }

  function dismiss() {
    isOpen.value = false
  }

  function attachLiveSession(session: LiveWorkspaceSync, currentRun: number) {
    liveSession = session
    isLive.value = true
    stopWatchingWorkspace = workspace.subscribe?.(() => {
      void session.publish().catch((syncError) => {
        if (currentRun !== run) return
        console.error("Match live sync publish failed", syncError)
        phase.value = "error"
        error.value = "Live sync stopped. Pair again."
        void stopNode("Live sync failed")
      })
    })
    void session.done.catch((syncError) => {
      if (currentRun !== run) return
      console.error("Match live sync receive failed", syncError)
      phase.value = "error"
      error.value = "Live sync stopped. Pair again."
      void stopNode("Live sync failed")
    })
  }

  async function host() {
    await close()
    const currentRun = ++run
    isOpen.value = true
    phase.value = "preparing"

    try {
      const started = await transport.start()
      if (currentRun !== run) return void started.close("Pairing replaced")
      node = started
      const secret = createPairingSecret()
      inviteUrl.value = pairingInviteUrl(origin(), createPairingInvite(started.endpointId, secret))
      qrCode.value = await QRCode.toDataURL(inviteUrl.value, { width: 240, margin: 2, errorCorrectionLevel: "M" })
      if (currentRun !== run) return
      phase.value = "ready"

      void acceptWorkspaceSync(started, secret, workspace)
        .then((session) => {
          if (currentRun !== run) return void session.close()
          attachLiveSession(session, currentRun)
          phase.value = "synced"
        })
        .catch((syncError) => {
          console.error("Match device sync failed", syncError)
          if (currentRun === run) {
            phase.value = "error"
            error.value = userMessage(syncError, "Generate a new QR and try again.")
          }
        })
    } catch (syncError) {
      console.error("Match device sync failed", syncError)
      if (currentRun === run) {
        phase.value = "error"
        error.value = userMessage(syncError, "Couldn’t start device sync. Try again.")
      }
    }
  }

  async function join(rawInvite: string) {
    await close()
    const currentRun = ++run
    isOpen.value = true
    phase.value = "joining"

    try {
      const invite = parsePairingInvite(rawInvite)
      const started = await transport.start()
      if (currentRun !== run) return void started.close("Pairing replaced")
      node = started
      const session = await joinWorkspaceSync(started, invite, workspace)
      if (currentRun !== run) return void session.close()
      attachLiveSession(session, currentRun)
      if (currentRun === run) phase.value = "synced"
    } catch (syncError) {
      console.error("Match device sync failed", syncError)
      if (currentRun === run) {
        phase.value = "error"
        error.value = userMessage(syncError, "Generate a new QR and try again.")
      }
    }
  }

  async function prepareJoin(rawInvite: string) {
    await close()
    const currentRun = ++run
    isOpen.value = true
    try {
      parsePairingInvite(rawInvite)
      if (currentRun !== run) return
      pendingInvite.value = rawInvite
      phase.value = "join-ready"
    } catch (syncError) {
      if (currentRun === run) {
        phase.value = "error"
        error.value = userMessage(syncError, "This pairing link is invalid.")
      }
    }
  }

  function connectToMesh() {
    if (pendingInvite.value) void join(pendingInvite.value)
  }

  function joinFromLocation(rawUrl: string) {
    const url = new URL(rawUrl)
    if (url.pathname.replace(/\/$/, "") !== "/pair" || !url.hash) return
    window.history.replaceState({}, "", "/")
    void prepareJoin(rawUrl)
  }

  async function copyInvite() {
    if (!inviteUrl.value) return
    try {
      await navigator.clipboard.writeText(inviteUrl.value)
      copyNotice.value = "Pairing link copied."
    } catch {
      copyNotice.value = "Clipboard unavailable. Select the pairing link and copy it manually."
    }
  }

  async function open() {
    if (liveSession) {
      isOpen.value = true
      return
    }
    await host()
  }

  return { isOpen, isLive, phase, qrCode, inviteUrl, copyNotice, error, title, open, host, prepareJoin, connectToMesh, joinFromLocation, copyInvite, close, dismiss }
}
