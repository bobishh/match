import type { LocalProfile } from "../domain/identity"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { WorkspaceRole } from "../domain/permissions"
import type { WorkspaceAuthorityRecord, WorkspaceMeshCredential } from "./peerStore"
import { meshTrace } from "./meshTrace"

type Authority = WorkspaceAuthorityRecord | WorkspaceMeshCredential

function errorClass(error: unknown): string {
  if (!(error instanceof Error)) return "non-error"
  const known: Array<[string, string]> = [
    ["Workspace authority changed during access validation. Retry.", "authority-changed-during-validation"],
    ["Invalid workspace access decision input", "invalid-access-input"],
    ["Invalid workspace write authority context", "invalid-authority-context"],
    ["Workspace ownership chain does not match the expected owner", "owner-chain-mismatch"],
    ["Workspace revocation has an unknown owner", "unknown-revocation-owner"],
    ["Invalid workspace revocation signature", "invalid-person-revocation-signature"],
    ["Workspace ownership boundary is missing from the document", "authority-boundary-head-missing"],
    ["Invalid workspace revocation", "invalid-person-revocation"],
    ["Invalid workspace device revocation", "invalid-device-revocation"],
    ["Invalid workspace departure", "invalid-departure"],
    ["Invalid workspace authority", "invalid-authority"],
    ["Invalid workspace grant", "invalid-grant"],
  ]
  return known.find(([message]) => error.message.includes(message))?.[1] ?? "other"
}

/** Opt-in diagnostics: bounded identifiers and counts only. */
export function traceWorkspaceAccessSnapshot(doc: WorkspaceDocumentV2, profile: LocalProfile, authority: Authority | null,
  role: WorkspaceRole | "unavailable", validation: "valid" | "invalid" | "missing" | "error", error?: unknown) {
  const catalog = authority?.catalog as {
    deviceRevocations?: Array<{ record?: { payload?: { personId?: string; deviceId?: string } } }>
    revocations?: Array<{ payload?: { personId?: string; epoch?: number } }>
  } | undefined
  const deviceRevocations = catalog?.deviceRevocations ?? []
  const personRevocations = catalog?.revocations ?? []
  const profilePersonId = profile.identity.personId
  const currentDeviceId = profile.device.deviceId
  const matchingDeviceRevocations = deviceRevocations.filter(item =>
    item.record?.payload?.personId === profilePersonId && item.record?.payload?.deviceId === currentDeviceId)
  const matchingPersonRevocations = personRevocations.filter(item => item.payload?.personId === profilePersonId)
  void meshTrace("workspace.access.resolution", {
    workspaceId: doc.id.slice(0, 8),
    profilePersonPrefix: profilePersonId.slice(0, 8),
    documentOwnerPrefix: doc.ownerPersonId.slice(0, 8),
    authorityOwnerPrefix: authority?.ownerPersonId.slice(0, 8) ?? "",
    currentDevicePrefix: currentDeviceId.slice(0, 8),
    role,
    authorityValidation: validation,
    accessErrorClass: errorClass(error),
    profileIsAuthorityOwner: profilePersonId === authority?.ownerPersonId,
    profileIsDocumentOwner: profilePersonId === doc.ownerPersonId,
    deviceRevocationCount: deviceRevocations.length,
    localDeviceRevoked: matchingDeviceRevocations.length > 0,
    localPersonRevocationCount: matchingPersonRevocations.length,
    localPersonRevocationEpoch: Math.max(0, ...matchingPersonRevocations.map(item => item.payload?.epoch ?? 0)),
  })
}
