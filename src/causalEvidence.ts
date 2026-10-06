import { canonicalizeJson } from "./domain/identity"
import type { StoredCausalEvidence } from "./storageJournal"

/** Copy persisted evidence bytes while keeping immutable classification records. */
export function cloneCausalEvidence(evidence: StoredCausalEvidence | null | undefined): StoredCausalEvidence | null {
  return evidence ? {
    bytes: new Uint8Array(evidence.bytes),
    decisions: evidence.decisions,
    authorizationEvidence: evidence.authorizationEvidence,
  } : null
}

/** Keep the prior evidence when a snapshot commit does not reclassify history. */
export function snapshotCausalEvidence(
  incoming: StoredCausalEvidence | undefined,
  previous: StoredCausalEvidence | undefined,
): StoredCausalEvidence | undefined {
  return incoming ? cloneCausalEvidence(incoming) ?? undefined : previous
}

/** Compare all durable evidence fields to decide whether the snapshot changed. */
export function causalEvidenceChanged(
  previous: StoredCausalEvidence | undefined,
  current: StoredCausalEvidence | undefined,
): boolean {
  if (!current) return false
  if (!previous) return true
  return !sameBytes(previous.bytes, current.bytes) ||
    canonicalizeJson(previous.decisions) !== canonicalizeJson(current.decisions) ||
    canonicalizeJson(previous.authorizationEvidence ?? []) !== canonicalizeJson(current.authorizationEvidence ?? [])
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
