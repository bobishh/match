import type { LocalProfile } from "../domain/identity"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import * as Automerge from "@automerge/automerge/slim"
import { defaultProofStore } from "../domain/proofs"
import { BrowserMeshAuthority, BrowserMeshCatalog, BrowserMeshRecovery, BrowserMeshSuccession, mergeOwnershipTransfers, type OwnershipTransferHost } from "@meta-uber/mesh-runtime"
import { adaptVerifiedWorkspaceAdvertisement } from "@meta-uber/mesh-replication/protocol"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { createWorkspaceOwnershipTransfer, createWorkspaceRevocation,
  verifyWorkspaceMemberBundle, verifyWorkspaceRevocation, verifyWorkspaceGrant,
  createWorkspaceSuccessionPolicy, createWorkspaceSuccessionVote, createWorkspaceSuccessionClaim,
  createWorkspaceBreakGlassClaim, type WorkspaceMemberBundle, type WorkspaceOwnershipTransfer, type WorkspaceRevocation,
  type WorkspaceBreakGlassClaim, type WorkspaceSuccessionPolicy, type WorkspaceSuccessionVote, type WorkspaceSuccessionClaim } from "./meshRecords"
import { type WorkspaceMeshCredential, type WorkspacePeerRecord } from "./peerStore"
import { workspaceSet, publishConfirmedWorkspace} from "./workspaceSet"
import { mergeBreakGlassClaims, type BreakGlassHost } from "./durableBreakGlass"
import { mergeSuccessionState, type SuccessionHost } from "./durableSuccession"
import { uniqueCertificates, meshCatalog, revocations, ownershipTransfers, successionPolicy, successionVotes, successionClaims, breakGlassClaims, hasConflictingBreakGlassClaims, ownerAuthorities, revokedPersonIds, type MeshExport } from "./durableMeshBase"
import { DurableMeshCredentials } from "./durableMeshCredentials"

export abstract class DurableMeshAuthority extends DurableMeshCredentials {
  private readonly catalog = new BrowserMeshCatalog<WorkspaceMeshCredential, MeshExport>({
    parse: raw => meshRustRuntime().state.validateMeshCatalog(raw) as MeshExport,
    credential: async workspaceId => (await this.store.getWorkspaceCredential(workspaceId)) ?? undefined,
    ownership: (credential, value) => this.mergeOwnershipTransfers(credential, value.ownershipTransfers ?? []),
    breakGlass: (credential, value) => this.mergeBreakGlassClaims(credential, value.breakGlassClaims ?? []),
    revocations: async (credential, value) => {
      try { await this.mergeRevocations(credential, value.revocations) }
      catch (error) {
        if (error instanceof Error && error.message === "Workspace access revoked") await this.notify()
        throw error
      }
    },
    succession: (credential, value) => this.mergeSuccessionState(credential, value.successionPolicy, value.successionVotes ?? [], value.successionClaims ?? []),
    peers: (credential, value) => this.mergePeerBundles(credential, value.peers),
    refreshed: async workspaceId => (await this.store.getWorkspaceCredential(workspaceId)) ?? undefined,
    notify: () => this.notify(),
  })

  async mergeWorkspace(workspaceId: string, raw: unknown): Promise<void> { await this.catalog.merge(workspaceId, raw) }

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
  private readonly authority = new BrowserMeshAuthority<WorkspaceMeshCredential, { personId: string; profile: LocalProfile }, WorkspaceRevocation>({
    profile: async () => {
      const profile = await this.options.getProfile()
      return { personId: profile.identity.personId, profile }
    },
    credential: async workspaceId => (await this.store.getWorkspaceCredential(workspaceId)) ?? undefined,
    createRevocation: (owner, workspaceId, personId, epoch) => createWorkspaceRevocation(owner.profile, workspaceId, personId, epoch),
    epoch: credential => credential.epoch,
    mergeRevocations: (credential, records, disconnect) => this.mergeRevocations(credential, records, disconnect),
    refreshSuccessionPolicy: workspaceId => this.refreshSuccessionPolicy(workspaceId),
    publishAll: () => this.publishAll(),
    notify: () => this.notify(),
    leave: workspaceId => this.leaveWorkspaceHost(workspaceId),
  })
  private readonly succession = new BrowserMeshSuccession<WorkspaceMeshCredential, { personId: string; profile: LocalProfile }, WorkspaceSuccessionPolicy>({
    profile: async () => {
      const profile = await this.options.getProfile()
      return { personId: profile.identity.personId, profile }
    },
    credential: async workspaceId => (await this.store.getWorkspaceCredential(workspaceId)) ?? undefined,
    eligibleEditors: async workspaceId => meshRustRuntime().state.eligibleEditorPersonIds(await this.store.listPeers(workspaceId)),
    epoch: credential => credential.epoch,
    createPolicy: (owner, workspaceId, successor, eligible, epoch) =>
      createWorkspaceSuccessionPolicy(owner.profile, workspaceId, successor, eligible, epoch),
    setPolicy: (credential, policy) => this.store.putWorkspaceCredential({ ...credential, updatedAt: new Date().toISOString(),
      catalog: { ...meshCatalog(credential), successionPolicy: policy, successionVotes: [] } }),
    notify: () => this.notify(),
    publishAll: () => this.publishAll(),
  })
  private readonly recovery = new BrowserMeshRecovery<
    WorkspaceMeshCredential,
    { personId: string; profile: LocalProfile },
    WorkspaceSuccessionPolicy,
    WorkspaceGrant,
    WorkspaceSuccessionVote,
    WorkspaceSuccessionClaim,
    DeviceCertificate
  >({
    profile: async () => {
      const profile = await this.options.getProfile()
      return { personId: profile.identity.personId, profile }
    },
    credential: async workspaceId => (await this.store.getWorkspaceCredential(workspaceId)) ?? undefined,
    policy: successionPolicy,
    grant: credential => credential.localGrant as WorkspaceGrant | undefined,
    votes: successionVotes,
    certificates: async owner => uniqueCertificates(owner.profile, await defaultProofStore.listCertificates()),
    createVote: (owner, policy, candidate, grant, certificates) =>
      createWorkspaceSuccessionVote(owner.profile, policy, candidate, grant, new Date().toISOString(), certificates),
    createClaim: async (owner, credential, policy, votes, grant, certificates) => {
      const doc = Automerge.load<Record<string, unknown>>(await this.options.workspaceStore.read(credential.workspaceId))
      try {
        return await createWorkspaceSuccessionClaim(owner.profile, policy, votes, grant,
          Automerge.getHeads(doc), credential.epoch + 1, certificates)
      } finally { Automerge.free(doc) }
    },
    merge: (credential, policy, votes, claims) => this.mergeSuccessionState(credential, policy, votes, claims).then(() => undefined),
    notify: () => this.notify(),
    publishAll: () => this.publishAll(),
  })
  async setSuccessor(workspaceId: string, personId: string | null): Promise<void> {
    await this.succession.setSuccessor(workspaceId, personId)
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
    await this.recovery.vote(workspaceId, candidatePersonId)
  }

  async claimSuccession(workspaceId: string): Promise<void> {
    await this.recovery.claim(workspaceId)
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
    await this.authority.revokePerson(workspaceId, personId)
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
    await this.authority.leaveWorkspace(workspaceId)
  }

  private async leaveWorkspaceHost(workspaceId: string): Promise<void> {
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
  }

}
