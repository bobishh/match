import { adaptVerifiedWorkspaceAdvertisement} from "@meta-uber/mesh-replication/protocol"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { mergeOwnershipTransfers, type OwnershipTransferHost } from "@meta-uber/mesh-runtime"
import type { DeviceCertificate } from "../domain/model"
import {
  verifyWorkspaceMemberBundle,
  type WorkspaceMemberBundle, type WorkspaceOwnershipTransfer,
  type WorkspaceSuccessionPolicy, type WorkspaceSuccessionVote, type WorkspaceSuccessionClaim,
  type WorkspaceBreakGlassClaim } from "./meshRecords"
import { type WorkspaceMeshCredential, type WorkspacePeerRecord } from "./peerStore"
import { mergeBreakGlassClaims, type BreakGlassHost } from "./durableBreakGlass"
import { mergeSuccessionState, type SuccessionHost } from "./durableSuccession"
import { meshCatalog, revocations, ownershipTransfers, successionPolicy, successionVotes, successionClaims, breakGlassClaims, hasConflictingBreakGlassClaims, ownerAuthorities, revokedPersonIds, type MeshExport } from "./durableMeshBase"
import { DurableMeshCredentials } from "./durableMeshCredentials"

export abstract class DurableMeshMembership extends DurableMeshCredentials {
  protected abstract mergeRevocations(credential: WorkspaceMeshCredential, raw: unknown[], disconnect?: boolean): Promise<void>
  async mergeWorkspace(workspaceId: string, raw: unknown): Promise<void> {
    const value = meshRustRuntime().state.validateMeshCatalog(raw) as MeshExport
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
    return mergeOwnershipTransfers<WorkspaceMeshCredential>(this.ownershipTransferHost(), initialCredential, raw)
  }

  protected ownershipTransferHost(): OwnershipTransferHost<WorkspaceMeshCredential> {
    return {
      getProfile: this.options.getProfile, transfers: ownershipTransfers, catalog: credential => meshCatalog(credential),
      authorities: ownerAuthorities, revokedPeople: revokedPersonIds,
      putCredential: credential => this.store.putWorkspaceCredential(credential),
      transferCredential: (previousOwner, credential) => this.store.transferWorkspaceCredential(previousOwner, credential),
      updateTransferredPeers: (credential, payload) => this.updateTransferredPeers(credential, payload),
    }
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
