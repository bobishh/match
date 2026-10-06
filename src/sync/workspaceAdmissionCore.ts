import * as Automerge from "@automerge/automerge/slim"
import { canonicalizeJson } from "../domain/identity"
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
  authorizationEvidence: WorkspaceChangeAuthorization[]
  quarantinedHashes: string[]
  pendingHashes: string[]
  decisions: Array<{ hash: string; status: CausalAdmissionStatus }>
  authorizedDocument: Uint8Array
  authorizedHeads: string[]
}

type CausalAdmissionStatus =
  | { type: "admitted"; role: "owner" | "editor" | "visitor" }
  | { type: "quarantined" | "pending"; reason: string }

type AdmissionPolicy = Pick<RustStateCore, "authorizationRecordPages" | "prepareWriteEvidence" | "evaluateCausalAdmission">
type AdmissionPlan = {
  decisions: Array<{ hash: string; status: CausalAdmissionStatus }>
  verifiedAuthorizations: WorkspaceChangeAuthorization[]
  authorizedDocument: number[] | Uint8Array
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
  // The full raw union is the evaluator's evidence source. It includes hashes
  // already known locally so late authority evidence can reclassify them.
  const merged = local ? Automerge.merge(local, remote) : remote
  const rawBytes = Automerge.save(merged)
  const plan = policy.evaluateCausalAdmission({
    records: incomingRecords,
    snapshot: {
      workspaceId: remote.id, genesisOwner: authority.genesisOwner, genesisEpoch: authority.genesisEpoch,
      expectedCurrentOwner: authority.currentOwner, document: Array.from(rawBytes),
      ownershipTransfers: authority.ownershipTransfers, successionClaims: authority.successionClaims,
      revocations: authority.revocations, deviceRevocations: authority.deviceRevocations,
      departures: authority.departures,
    },
    nowMs: input.now,
  }) as AdmissionPlan
  const changesByHash = new Map(Automerge.getChangesMetaSince(merged, []).map(change => [change.hash, change]))
  for (const decision of plan.decisions) {
    if (decision.status.type !== "admitted" || decision.status.role !== "editor") continue
    const change = changesByHash.get(decision.hash)
    if (change) assertWorkspaceTransition("editor", Automerge.view(merged, change.deps), Automerge.view(merged, [change.hash]))
  }
  const quarantinedHashes = plan.decisions.filter(decision => decision.status.type === "quarantined").map(decision => decision.hash)
  const pendingHashes = plan.decisions.filter(decision => decision.status.type === "pending").map(decision => decision.hash)
  const verifiedInputs = incomingRecords as WorkspaceChangeAuthorization[]
  const verifiedAuthorizations = plan.verifiedAuthorizations.map(verified => {
    const original = verifiedInputs.find(record => record.signed.signature === verified.signed.signature &&
      canonicalizeJson(record.signed) === canonicalizeJson(verified.signed) && record.publicKey === verified.publicKey &&
      canonicalizeJson(record.certificates) === canonicalizeJson(verified.certificates) &&
      canonicalizeJson(record.grant ?? null) === canonicalizeJson(verified.grant ?? null))
    // Rust returns verified proof fields but omits Match's owner-chain metadata.
    // Restore only metadata attached to the exact verified input record.
    return original ? { ...verified, ownerPublicKey: original.ownerPublicKey,
      ownerCertificates: original.ownerCertificates } : verified
  })
  const authorizedDocument = new Uint8Array(plan.authorizedDocument)
  const authorized = Automerge.load<WorkspaceDocumentV2>(authorizedDocument)
  let authorizedHeads: string[]
  try { authorizedHeads = Automerge.getHeads(authorized) }
  finally { Automerge.free(authorized) }
  return { neededHashes: [...changesByHash.keys()],
    admittedHashes: plan.decisions.filter(decision => decision.status.type === "admitted").map(decision => decision.hash),
    // Only proofs the Rust verifier matched to a real raw change may enter the
    // durable evidence journal. An unmatched hash is untrusted input, not a
    // pending proof: persisting it could poison a later arriving change.
    verifiedAuthorizations,
    authorizationEvidence: verifiedAuthorizations,
    quarantinedHashes, pendingHashes,
    decisions: plan.decisions, authorizedDocument, authorizedHeads }
}

export type WorkspaceAdmissionRequest = { id: number; input: WorkspaceAdmissionInput }
export type WorkspaceAdmissionResponse =
  | { id: number; result: WorkspaceAdmissionResult }
  | { id: number; error: string; fatal?: boolean }
