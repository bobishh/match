import * as Automerge from "@automerge/automerge/slim"
import { publicKeyId, verifyEnvelope } from "./domain/identity"
import type { WorkspaceDocumentV2 } from "./domain/model"
import type { WorkspaceChangeAuthorization } from "./sync/workspaceChangeProofStore"

export async function validateRekeyAuthorizations(
  document: Automerge.Doc<WorkspaceDocumentV2>,
  authorizations: WorkspaceChangeAuthorization[],
) {
  if (!Array.isArray(authorizations) || !authorizations.length)
    throw new Error("Workspace rekey requires authorization evidence")
  const pending = new Set(Automerge.getAllChanges(document).map(change => Automerge.decodeChange(change).hash))
  for (const authorization of authorizations) {
    const payload = authorization.signed?.payload
    if (!matchesScope(payload, document))
      throw new Error("Workspace rekey authorization does not match new workspace owner and ID")
    if (!await matchesOwnerKeys(authorization, document.ownerPersonId))
      throw new Error("Workspace rekey authorization does not match new workspace owner and ID")
    const covered = await verifiedHashes(authorization, payload?.hashes ?? [])
    for (const hash of covered) {
      if (!pending.delete(hash)) throw new Error("Workspace rekey authorization has unexpected document changes")
    }
  }
  if (pending.size) throw new Error("Workspace rekey authorization is missing document changes")
}

function matchesScope(payload: WorkspaceChangeAuthorization["signed"]["payload"] | undefined, document: Automerge.Doc<WorkspaceDocumentV2>) {
  return payload?.kind === "workspace-changes" && payload.version === 1 &&
    payload.workspaceId === document.id && payload.personId === document.ownerPersonId
}

async function matchesOwnerKeys(authorization: WorkspaceChangeAuthorization, ownerPersonId: string) {
  return await publicKeyId(authorization.publicKey) === ownerPersonId &&
    authorization.ownerPublicKey === authorization.publicKey &&
    await publicKeyId(authorization.ownerPublicKey) === ownerPersonId
}

async function verifiedHashes(authorization: WorkspaceChangeAuthorization, hashes: string[]) {
  if (!Array.isArray(hashes) || !hashes.length) throw new Error("Workspace rekey authorization evidence is invalid")
  const payload = authorization.signed.payload
  const certificate = authorization.certificates.find(candidate =>
    candidate.payload.personId === payload.personId && candidate.payload.deviceId === payload.deviceId)
  const ownerCertificate = authorization.ownerCertificates.find(candidate => candidate.payload.personId === payload.personId)
  if (!certificate || !ownerCertificate ||
    !await verifyEnvelope(ownerCertificate, authorization.ownerPublicKey) ||
    !await verifyEnvelope(certificate, authorization.publicKey) ||
    !await verifyEnvelope(authorization.signed, certificate.payload.devicePublicKey))
    throw new Error("Workspace rekey authorization evidence is invalid")
  return hashes
}
