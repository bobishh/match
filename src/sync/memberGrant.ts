import type { LocalProfile } from "../domain/identity"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import { defaultProofStore } from "../domain/proofs"
import type { WorkspaceMemberBundle } from "./meshRecords"
import type { PeerStore, WorkspaceMeshCredential } from "./peerStore"

export function preferNewerMemberGrant(previous: WorkspaceMemberBundle | undefined, incoming: WorkspaceMemberBundle): WorkspaceMemberBundle {
  if (previous?.ownerPublicKey !== incoming.ownerPublicKey || !previous?.grant || !incoming.grant) return incoming
  if (previous.grant.payload.personId !== incoming.grant.payload.personId) return incoming
  return (previous.grant.payload.accessEpoch ?? 1) > (incoming.grant.payload.accessEpoch ?? 1)
    ? { ...incoming, grant: previous.grant, ownerCertificates: previous.ownerCertificates } : incoming
}

export async function persistLocalMemberGrant(store: PeerStore, credential: WorkspaceMeshCredential, profile: LocalProfile,
  grant: WorkspaceGrant | undefined, ownerCertificates: DeviceCertificate[]): Promise<void> {
  if (!grant || grant.payload.personId !== profile.identity.personId) return
  const existing = credential.localGrant as WorkspaceGrant | undefined
  if (existing && (existing.payload.accessEpoch ?? 1) >= (grant.payload.accessEpoch ?? 1)) return
  await defaultProofStore.putGrant(grant.payload.grantId, grant)
  await store.putWorkspaceCredential({ ...credential, ownerCertificates, localGrant: grant, updatedAt: new Date().toISOString() })
}
