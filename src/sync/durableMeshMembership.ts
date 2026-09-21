import { adaptVerifiedWorkspaceAdvertisement} from "@meta-uber/mesh-replication/protocol"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import type { DeviceCertificate } from "../domain/model"
import {
  verifyWorkspaceMemberBundle, verifyWorkspaceOwnershipTransfer,
  type WorkspaceAuthority, type WorkspaceMemberBundle, type WorkspaceOwnershipTransfer,
  type WorkspaceSuccessionPolicy, type WorkspaceSuccessionVote, type WorkspaceSuccessionClaim,
  type WorkspaceBreakGlassClaim } from "./meshRecords"
import { hasConflictingOwnershipTransfers } from "./ownershipConflicts"
import { type WorkspaceMeshCredential, type WorkspacePeerRecord } from "./peerStore"
import { mergeBreakGlassClaims, type BreakGlassHost } from "./durableBreakGlass"
import { mergeSuccessionState, type SuccessionHost } from "./durableSuccession"
import { meshCatalog, revocations, ownershipTransfers, successionPolicy, successionVotes, successionClaims, breakGlassClaims, hasConflictingBreakGlassClaims, ownerAuthorities, revokedPersonIds } from "./durableMeshBase"
import { DurableMeshCredentials } from "./durableMeshCredentials"

export abstract class DurableMeshMembership extends DurableMeshCredentials {
  protected abstract mergeRevocations(credential: WorkspaceMeshCredential, raw: unknown[], disconnect?: boolean): Promise<void>
  async mergeWorkspace(workspaceId: string, raw: unknown): Promise<void> {
    const value = meshRustRuntime().state.validateMeshCatalog(raw) as import("./durableMeshBase").MeshExport
    let credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential) return
    credential = await this.mergeOwnershipTransfers(credential, value.ownershipTransfers ?? [])
    credential = await this.mergeBreakGlassClaims(credential, value.breakGlassClaims ?? [])
    try {
      await this.mergeRevocations(credential, value.revocations)
    } catch (error) {
      // A local revocation persists before mergeRevocations rejects the active
      // session. Publish that state first so the UI closes write paths.
      if (error instanceof Error && error.message === "Workspace access revoked") await this.notify()
      throw error
    }
    credential = await this.store.getWorkspaceCredential(workspaceId) ?? credential
    await this.mergeSuccessionState(credential, value.successionPolicy, value.successionVotes ?? [], value.successionClaims ?? [])
    credential = await this.store.getWorkspaceCredential(workspaceId) ?? credential
    await this.mergePeerBundles(credential, value.peers)
    await this.notify()
  }

  protected async mergePeerBundles(credential: WorkspaceMeshCredential, bundles: WorkspaceMemberBundle[]) {
    for (const bundle of bundles) {
      try {
        await this.putVerifiedBundle(credential, bundle)
      } catch {
        // Peer catalogs are gossip. Reject one invalid member without letting it
        // tear down an authenticated session between other valid members.
      }
    }
  }

  protected async putVerifiedBundle(credential: WorkspaceMeshCredential, raw: WorkspaceMemberBundle) {
    const verified = await verifyWorkspaceMemberBundle(raw, {
      workspaceId: credential.workspaceId,
      ownerPersonId: credential.ownerPersonId,
      ownerPublicKey: credential.ownerPublicKey,
      ownerCertificates: credential.ownerCertificates as DeviceCertificate[],
      ownerHistory: ownerAuthorities(credential).slice(1),
    })
    const ownerCertificates = [...new Map([
      ...credential.ownerCertificates as DeviceCertificate[],
      ...(verified.ownerCertificates ?? []),
    ].map(certificate => [certificate.signature, certificate])).values()]
    if (ownerCertificates.length > credential.ownerCertificates.length) {
      await this.store.putWorkspaceCredential({ ...credential, ownerCertificates, updatedAt: new Date().toISOString() })
    }
    const p = verified.advertisement.payload
    const route = await adaptVerifiedWorkspaceAdvertisement(verified.advertisement)
    if (revokedPersonIds(credential).has(p.personId)) throw new Error("Workspace member is revoked")
    const record: WorkspacePeerRecord = {
      workspaceId: route.scopeId,
      personId: route.personId,
      deviceId: route.deviceId,
      instanceId: route.instanceId,
      endpoint: route.endpoint,
      transportSecret: credential.transportSecret,
      role: verified.role,
      lastSeen: route.issuedAt,
      advertisement: raw,
    }
    await this.store.upsertPeer(record)
  }

  protected async mergeOwnershipTransfers(
    initialCredential: WorkspaceMeshCredential,
    raw: WorkspaceOwnershipTransfer[],
  ): Promise<WorkspaceMeshCredential> {
    let credential = initialCredential
    const stored = ownershipTransfers(credential)
    const known = new Map(stored.map(record => [record.signature, record]))
    for (const record of raw) if (record?.signature) known.set(record.signature, record)
    const accepted = new Map(stored.map(record => [record.signature, record]))
    const ordered = () => [...accepted.values()].sort((a, b) =>
      a.payload.epoch - b.payload.epoch || a.signature.localeCompare(b.signature))
    const persistConflict = async () => {
      const next = { ...credential, catalog: { ...meshCatalog(credential), ownershipTransfers: ordered() } }
      await this.store.putWorkspaceCredential(next)
      credential = next
    }

    await this.retainHistoricalTransfers(credential, known, accepted)
    if (hasConflictingOwnershipTransfers(ordered())) {
      await persistConflict()
      return credential
    }

    while (true) {
      const candidates = this.nextOwnershipTransfers(credential, known)
      if (!candidates.length) break
      const verified = await this.verifyOwnershipTransfers(credential, candidates, accepted)
      const plan = meshRustRuntime().state.planOwnershipTransitions([...accepted.values()],
        credential.ownerPersonId, credential.epoch) as { records: WorkspaceOwnershipTransfer[]; conflicted: boolean }
      if (plan.conflicted || !plan.records.length) {
        await persistConflict()
        return credential
      }
      credential = await this.adoptOwnershipTransfer(credential, plan.records[0]!, ordered())
    }
    return credential
  }

  protected async retainHistoricalTransfers(credential: WorkspaceMeshCredential, known: Map<string, WorkspaceOwnershipTransfer>,
    accepted: Map<string, WorkspaceOwnershipTransfer>): Promise<void> {
    for (const value of known.values()) {
      if (accepted.has(value.signature) || (value.payload?.epoch ?? 0) > credential.epoch) continue
      const authority = ownerAuthorities(credential).find(owner => owner.personId === value.payload?.fromOwnerPersonId)
      if (!authority) continue
      const record = await verifyWorkspaceOwnershipTransfer(value, credential.workspaceId, authority, value.payload.epoch - 1)
      accepted.set(record.signature, record)
    }
  }

  protected nextOwnershipTransfers(credential: WorkspaceMeshCredential, known: Map<string, WorkspaceOwnershipTransfer>): WorkspaceOwnershipTransfer[] {
    return [...known.values()].filter(value => value.payload?.epoch === credential.epoch + 1 &&
      value.payload.fromOwnerPersonId === credential.ownerPersonId).sort((a, b) => a.signature.localeCompare(b.signature))
  }

  protected async verifyOwnershipTransfers(credential: WorkspaceMeshCredential, candidates: WorkspaceOwnershipTransfer[],
    accepted: Map<string, WorkspaceOwnershipTransfer>): Promise<WorkspaceOwnershipTransfer[]> {
    const authority: WorkspaceAuthority = { personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey,
      certificates: credential.ownerCertificates as DeviceCertificate[] }
    const verified: WorkspaceOwnershipTransfer[] = []
    for (const value of candidates) {
      const record = await verifyWorkspaceOwnershipTransfer(value, credential.workspaceId, authority, credential.epoch)
      if (revokedPersonIds(credential).has(record.payload.toOwnerPersonId)) throw new Error("New owner access is revoked")
      accepted.set(record.signature, record)
      verified.push(record)
    }
    return verified
  }

  protected async adoptOwnershipTransfer(credential: WorkspaceMeshCredential, record: WorkspaceOwnershipTransfer,
    transfers: WorkspaceOwnershipTransfer[]): Promise<WorkspaceMeshCredential> {
    const p = record.payload
    const authority = { personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey,
      certificates: credential.ownerCertificates as DeviceCertificate[] }
    const history = [...((credential.ownerHistory ?? []) as WorkspaceAuthority[])]
    if (!history.some(owner => owner.personId === authority.personId)) history.push(authority)
    const profile = await this.options.getProfile()
    const localGrant = profile.identity.personId === p.toOwnerPersonId ? p.toOwnerGrant :
      profile.identity.personId === p.fromOwnerPersonId ? p.formerOwnerGrant : credential.localGrant
    const next = { ...credential, ownerPersonId: p.toOwnerPersonId, ownerPublicKey: p.toOwnerPublicKey,
      ownerCertificates: p.toOwnerCertificates, ownerHistory: history, localGrant, epoch: p.epoch, updatedAt: p.transferredAt,
      catalog: { ...meshCatalog(credential), ownershipTransfers: transfers, successionPolicy: undefined, successionVotes: [] } }
    await this.store.transferWorkspaceCredential(credential.ownerPersonId, next)
    await this.updateTransferredPeers(next, p)
    return next
  }

  protected async updateTransferredPeers(credential: WorkspaceMeshCredential, payload: WorkspaceOwnershipTransfer["payload"]): Promise<void> {
    for (const peer of await this.store.listPeers(credential.workspaceId)) {
      if (peer.personId !== payload.fromOwnerPersonId && peer.personId !== payload.toOwnerPersonId) continue
      const grant = peer.personId === payload.fromOwnerPersonId ? payload.formerOwnerGrant : payload.toOwnerGrant
      const advertisement = peer.advertisement as WorkspaceMemberBundle | undefined
      await this.store.upsertPeer({ ...peer, role: peer.personId === payload.toOwnerPersonId ? "owner" : "editor",
        lastSeen: new Date(Math.max(Date.parse(peer.lastSeen), Date.parse(payload.transferredAt)) + 1).toISOString(),
        ...(advertisement ? { advertisement: { ...advertisement, grant, ownerPublicKey: payload.toOwnerPublicKey,
          ownerCertificates: payload.toOwnerCertificates } } : {}) })
    }
  }

  protected async mergeBreakGlassClaims(
    initialCredential: WorkspaceMeshCredential,
    raw: WorkspaceBreakGlassClaim[],
  ): Promise<WorkspaceMeshCredential> {
    return mergeBreakGlassClaims<WorkspaceMeshCredential>(this.breakGlassHost(), initialCredential, raw)
  }

  protected breakGlassHost(): BreakGlassHost<WorkspaceMeshCredential> {
    return {
      getProfile: this.options.getProfile, claims: breakGlassClaims, catalog: credential => meshCatalog(credential),
      authorities: ownerAuthorities, revokedPeople: revokedPersonIds, conflict: hasConflictingBreakGlassClaims,
      putCredential: credential => this.store.putWorkspaceCredential(credential),
      transferCredential: (previousOwner, credential) => this.store.transferWorkspaceCredential(previousOwner, credential),
    }
  }

  protected async mergeSuccessionState(initialCredential: WorkspaceMeshCredential, rawPolicy: WorkspaceSuccessionPolicy | undefined,
    rawVotes: WorkspaceSuccessionVote[], rawClaims: WorkspaceSuccessionClaim[]): Promise<WorkspaceMeshCredential> {
    return mergeSuccessionState<WorkspaceMeshCredential>(this.successionHost(), initialCredential, rawPolicy, rawVotes, rawClaims)
  }

  protected successionHost(): SuccessionHost<WorkspaceMeshCredential> {
    return {
      getProfile: this.options.getProfile, getPolicy: successionPolicy, getVotes: successionVotes, getClaims: successionClaims,
      getCatalog: credential => meshCatalog(credential), getAuthorities: ownerAuthorities, revokedPeople: revokedPersonIds,
      revokedBefore: (credential, epoch) => new Set(revocations(credential)
        .filter(record => record.payload.epoch < epoch).map(record => record.payload.personId)),
      putCredential: credential => this.store.putWorkspaceCredential(credential),
      getCredential: workspaceId => this.store.getWorkspaceCredential(workspaceId),
      transferCredential: (previousOwner, credential) => this.store.transferWorkspaceCredential(previousOwner, credential),
      updateTransferredPeers: async (credential, payload) => {
        for (const peer of await this.store.listPeers(credential.workspaceId)) {
          if (peer.personId !== payload.fromOwnerPersonId && peer.personId !== payload.toOwnerPersonId) continue
          const advertisement = peer.advertisement as WorkspaceMemberBundle | undefined
          await this.store.upsertPeer({ ...peer, role: peer.personId === payload.toOwnerPersonId ? "owner" : "editor",
            lastSeen: new Date(Math.max(Date.parse(peer.lastSeen), Date.parse(payload.claimedAt)) + 1).toISOString(),
            ...(advertisement ? { advertisement: { ...advertisement,
              ...(peer.personId === payload.fromOwnerPersonId ? { grant: payload.formerOwnerGrant } : {}),
              ownerPublicKey: payload.toOwnerPublicKey, ownerCertificates: payload.toOwnerCertificates } } : {}) })
        }
      },
      sessionCount: () => this.sessions.size, publishAll: () => this.publishAll(),
    }
  }
}
