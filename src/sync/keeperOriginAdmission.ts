import type { KeeperPairing } from "./keeperPairing"
import type { KeeperDiscovery } from "./keeperDiscovery"

function exactStrings(value: unknown, expected: string[]) {
  if (!Array.isArray(value) || value.length !== expected.length || value.some(item => typeof item !== "string")) return false
  return (value as string[]).slice().sort().every((item, index) => item === expected[index])
}

export function ownerOriginForDiscovery(discovery: KeeperDiscovery): string | undefined {
  if (discovery.capabilities.ownerOriginAdmission !== true) return undefined
  if (typeof window === "undefined" || !window.location.origin) {
    throw new Error("Owner-origin approval requires a browser origin.")
  }
  return window.location.origin
}

export function assertOwnerOriginAdmission(payload: Record<string, unknown>, pairing: KeeperPairing,
  personId: string, deviceId: string) {
  if (!pairing.controllerOrigin) return
  const scopes = pairing.workspaces.map(workspace => workspace.id).sort()
  const baseline = pairing.futureBoardBaselineIds ?? []
  const valid = [
    payload.admissionSource === "owner_origin",
    payload.controllerOrigin === pairing.controllerOrigin,
    payload.controllerPersonId === personId,
    payload.controllerDeviceId === deviceId,
    payload.operatorApproved === true,
    payload.controllerApproved === true,
    exactStrings(payload.approvedWorkspaceIds, scopes),
    payload.futureBoards === (pairing.futureBoards === true),
    exactStrings(payload.baselineWorkspaceIds, baseline),
  ].every(Boolean)
  if (!valid) throw new Error("Rusty did not confirm owner-origin approval for this controller and request.")
}
