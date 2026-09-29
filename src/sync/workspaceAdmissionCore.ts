import * as Automerge from "@automerge/automerge/slim"
import type { RustStateCore } from "@meta-uber/mesh-replication/runtime"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { assertWorkspaceTransition } from "../domain/permissions"
import type { WorkspaceAuthority, WorkspaceOwnershipTransfer, WorkspaceSuccessionClaim } from "./meshRecords"
import type { WorkspaceChangeAuthorization } from "./workspaceChangeProofStore"

export type WorkspaceWriteAuthorityEvidence = {
  genesisOwner: WorkspaceAuthority
  genesisEpoch: number
  currentOwner: WorkspaceAuthority
  currentEpoch: number
  ownershipTransfers: WorkspaceOwnershipTransfer[]
  successionClaims: WorkspaceSuccessionClaim[]
  revocations: unknown[]
  deviceRevocations: Array<{ record: unknown; signer: WorkspaceAuthority }>
  departures: Array<{ record: unknown; authority: WorkspaceAuthority }>
}

export type IncomingAuthorizationBundle =
  | { version: 1; records: unknown[]; authority: WorkspaceWriteAuthorityEvidence }
  | { version: 2; pages: unknown[][]; authority: WorkspaceWriteAuthorityEvidence }

export type WorkspaceAdmissionInput = {
  workspaceId: string
  local?: Uint8Array
  remote: Uint8Array
  authorization: IncomingAuthorizationBundle
  knownAuthority: WorkspaceWriteAuthorityEvidence | null
  now: number
}

export type WorkspaceAdmissionResult = {
  neededHashes: string[]
  admittedHashes: string[]
  verifiedAuthorizations: WorkspaceChangeAuthorization[]
  unsignedHashes: string[]
  unsignedError: string
}

type AdmissionPolicy = Pick<RustStateCore, "authorizationRecordPages" | "prepareWriteEvidence" | "planChangeAdmissionFlow">
type AdmissionPlan = {
  neededHashes: string[]
  verifiedAuthorizations: WorkspaceChangeAuthorization[]
  admittedChanges: Array<{ hash: string }>
  editorChanges: Array<{ hash: string; dependencies: string[] }>
  unsignedChanges: Array<{ hash: string }>
  unsignedError?: string | null
}

/** Pure admission. No storage, notifications, transport acknowledgement or profile access. */
export function computeWorkspaceAdmission(input: WorkspaceAdmissionInput, policy: AdmissionPolicy): WorkspaceAdmissionResult {
  const remote = Automerge.load<WorkspaceDocumentV2>(input.remote)
  let local: Automerge.Doc<WorkspaceDocumentV2> | undefined
  try {
    local = input.local ? Automerge.load<WorkspaceDocumentV2>(input.local) : undefined
    if (remote.id !== input.workspaceId || (local && local.id !== input.workspaceId)) throw new Error("Admission workspace mismatch")
    return admitDocuments(input, policy, local, remote)
  } finally {
    if (local) Automerge.free(local)
    Automerge.free(remote)
  }
}

function admitDocuments(input: WorkspaceAdmissionInput, policy: AdmissionPolicy,
  local: Automerge.Doc<WorkspaceDocumentV2> | undefined, remote: Automerge.Doc<WorkspaceDocumentV2>): WorkspaceAdmissionResult {
  const bundle = input.authorization
  const recordPages = policy.authorizationRecordPages(bundle)
  const incomingRecords = recordPages.flat()
  const authority = policy.prepareWriteEvidence({ incoming: bundle.authority, known: input.knownAuthority,
    records: incomingRecords, genesisPersonId: local?.ownerPersonId ?? remote.ownerPersonId,
    remoteOwnerPersonId: remote.ownerPersonId }) as WorkspaceWriteAuthorityEvidence
  const knownHashes = local ? Automerge.getChangesMetaSince(local, []).map(change => change.hash) : []
  const changes = Automerge.getChangesMetaSince(remote, [])
  // Both loaded handles belong exclusively to this job. The merged handle
  // shares local's backend, freed once in the caller's finally block.
  const merged = local ? Automerge.merge(local, remote) : remote
  const plan = policy.planChangeAdmissionFlow({
    records: bundle.version === 1 ? incomingRecords : [],
    ...(bundle.version === 2 ? { recordPages } : {}), knownHashes,
    changes: changes.map(change => ({ hash: change.hash, dependencies: change.deps,
      actor: change.actor, message: change.message ?? "" })),
    snapshot: {
      workspaceId: remote.id, genesisOwner: authority.genesisOwner, genesisEpoch: authority.genesisEpoch,
      expectedCurrentOwner: authority.currentOwner, document: Array.from(Automerge.save(merged)),
      ownershipTransfers: authority.ownershipTransfers, successionClaims: authority.successionClaims,
      revocations: authority.revocations, deviceRevocations: authority.deviceRevocations,
      departures: authority.departures,
    },
  }, input.now) as AdmissionPlan
  for (const change of plan.editorChanges) {
    assertWorkspaceTransition("editor", Automerge.view(remote, change.dependencies), Automerge.view(remote, [change.hash]))
  }
  const unsignedHashes = plan.unsignedChanges.map(change => change.hash)
  return { neededHashes: plan.neededHashes, admittedHashes: plan.admittedChanges.map(change => change.hash),
    verifiedAuthorizations: plan.verifiedAuthorizations, unsignedHashes,
    unsignedError: plan.unsignedError ?? "Unsigned workspace change rejected" }
}

export type WorkspaceAdmissionRequest = { id: number; input: WorkspaceAdmissionInput }
export type WorkspaceAdmissionResponse =
  | { id: number; result: WorkspaceAdmissionResult }
  | { id: number; error: string; fatal?: boolean }
