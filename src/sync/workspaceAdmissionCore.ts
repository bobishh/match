import * as Automerge from "@automerge/automerge/slim"
import { canonicalizeJson } from "../domain/identity"
import type { RustStateCore } from "@meta-uber/mesh-replication/runtime"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { assertWorkspaceEntityTransitions, assertWorkspaceRootTransition, assertWorkspaceTransition } from "../domain/permissions"
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
export function computeWorkspaceAdmission(input: WorkspaceAdmissionInput, policy: AdmissionPolicy,
  onTiming?: (phase: string, elapsedMs: number) => void): WorkspaceAdmissionResult {
  let phaseStarted = performance.now()
  const remote = Automerge.load<WorkspaceDocumentV2>(input.remote)
  let local: Automerge.Doc<WorkspaceDocumentV2> | undefined
  try {
    local = input.local ? Automerge.load<WorkspaceDocumentV2>(input.local) : undefined
    if (remote.id !== input.workspaceId || (local && local.id !== input.workspaceId)) throw new Error("Admission workspace mismatch")
    onTiming?.("load", performance.now() - phaseStarted)
    phaseStarted = performance.now()
    const result = admitDocuments(input, policy, local, remote, onTiming)
    onTiming?.("total", performance.now() - phaseStarted)
    return result
  } finally {
    if (local) Automerge.free(local)
    Automerge.free(remote)
  }
}

function admitDocuments(input: WorkspaceAdmissionInput, policy: AdmissionPolicy,
  local: Automerge.Doc<WorkspaceDocumentV2> | undefined, remote: Automerge.Doc<WorkspaceDocumentV2>,
  onTiming?: (phase: string, elapsedMs: number) => void): WorkspaceAdmissionResult {
  let phaseStarted = performance.now()
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
  onTiming?.("prepare-plan", performance.now() - phaseStarted)
  phaseStarted = performance.now()
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
  onTiming?.("rust-evaluate", performance.now() - phaseStarted)
  phaseStarted = performance.now()
  const changesByHash = new Map(Automerge.getChangesMetaSince(merged, []).map(change => [change.hash, change]))
  const decodedChanges = Automerge.getAllChanges(merged).map(bytes => Automerge.decodeChange(bytes))
  const operationsByHash = new Map(decodedChanges.map(decoded => [decoded.hash, decoded.ops]))
  const objectParents = indexOperationParents(decodedChanges)
  const actorByHash = new Map<string, string>()
  for (const authorization of plan.verifiedAuthorizations) {
    for (const hash of authorization.signed.payload.hashes) actorByHash.set(hash, authorization.signed.payload.personId)
  }
  for (const decision of plan.decisions) {
    if (decision.status.type !== "admitted") continue
    const change = changesByHash.get(decision.hash)
    if (change) {
      const operations = operationsByHash.get(change.hash)
      assertAdmittedTransition(merged, change, decision.status.role, actorByHash.get(change.hash), operations, objectParents)
    }
  }
  onTiming?.("typescript-transition-validation", performance.now() - phaseStarted)
  phaseStarted = performance.now()
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
  onTiming?.("finalize", performance.now() - phaseStarted)
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

function assertAdmittedTransition(
  document: Automerge.Doc<WorkspaceDocumentV2>,
  change: ReturnType<typeof Automerge.getChangesMetaSince>[number],
  role: "owner" | "editor" | "visitor",
  actorPersonId: string | undefined,
  operations: ReturnType<typeof Automerge.decodeChange>["ops"] | undefined,
  objectParents: ReadonlyMap<string, { parentId: string; key: string }>,
): void {
  const touchedPaths = touchedPathsForChange(operations, objectParents)
  if (touchedPaths) {
    assertWorkspaceRootTransition(role, touchedPaths.rootKeys)
    if (touchedPaths.entityIds.size === 0) return
    const before = Automerge.view(document, change.deps)
    const after = Automerge.view(document, [change.hash])
    assertWorkspaceEntityTransitions(role, before.entities ?? {}, after.entities ?? {}, touchedPaths.entityIds, actorPersonId)
    return
  }
  const patches = Automerge.diffPath(document, [], change.deps, [change.hash])
  if (patches.length === 0) return assertFullTransition(document, change, role, actorPersonId)
  const rootKeys = new Set<string>()
  const entityIds = new Set<string>()
  for (const patch of patches) {
    const [rootKey, entityId] = patch.path
    if (typeof rootKey !== "string") return assertFullTransition(document, change, role, actorPersonId)
    if (rootKey !== "entities") { rootKeys.add(rootKey); continue }
    // Replacing the whole map needs full validation. Keyed patches validate only
    // entities named by the CRDT patch, including nested fields and deletions.
    if (typeof entityId !== "string") return assertFullTransition(document, change, role, actorPersonId)
    entityIds.add(entityId)
  }
  assertWorkspaceRootTransition(role, rootKeys)
  if (entityIds.size === 0) return
  const before = Automerge.view(document, change.deps)
  const after = Automerge.view(document, [change.hash])
  assertWorkspaceEntityTransitions(role, before.entities ?? {}, after.entities ?? {}, entityIds, actorPersonId)
}

export function touchedPathsForChange(
  operations: ReturnType<typeof Automerge.decodeChange>["ops"] | undefined,
  objectParents: ReadonlyMap<string, { parentId: string; key: string }>,
): { rootKeys: Set<string>; entityIds: Set<string> } | undefined {
  if (!operations?.length) return undefined
  const rootKeys = new Set<string>()
  const entityIds = new Set<string>()
  for (const operation of operations) {
    const path = operationObjectPath(operation.obj, objectParents)
    if (!path) return undefined
    if (path.length === 0) {
      if (operation.key === "entities") return undefined
      rootKeys.add(operation.key)
    } else if (path[0] === "entities") {
      entityIds.add(path.length === 1 ? operation.key : path[1]!)
    } else {
      rootKeys.add(path[0]!)
    }
  }
  return { rootKeys, entityIds }
}

export function indexOperationParents(
  decodedChanges: Iterable<ReturnType<typeof Automerge.decodeChange>>,
): Map<string, { parentId: string; key: string }> {
  const objectParents = new Map<string, { parentId: string; key: string }>()
  for (const decoded of decodedChanges) {
    for (const [index, operation] of decoded.ops.entries()) {
      if (!operation.action.startsWith("make")) continue
      const objectId = `${decoded.startOp + index}@${decoded.actor}`
      objectParents.set(objectId, { parentId: operation.obj, key: operation.key })
    }
  }
  return objectParents
}

function operationObjectPath(
  objectId: string,
  objectParents: ReadonlyMap<string, { parentId: string; key: string }>,
): string[] | undefined {
  if (objectId === "_root") return []
  const link = objectParents.get(objectId)
  if (!link) return undefined
  const parentPath = operationObjectPath(link.parentId, objectParents)
  return parentPath ? [...parentPath, link.key] : undefined
}

function assertFullTransition(
  document: Automerge.Doc<WorkspaceDocumentV2>,
  change: ReturnType<typeof Automerge.getChangesMetaSince>[number],
  role: "owner" | "editor" | "visitor",
  actorPersonId: string | undefined,
): void {
  const before = Automerge.view(document, change.deps)
  const after = Automerge.view(document, [change.hash])
  assertWorkspaceTransition(role, before, after, actorPersonId)
}

export type WorkspaceAdmissionRequest = { id: number; input: WorkspaceAdmissionInput; diagnostics?: boolean }
export type WorkspaceAdmissionResponse =
  | { id: number; result: WorkspaceAdmissionResult; diagnostics?: Record<string, number> }
  | { id: number; error: string; fatal?: boolean }
