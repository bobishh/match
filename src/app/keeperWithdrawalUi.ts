import type { KeeperPairing, KeeperPairingStatus, KeeperPairingStatusInfo } from "../sync/lighthousePairing"
import type { PendingKeeperWithdrawal } from "../sync/ownerKeeper"

export function restoreKeeperPairing(entry: PendingKeeperWithdrawal): KeeperPairing | null {
  const value = entry.pairing as Partial<KeeperPairing>
  const service = value.discovery as KeeperPairing["discovery"] | undefined
  const validIdentity = Boolean(entry.pairingId && entry.operationId && value.pairingId === entry.pairingId)
  const validChallenge = Boolean(value.integrationId && value.transcriptHash && value.challengeNonce)
  const validService = Boolean(service?.origin && service.personId && service.deviceId && service.publicKey)
  const validScopes = Array.isArray(value.workspaces) && value.workspaces.every(workspace => Boolean(workspace?.id))
  return validIdentity && validChallenge && validService && validScopes ? value as KeeperPairing : null
}

type DiscoveryPairingStatus = Exclude<KeeperPairingStatus, "pending"> | "pairing"

export function pairingStatusTransition(info: KeeperPairingStatusInfo, cancellationPending = false): { status: DiscoveryPairingStatus; provision: boolean; clearError: boolean } {
  if (info.withdrawal) return { status: info.withdrawal.status, provision: false, clearError: info.withdrawal.status === "cancelled" }
  if (cancellationPending) return { status: "cancel_pending", provision: false, clearError: false }
  if (info.status === "approved" || info.status === "provisioning") return { status: info.status, provision: true, clearError: true }
  return { status: info.status === "pending" ? "pairing" : info.status, provision: false, clearError: true }
}
