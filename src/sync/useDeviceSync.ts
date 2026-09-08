import { computed, ref } from "vue"
import QRCode from "qrcode"
import { createPairingInvite, createPairingSecret, pairingInviteUrl, parsePairingInvite } from "./protocol"
import { irohTransport } from "./irohTransport"
import { acceptWorkspaceSync, joinWorkspaceSync, type WorkspaceReplica } from "./session"
import type { SyncNode, SyncTransport } from "./transport"

export type SyncPhase = "idle" | "preparing" | "ready" | "joining" | "synced" | "error"

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
  const phase = ref<SyncPhase>("idle")
  const qrCode = ref("")
  const inviteUrl = ref("")
  const error = ref("")
  let node: SyncNode | undefined
  let run = 0

  const title = computed(() => {
    if (phase.value === "synced") return "Devices synced"
    if (phase.value === "error") return "Couldn’t sync"
    return "Pair a device"
  })

  async function stopNode(reason: string) {
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
    error.value = ""
    await stopNode("Pairing closed")
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
        .then(() => {
          if (currentRun === run) phase.value = "synced"
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
      await joinWorkspaceSync(started, invite, workspace)
      if (currentRun === run) phase.value = "synced"
    } catch (syncError) {
      console.error("Match device sync failed", syncError)
      if (currentRun === run) {
        phase.value = "error"
        error.value = userMessage(syncError, "Generate a new QR and try again.")
      }
    }
  }

  function joinFromLocation(rawUrl: string) {
    const url = new URL(rawUrl)
    if (url.pathname.replace(/\/$/, "") !== "/pair" || !url.hash) return
    window.history.replaceState({}, "", "/")
    void join(rawUrl)
  }

  async function copyInvite() {
    if (inviteUrl.value) await navigator.clipboard.writeText(inviteUrl.value)
  }

  return { isOpen, phase, qrCode, inviteUrl, error, title, host, joinFromLocation, copyInvite, close }
}
