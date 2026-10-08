import type { DeviceCertificate } from "../domain/model"
import { defaultProofStore, validateCertificateChain, verifyWorkspaceGrant } from "../domain/proofs"
import type { LocalProfile } from "../domain/identity"
import type { WorkspaceMeshCredential } from "./peerStore"
import { uniqueCertificates } from "./durableMeshBase"

/** Return only current owner's verified editor grant generations for CAS revocation. */
export async function verifiedKeeperGrantEpochs(profile: LocalProfile, credential: WorkspaceMeshCredential,
  workspaceId: string, personId: string): Promise<number[]> {
  const [grants, storedCertificates] = await Promise.all([
    defaultProofStore.listGrants(workspaceId), defaultProofStore.listCertificates(),
  ])
  const certificates = uniqueCertificates(profile, [...(credential.ownerCertificates as DeviceCertificate[] ?? []), ...storedCertificates])
  const epochs: number[] = []
  for (const grant of grants) {
    const payload = grant.payload
    if (payload.workspaceId !== workspaceId || payload.personId !== personId || payload.role !== "editor") continue
    const issuer = certificates.find(cert => cert.payload.deviceId === grant.signerKeyId)
    if (!issuer || !(await validateCertificateChain(issuer, credential.ownerPublicKey, certificates)).ok
      || !(await verifyWorkspaceGrant(grant, issuer.payload.devicePublicKey))) continue
    const epoch = payload.accessEpoch ?? 1
    if (Number.isSafeInteger(epoch) && epoch >= 1) epochs.push(epoch)
  }
  return epochs
}
