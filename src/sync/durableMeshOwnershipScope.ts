import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import * as Automerge from "@automerge/automerge/slim"
import { signEnvelope, type LocalProfile } from "../domain/identity"
import type { DeviceCertificate } from "../domain/model"
import type { WorkspaceSetStore } from "./workspaceSet"
import { publishConfirmedWorkspace, workspaceSet } from "./workspaceSet"
import type { WorkspaceOwnershipTransfer } from "./meshRecords"
import { createWorkspaceOwnershipTransfer } from "./meshRecords"
import type { PeerStore, WorkspaceMeshCredential } from "./peerStore"
import { ownerAuthorities, ownershipTransfers, revokedPersonIds, successionClaims, type MeshExport, type ScopeAuthoritySnapshot } from "./durableMeshBase"
import type { SessionEntry } from "./durableMeshBase"

export type OwnershipMergePlan = {
  accepted: WorkspaceOwnershipTransfer[]
  steps: Array<{ record: WorkspaceOwnershipTransfer; accepted: WorkspaceOwnershipTransfer[]; previousOwnerEpoch: number }>
  persistCatalog: boolean
}

export function planOwnershipMerge(credential: WorkspaceMeshCredential, incoming: WorkspaceOwnershipTransfer[]): OwnershipMergePlan {
  return meshRustRuntime().state.planOwnershipMerge({ workspaceId: credential.workspaceId,
    currentOwner: { personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey, certificates: credential.ownerCertificates },
    ownerHistory: ownerAuthorities(credential).slice(1),
    ownerEpoch: Math.max(1, ...[...ownershipTransfers(credential), ...successionClaims(credential)]
      .filter(record => record.payload.toOwnerPersonId === credential.ownerPersonId).map(record => record.payload.epoch)),
    current: ownershipTransfers(credential), incoming, revokedPeople: [...revokedPersonIds(credential)], nowMs: Date.now(),
  }) as OwnershipMergePlan
}

export async function ownershipTransfersWithPending(store: PeerStore, workspaceId: string, raw: WorkspaceOwnershipTransfer[]) {
  const pending = raw.length ? await store.getPendingOwnershipTransfer(workspaceId) : null
  if (!pending) return raw
  const proposal = pending.transfer as WorkspaceOwnershipTransfer
  return raw.some(record => JSON.stringify(record) === JSON.stringify(proposal)) ? raw : [...raw, proposal]
}

export async function preflightScopeAuthoritySnapshot(store: PeerStore, workspaceId: string, credential: WorkspaceMeshCredential,
  incomingTransfers: WorkspaceOwnershipTransfer[], incoming: ScopeAuthoritySnapshot | undefined) {
  if (!incoming) return { snapshot: undefined, ownershipPlan: undefined }
  const snapshot = meshRustRuntime().state.mergeScopeAuthoritySnapshots(
    (await store.getWorkspaceAuthority(workspaceId))?.scopeAuthoritySnapshot ?? null, incoming) as ScopeAuthoritySnapshot
  const ownershipPlan = planOwnershipMerge(credential, incomingTransfers)
  const scope = meshRustRuntime().state.validateScopeAuthority(snapshot) as {
    scopeId: string; controller: { personId: string; publicKey: string }
  }
  if (scope.scopeId !== workspaceId) throw new Error("Scope authority snapshot belongs to another workspace")
  const transfer = ownershipPlan.steps.at(-1)?.record.payload
  const owner = transfer ? { personId: transfer.toOwnerPersonId, publicKey: transfer.toOwnerPublicKey }
    : { personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey }
  if (scope.controller.personId !== owner.personId || scope.controller.publicKey !== owner.publicKey)
    throw new Error("Scope authority snapshot does not match the planned workspace owner")
  return { snapshot, ownershipPlan }
}

export async function persistScopeAuthoritySnapshot(store: PeerStore, workspaceId: string, snapshot: ScopeAuthoritySnapshot | undefined) {
  if (!snapshot) return
  const validated = meshRustRuntime().state.validateScopeAuthority(snapshot) as {
    scopeId: string; controller: { personId: string; publicKey: string }
  }
  const authority = await store.getWorkspaceAuthority(workspaceId)
  if (!authority) throw new Error("Workspace authority disappeared during scope authority import")
  if (validated.scopeId !== workspaceId || validated.controller.personId !== authority.ownerPersonId ||
    validated.controller.publicKey !== authority.ownerPublicKey)
    throw new Error("Scope authority snapshot does not match current workspace owner")
  await store.putWorkspaceAuthority({ ...authority, scopeAuthoritySnapshot: snapshot })
}

export async function confirmedOwnershipSnapshot(store: WorkspaceSetStore, workspaceId: string, transfer: WorkspaceOwnershipTransfer,
  scopeAuthoritySnapshot: ScopeAuthoritySnapshot | undefined, exportWorkspace: (workspaceId: string) => Promise<MeshExport>) {
  return workspaceSet({ ...store, readMesh: async id => {
    const mesh = await exportWorkspace(id)
    if (id !== workspaceId) return mesh
    return { ...mesh, ownershipTransfers: [...(mesh.ownershipTransfers ?? []), transfer],
      scopeAuthoritySnapshot: scopeAuthoritySnapshot ?? mesh.scopeAuthoritySnapshot }
  } }, [workspaceId]).snapshot()
}

export async function createOwnershipProposal(profile: LocalProfile, workspaceId: string,
  target: { payload: { personId: string }; publicKey: string; certificates: DeviceCertificate[] }, credential: WorkspaceMeshCredential,
  store: PeerStore, workspaceStore: WorkspaceSetStore) {
  const document = Automerge.load(await workspaceStore.read(workspaceId))
  let transfer: WorkspaceOwnershipTransfer
  try {
    transfer = await createWorkspaceOwnershipTransfer(profile, workspaceId, {
      personId: target.payload.personId, publicKey: target.publicKey, certificates: target.certificates,
    }, Automerge.getHeads(document), credential.epoch + 1)
  } finally { Automerge.free(document) }
  const snapshot = (await store.getWorkspaceAuthority(workspaceId))?.scopeAuthoritySnapshot
  if (!snapshot) return { transfer, scopeAuthoritySnapshot: undefined }
  const payload = meshRustRuntime().state.createScopeControlTransferPayload({ snapshot,
    toController: { personId: target.payload.personId, publicKey: target.publicKey, certificates: target.certificates } }) as { kind: string }
  const controlTransfer = await signEnvelope(profile.privateKeys.devicePrivateKey, payload, profile.device.deviceId)
  const scopeAuthoritySnapshot = { ...snapshot, controlTransfers: [...snapshot.controlTransfers, controlTransfer] }
  meshRustRuntime().state.validateScopeAuthority(scopeAuthoritySnapshot)
  return { transfer, scopeAuthoritySnapshot }
}

export async function publishConfirmedToSessions(sessions: SessionEntry[], secret: string, snapshot: Uint8Array, message: string) {
  const receipts = await Promise.allSettled(sessions.map(session => publishConfirmedWorkspace(session.connection, secret, snapshot)))
  await Promise.all(sessions.flatMap((session, index) => receipts[index]?.status === "rejected" ? [session.evict(message)] : []))
  return receipts.some(receipt => receipt.status === "fulfilled")
}

export async function awaitOwnerDelivery(sessions: () => SessionEntry[], secret: string, snapshot: Uint8Array, deadline: number) {
  while (true) {
    if (await publishConfirmedToSessions(sessions(), secret, snapshot, "workspace delivery unconfirmed")) return
    if (Date.now() >= deadline) throw new Error("No owner confirmed the workspace before leaving. Keep an owner device online, then retry.")
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}
