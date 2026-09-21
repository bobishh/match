import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import * as Automerge from "@automerge/automerge/slim"
import { defaultProofStore } from "../domain/proofs"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { createWorkspaceOwnershipTransfer, createWorkspaceRevocation,
  verifyWorkspaceMemberBundle, verifyWorkspaceRevocation, verifyWorkspaceGrant,
  createWorkspaceSuccessionPolicy, createWorkspaceSuccessionVote, createWorkspaceSuccessionClaim,
  createWorkspaceBreakGlassClaim, type WorkspaceMemberBundle, type WorkspaceOwnershipTransfer, type WorkspaceRevocation,
  type WorkspaceBreakGlassClaim } from "./meshRecords"
import { type WorkspaceMeshCredential} from "./peerStore"
import { workspaceSet, publishConfirmedWorkspace} from "./workspaceSet"
import { uniqueCertificates, meshCatalog, revocations, ownershipTransfers, successionPolicy, successionVotes, ownerAuthorities } from "./durableMeshBase"
import { DurableMeshMembership } from "./durableMeshMembership"

export abstract class DurableMeshAuthority extends DurableMeshMembership {
  async setSuccessor(workspaceId: string, personId: string | null): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential || credential.ownerPersonId !== profile.identity.personId) throw new Error("Only the workspace owner can set succession")
    const eligible = meshRustRuntime().state.eligibleEditorPersonIds(await this.store.listPeers(workspaceId))
    if (personId && !eligible.includes(personId)) throw new Error("Successor must be an editor")
    const policy = await createWorkspaceSuccessionPolicy(profile, workspaceId, personId, eligible, credential.epoch)
    await this.store.putWorkspaceCredential({ ...credential, updatedAt: new Date().toISOString(),
      catalog: { ...meshCatalog(credential), successionPolicy: policy, successionVotes: [] } })
    await this.notify()
    await this.publishAll()
  }

  protected async refreshSuccessionPolicy(workspaceId: string): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    const current = credential && successionPolicy(credential)
    if (!credential || !current || credential.ownerPersonId !== profile.identity.personId) return
    const eligible = meshRustRuntime().state.eligibleEditorPersonIds(await this.store.listPeers(workspaceId))
    const successor = current.payload.successorPersonId && eligible.includes(current.payload.successorPersonId)
      ? current.payload.successorPersonId : null
    if (eligible.join("\0") === current.payload.eligibleEditorPersonIds.join("\0") && successor === current.payload.successorPersonId &&
      current.payload.epoch === credential.epoch) return
    const policy = await createWorkspaceSuccessionPolicy(profile, workspaceId, successor, eligible, credential.epoch)
    await this.store.putWorkspaceCredential({ ...credential, updatedAt: new Date().toISOString(),
      catalog: { ...meshCatalog(credential), successionPolicy: policy, successionVotes: [] } })
  }

  async voteForSuccessor(workspaceId: string, candidatePersonId: string): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    const policy = credential && successionPolicy(credential)
    const grant = credential?.localGrant as WorkspaceGrant | undefined
    if (!credential) throw new Error("Workspace membership is unavailable")
    if (!policy) throw new Error("The owner has not enabled ownership recovery")
    if (!grant || grant.payload.role !== "editor" || !policy.payload.eligibleEditorPersonIds.includes(profile.identity.personId)) {
      throw new Error("You are not an eligible editor in the current recovery policy")
    }
    if (policy.payload.successorPersonId) throw new Error("This workspace uses a named successor, not editor voting")
    const existing = successionVotes(credential).find(vote => vote.signed.payload.voterPersonId === profile.identity.personId)
    if (existing?.signed.payload.candidatePersonId === candidatePersonId) return
    if (existing) throw new Error("Your vote is already recorded for this policy")
    const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
    const vote = await createWorkspaceSuccessionVote(profile, policy, candidatePersonId, grant,
      new Date().toISOString(), certificates)
    await this.mergeSuccessionState(credential, policy, [vote], [])
    await this.notify()
    await this.publishAll()
  }

  async claimSuccession(workspaceId: string): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    const policy = credential && successionPolicy(credential)
    const grant = credential?.localGrant as WorkspaceGrant | undefined
    if (!credential || !policy || !grant || grant.payload.role !== "editor") throw new Error("Only an eligible editor can claim ownership")
    const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
    const doc = Automerge.load<Record<string, unknown>>(await this.options.workspaceStore.read(workspaceId))
    const claim = await createWorkspaceSuccessionClaim(profile, policy, successionVotes(credential), grant,
      Automerge.getHeads(doc), credential.epoch + 1, certificates)
    await this.mergeSuccessionState(credential, policy, successionVotes(credential), [claim])
    await this.notify()
    await this.publishAll()
  }

  protected async verifyRevocation(credential: WorkspaceMeshCredential, value: unknown): Promise<WorkspaceRevocation> {
    for (const authority of ownerAuthorities(credential)) {
      try {
        return await verifyWorkspaceRevocation(value, credential.workspaceId, authority.personId,
          authority.publicKey, authority.certificates)
      } catch { /* Try historical authority keys. */ }
    }
    throw new Error("Invalid workspace revocation signature")
  }

  protected async applyRevocationsToPeers(credential: WorkspaceMeshCredential, records: Map<string, WorkspaceRevocation>,
    disconnect: boolean): Promise<void> {
    for (const peer of await this.store.listPeers(credential.workspaceId)) {
      const record = records.get(peer.personId)
      if (!record) continue
      if (!peer.revokedAt) await this.store.upsertPeer({ ...peer, lastSeen: new Date().toISOString(), revokedAt: record.payload.revokedAt })
      if (disconnect) for (const [, session] of [...this.sessions.entries()].filter(([, session]) =>
        session.workspaceId === credential.workspaceId && session.deviceId === peer.deviceId)) await session.evict("peer revoked")
    }
  }

  protected async mergeRevocations(credential: WorkspaceMeshCredential, raw: unknown[], disconnect = true) {
    const current = [...revocations(credential)]
    for (const value of raw) {
      const record = await this.verifyRevocation(credential, value)
      if (record.payload.personId === credential.ownerPersonId) continue
      current.push(record)
    }
    const merged = meshRustRuntime().state.canonicalRevocations(current) as WorkspaceRevocation[]
    const epoch = Math.max(credential.epoch, ...merged.map(record => record.payload.epoch))
    await this.store.putWorkspaceCredential({ ...credential, epoch, updatedAt: new Date().toISOString(),
      catalog: { ...meshCatalog(credential), revocations: merged } })
    await this.applyRevocationsToPeers(credential, new Map(merged.map(record => [record.payload.personId, record])), disconnect)
    const localPersonId = (credential.localGrant as WorkspaceGrant | undefined)?.payload.personId
    if (localPersonId && merged.some(record => record.payload.personId === localPersonId)) throw new Error("Workspace access revoked")
  }

  async revokePerson(workspaceId: string, personId: string): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential || credential.ownerPersonId !== profile.identity.personId) throw new Error("Only the workspace owner can revoke access")
    const record = await createWorkspaceRevocation(profile, workspaceId, personId, credential.epoch + 1)
    await this.mergeRevocations(credential, [record], false)
    await this.refreshSuccessionPolicy(workspaceId)
    // Gossip tombstone before severing the revoked session. Other members converge on the owner's epoch.
    await this.publishAll()
    await this.mergeRevocations(await this.store.getWorkspaceCredential(workspaceId) ?? credential, [record])
    await this.notify()
  }

  protected ownershipQueue: Promise<void> = Promise.resolve()

  async transferOwnership(workspaceId: string, personId: string): Promise<void> {
    const run = () => this.transferOwnershipConfirmed(workspaceId, personId)
    const result = this.ownershipQueue.then(() => typeof navigator !== "undefined" && navigator.locks
      ? navigator.locks.request(`match-ownership:${workspaceId}`, run) : run())
    this.ownershipQueue = result.catch(() => {})
    return result
  }

  protected async transferOwnershipConfirmed(workspaceId: string, personId: string): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential || credential.ownerPersonId !== profile.identity.personId) {
      throw new Error("Only the workspace owner can transfer ownership")
    }
    if (personId === profile.identity.personId) throw new Error("You already own this workspace")
    const peers = (await this.store.listPeers(workspaceId)).filter(peer => peer.personId === personId && !peer.revokedAt)
    if (!peers.length) throw new Error("Select an active mesh member")
    if (!peers.some(peer => [...this.sessions.values()].some(session =>
      session.workspaceId === workspaceId && session.deviceId === peer.deviceId))) {
      throw new Error("Member must be online to receive ownership")
    }
    const targetSessions = [...this.sessions.values()].filter(session => session.workspaceId === workspaceId &&
      peers.some(peer => peer.deviceId === session.deviceId) && session.ownershipReceiptSupported)
    if (!targetSessions.length) throw new Error("The recipient must reload Match before receiving ownership")
    const raw = peers.find(peer => peer.advertisement)?.advertisement as WorkspaceMemberBundle | undefined
    if (!raw) throw new Error("Member identity is unavailable")
    const target = await verifyWorkspaceMemberBundle(raw, {
      workspaceId, ownerPersonId: credential.ownerPersonId, ownerPublicKey: credential.ownerPublicKey,
      ownerCertificates: credential.ownerCertificates as DeviceCertificate[], ownerHistory: ownerAuthorities(credential).slice(1),
    })
    const pending = ownershipTransfers(credential).find(record => record.payload.epoch === credential.epoch + 1 &&
      record.payload.fromOwnerPersonId === profile.identity.personId)
    if (pending && pending.payload.toOwnerPersonId !== personId) {
      throw new Error("An ownership transfer is pending for another member. Reconnect that member to finish it.")
    }
    const doc = Automerge.load<Record<string, unknown>>(await this.options.workspaceStore.read(workspaceId))
    let transfer: WorkspaceOwnershipTransfer
    try {
      transfer = pending ?? await createWorkspaceOwnershipTransfer(profile, workspaceId, {
        personId: target.payload.personId, publicKey: target.publicKey, certificates: target.certificates,
      }, Automerge.getHeads(doc), credential.epoch + 1)
    } finally { Automerge.free(doc) }

    // Retain the exact signed proposal across unknown outcomes; never sign a
    // competing successor at this epoch. Only report success after durable receipt.
    if (!pending) await this.store.putWorkspaceCredential({ ...credential, updatedAt: new Date().toISOString(),
      catalog: { ...meshCatalog(credential), ownershipTransfers: [...ownershipTransfers(credential), transfer] } })
    const snapshot = await workspaceSet(this.options.workspaceStore, [workspaceId]).snapshot()
    try {
      await Promise.any(targetSessions.map(entry => publishConfirmedWorkspace(entry.connection, credential.transportSecret, snapshot)))
    } catch {
      throw new Error("Ownership delivery is unconfirmed. Keep both devices open and retry the same recipient.")
    }
    const current = await this.store.getWorkspaceCredential(workspaceId)
    if (!current) throw new Error("Workspace mesh credential disappeared")
    await this.mergeOwnershipTransfers(current, [transfer])
    await this.notify()
    await this.publishAll()
  }

  async breakGlassOwnership(workspaceId: string): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential) throw new Error("Workspace membership is unavailable")
    if (credential.ownerPersonId === profile.identity.personId) return
    if (successionPolicy(credential)) throw new Error("Use the configured ownership succession policy")
    if (!profile.privateKeys.identityPrivateKey) throw new Error("This identity cannot own workspaces without its root key")
    const ownerOnline = (await this.store.listPeers(workspaceId)).some(peer =>
      peer.personId === credential.ownerPersonId && !peer.revokedAt && [...this.sessions.values()].some(session =>
        session.workspaceId === workspaceId && session.deviceId === peer.deviceId))
    if (ownerOnline) throw new Error("Workspace owner is online; use signed ownership transfer")
    const grant = credential.localGrant as WorkspaceGrant | undefined
    if (!grant || grant.payload.personId !== profile.identity.personId || grant.payload.role !== "editor") {
      throw new Error("Only an editor can recover orphaned ownership")
    }
    let verified = false
    for (const authority of ownerAuthorities(credential)) {
      try {
        await verifyWorkspaceGrant(grant, {
          workspaceId, personId: profile.identity.personId, ownerPersonId: authority.personId,
          ownerPublicKey: authority.publicKey, ownerCertificates: authority.certificates,
        })
        verified = true
        break
      } catch { /* Recheck after the next catalog update. */ }
    }
    if (!verified) throw new Error("Editor grant cannot be verified")
    const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
    const epoch = credential.epoch + 1
    const claimedAt = new Date().toISOString()
    const doc = Automerge.load<Record<string, unknown>>(await this.options.workspaceStore.read(workspaceId))
    let claim: WorkspaceBreakGlassClaim
    try {
      claim = await createWorkspaceBreakGlassClaim(profile, workspaceId, credential.ownerPersonId, grant,
        Automerge.getHeads(doc), epoch, claimedAt, certificates)
    } finally { Automerge.free(doc) }
    await this.mergeBreakGlassClaims(credential, [claim])
    if (this.node) await this.ensureOwnerWorkspaces([workspaceId], this.node.endpointId, profile)
    await this.notify()
    await this.publishAll()
  }

  async leaveWorkspace(workspaceId: string): Promise<void> {
    if (!workspaceId) throw new Error("No active workspace")
    for (const [, entry] of [...this.sessions]) {
      if (entry.workspaceId !== workspaceId) continue
      await entry.evict("workspace left")
    }
    this.gossip.close(workspaceId)
    this.runtimeState?.clearGossip(workspaceId)
    await this.store.removeWorkspaceMeshData(workspaceId)
    await defaultProofStore.removeWorkspaceGrants(workspaceId)
    this.lastDiagnostic = ""
    this.options.onDiagnostic?.("")
    this.clearRouteReconnects(`${workspaceId}:`)
    await this.notify()
  }

}
