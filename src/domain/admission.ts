import * as Automerge from "@automerge/automerge/slim"
import type {
  TransactionMetadataV1,
} from "./model"
import { verifyEnvelope } from "./identity"
import { ProofStore, validateCertificateChain } from "./proofs"

export type AdmissionResult =
  | { admitted: true; changeHash: string }
  | { admitted: false; status: "pending_proof" | "rejected"; reason?: string }

type PendingChange = {
  changeBytes: Uint8Array
  changeHash: string
  receivedAt: number
}

const MAX_PENDING_QUEUE = 500

export class AdmissionController {
  private proofStore: ProofStore
  private pendingQueues = new Map<string, PendingChange[]>()

  constructor(proofStore: ProofStore) {
    this.proofStore = proofStore
  }

  getPendingQueueSize(workspaceId: string): number {
    return this.pendingQueues.get(workspaceId)?.length ?? 0
  }

  async admitChange(
    workspaceId: string,
    changeBytes: Uint8Array,
    ownerPublicKey: string
  ): Promise<AdmissionResult> {
    let decoded: any
    try {
      decoded = Automerge.decodeChange(changeBytes)
    } catch (err: unknown) {
      return { admitted: false, status: "rejected", reason: `Corrupted change bytes: ${(err as Error)?.message || err}` }
    }

    const changeHash = decoded.hash
    let metadata: TransactionMetadataV1 | null = null
    try {
      if (decoded.message) {
        metadata = JSON.parse(decoded.message) as TransactionMetadataV1
      }
    } catch {
      metadata = null
    }

    if (!metadata || metadata.version !== 1) {
      // Unsigned/legacy or missing metadata
      return { admitted: false, status: "rejected", reason: "Missing TransactionMetadataV1" }
    }

    // 1. Look up ChangeProof
    const proof = await this.proofStore.getChangeProof(changeHash)
    if (!proof) {
      this.enqueuePending(workspaceId, changeBytes, changeHash)
      return { admitted: false, status: "pending_proof", reason: "Missing change proof" }
    }

    // 2. Look up ActorBinding
    const actorBinding = await this.proofStore.getActorBinding(proof.payload.actorBindingHash)
    if (!actorBinding) {
      this.enqueuePending(workspaceId, changeBytes, changeHash)
      return { admitted: false, status: "pending_proof", reason: "Missing actor binding" }
    }

    // Invariants on ActorBinding
    if (
      actorBinding.payload.documentId !== workspaceId ||
      actorBinding.payload.actorId !== decoded.actor ||
      actorBinding.payload.personId !== metadata.personId ||
      actorBinding.payload.deviceId !== metadata.deviceId
    ) {
      return { admitted: false, status: "rejected", reason: "Actor binding mismatched with change metadata" }
    }

    // 3. Find DeviceCertificate
    const certs = await this.proofStore.listCertificates()
    const matchingCert = certs.find((c) => c.payload.deviceId === metadata!.deviceId)
    if (!matchingCert) {
      this.enqueuePending(workspaceId, changeBytes, changeHash)
      return { admitted: false, status: "pending_proof", reason: "Missing device certificate" }
    }

    // 4. Validate Certificate Chain
    const chainValid = await validateCertificateChain(matchingCert, ownerPublicKey, certs)
    if (!chainValid.ok) {
      return { admitted: false, status: "rejected", reason: chainValid.error }
    }

    // 5. Verify ActorBinding signature under Device Public Key
    const bindingSigValid = await verifyEnvelope(actorBinding, matchingCert.payload.devicePublicKey)
    if (!bindingSigValid) {
      return { admitted: false, status: "rejected", reason: "Actor binding signature invalid" }
    }

    // 6. Verify ChangeProof signature under Device Public Key
    const proofSigValid = await verifyEnvelope(proof, matchingCert.payload.devicePublicKey)
    if (!proofSigValid) {
      return { admitted: false, status: "rejected", reason: "Change proof signature invalid" }
    }

    // Change successfully verified
    return { admitted: true, changeHash }
  }

  async drainPendingQueue(workspaceId: string, ownerPublicKey: string): Promise<number> {
    const queue = this.pendingQueues.get(workspaceId)
    if (!queue || queue.length === 0) return 0

    const stillPending: PendingChange[] = []
    let admittedCount = 0

    for (const item of queue) {
      const result = await this.admitChange(workspaceId, item.changeBytes, ownerPublicKey)
      if (result.admitted) {
        admittedCount++
      } else if (result.status === "pending_proof") {
        stillPending.push(item)
      }
      // If "rejected", it is dropped from the queue
    }

    this.pendingQueues.set(workspaceId, stillPending)
    return admittedCount
  }

  private enqueuePending(workspaceId: string, changeBytes: Uint8Array, changeHash: string) {
    let queue = this.pendingQueues.get(workspaceId)
    if (!queue) {
      queue = []
      this.pendingQueues.set(workspaceId, queue)
    }

    // Avoid duplicate queue entries
    if (queue.some((item) => item.changeHash === changeHash)) {
      return
    }

    if (queue.length >= MAX_PENDING_QUEUE) {
      // Evict oldest item
      queue.shift()
    }

    queue.push({
      changeBytes,
      changeHash,
      receivedAt: Date.now(),
    })
  }
}
