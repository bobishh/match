import { type LocalProfile } from "../domain/identity"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import { defaultProofStore } from "../domain/proofs"
import { createPairingSecret} from "@meta-uber/mesh-pairing"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { BrowserMeshCredentials, BrowserMeshInvitations } from "@meta-uber/mesh-runtime"
import { createPeerAdvertisement,
  type WorkspaceMemberBundle, type WorkspaceOwnershipTransfer,
  type WorkspaceSuccessionPolicy, type WorkspaceSuccessionVote, type WorkspaceSuccessionClaim,
  type WorkspaceDeparture, type WorkspaceDeviceRevocation } from "./meshRecords"
import { type WorkspaceMeshCredential} from "./peerStore"
import type { SyncConnection} from "./transport"
import { workspaceSet, publishOwnerWorkspaceOffer} from "./workspaceSet"
import { departures, hasLeftWorkspace, deviceRevocations, isDeviceRevoked, isGrantRevoked, uniqueCertificates, isEnvelope, meshCatalog, revocations, ownershipTransfers, successionPolicy, successionVotes, successionClaims, ownerAuthorities,
  type MeshExport, type MeshWorkspaceEnvelope } from "./durableMeshBase"
import { DurableMeshBase } from "./durableMeshBase"

export abstract class DurableMeshCredentials extends DurableMeshBase {
  protected abstract mergeDepartures(credential: WorkspaceMeshCredential, records: WorkspaceDeparture[], disconnect?: boolean): Promise<void>
  protected abstract mergeDeviceRevocations(credential: WorkspaceMeshCredential, records: WorkspaceDeviceRevocation[]): Promise<void>
  private readonly ownerCredentials = new BrowserMeshCredentials<WorkspaceMeshCredential, { personId: string; publicKey: string; profile: LocalProfile }, DeviceCertificate>({
    credential: async workspaceId => (await this.store.getWorkspaceCredential(workspaceId)) ?? undefined,
    putCredential: credential => this.store.putWorkspaceCredential(credential),
    createCredential: (workspaceId, owner, certificates) => ({ version: 1, workspaceId, ownerPersonId: owner.personId,
      ownerPublicKey: owner.publicKey, ownerCertificates: certificates, transportSecret: createPairingSecret(), epoch: 1, updatedAt: new Date().toISOString() }),
    refreshOwnerCertificates: (credential, owner, certificates) => this.refreshOwnerCertificates(credential, owner.profile, certificates),
  })
  private readonly invitations = new BrowserMeshInvitations<WorkspaceMeshCredential, MeshWorkspaceEnvelope, WorkspaceGrant, WorkspaceMemberBundle, LocalProfile>({
    credential: async workspaceId => (await this.store.getWorkspaceCredential(workspaceId)) ?? undefined,
    peers: async workspaceId => (await this.peerInstances(workspaceId))
      .filter(peer => !peer.revokedAt && peer.advertisement)
      .map(peer => peer.advertisement as WorkspaceMemberBundle),
    createEnvelope: (credential, peers) => ({
      version: 1,
      workspaceId: credential.workspaceId,
      ownerPersonId: credential.ownerPersonId,
      ownerPublicKey: credential.ownerPublicKey,
      ownerCertificates: credential.ownerCertificates,
      transportSecret: credential.transportSecret,
      epoch: credential.epoch,
      peers,
      revocations: revocations(credential), deviceRevocations: deviceRevocations(credential), departures: departures(credential),
      ownerHistory: ownerAuthorities(credential).slice(1),
      ownershipTransfers: ownershipTransfers(credential),
      successionPolicy: successionPolicy(credential),
      successionVotes: successionVotes(credential),
      successionClaims: successionClaims(credential),
    }),
    isEnvelope,
    validate: async (workspaceId, envelope, profile, grant) => {
      await this.verifyInvitationAuthority(workspaceId, envelope, profile, grant)
    },
    install: (workspaceId, envelope, profile, grant) => this.installInvitationWorkspace(workspaceId, envelope, profile, grant),
  })

  protected abstract refreshOwnBundle(credential: WorkspaceMeshCredential, profile: LocalProfile,
    endpoint: string, certificates: DeviceCertificate[]): Promise<WorkspaceMemberBundle | undefined>
  protected abstract mergeRevocations(credential: WorkspaceMeshCredential, raw: unknown[], disconnect?: boolean): Promise<void>
  protected abstract mergePeerBundles(credential: WorkspaceMeshCredential, bundles: WorkspaceMemberBundle[]): Promise<void>
  protected abstract putVerifiedBundle(credential: WorkspaceMeshCredential, raw: WorkspaceMemberBundle): Promise<void>
  protected abstract mergeOwnershipTransfers(credential: WorkspaceMeshCredential, raw: WorkspaceOwnershipTransfer[]): Promise<WorkspaceMeshCredential>
  protected abstract mergeSuccessionState(credential: WorkspaceMeshCredential, policy: WorkspaceSuccessionPolicy | undefined, votes: WorkspaceSuccessionVote[], claims: WorkspaceSuccessionClaim[]): Promise<WorkspaceMeshCredential>
  protected abstract refreshSuccessionPolicy(workspaceId: string): Promise<void>
  protected async refreshOwnerCertificates(credential: WorkspaceMeshCredential, profile: LocalProfile,
    certificates: DeviceCertificate[]): Promise<WorkspaceMeshCredential> {
    const next = meshRustRuntime().state.planOwnerCertificateRefresh(credential,
      profile.identity.personId, certificates, new Date().toISOString()) as WorkspaceMeshCredential | null
    if (!next) return credential
    await this.store.putWorkspaceCredential(next)
    return next
  }


  protected async credentialBelongsToProfile(credential: WorkspaceMeshCredential, profile: LocalProfile): Promise<boolean> {
    if (hasLeftWorkspace(credential, profile.identity.personId, credential.localGrant as WorkspaceGrant | undefined) || isDeviceRevoked(credential, profile.identity.personId, profile.device.deviceId)) return false
    return meshRustRuntime().state.credentialBelongsToProfile(credential,
      profile.identity.personId, profile.identity.publicKey)
  }

  protected async activeCredentialsForProfile(credentials: WorkspaceMeshCredential[], profile: LocalProfile) {
    const plan = meshRustRuntime().state.partitionCredentials({ credentials,
      personId: profile.identity.personId, publicKey: profile.identity.publicKey,
      deviceId: profile.device.deviceId })
    const active = plan.activeIndices.map(index => credentials[index]!)
    const mismatched = plan.mismatchedIndices.map(index => credentials[index]!)
    for (const credential of mismatched) {
      // A transient or concurrent identity bootstrap must not erase durable mesh trust.
      // Enrollment replaces stale credentials explicitly after mutual approval.
      this.trace("credential.identity-mismatch", { workspaceId: credential.workspaceId.slice(0, 8) }, "warn")
    }
    if (mismatched.length && active.length === 0) {
      this.report("Mesh identity", new Error("Stored mesh trust belongs to another local identity. Re-enroll this device."))
    }
    // Keep the record for recovery, but never let it reach the dial scheduler.
    this.activeWorkspaceIds = new Set(active.map(credential => credential.workspaceId))
    return active
  }

  async ensureOwnerWorkspaces(workspaceIds: string[], endpoint: string, profile: LocalProfile): Promise<void> {
    await this.acquireInstance()
    const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
    for (const workspaceId of workspaceIds) {
      const credential = await this.ensureOwnerCredential(
        workspaceId,
        profile,
        certificates,
      )
      await this.refreshOwnBundle(credential, profile, endpoint, certificates)
    }
    await this.notify()
  }

  private async ensureOwnerCredential(workspaceId: string, profile: LocalProfile, certificates: DeviceCertificate[]): Promise<WorkspaceMeshCredential> {
    return this.ownerCredentials.ensureOwnerCredential(workspaceId, {
      personId: profile.identity.personId, publicKey: profile.identity.publicKey, profile,
    }, certificates)
  }

  protected async ownerWorkspaceIds(profile: LocalProfile) {
    return meshRustRuntime().state.ownedWorkspaceIds(await this.store.listWorkspaceCredentials(),
      profile.identity.personId, profile.identity.publicKey)
  }

  async addOwnerWorkspace(workspaceId: string): Promise<void> {
    const profile = await this.options.getProfile()
    const certificates = uniqueCertificates(
      profile,
      await defaultProofStore.listCertificates(),
    )
    const credential = await this.ensureOwnerCredential(
      workspaceId,
      profile,
      certificates,
    )
    if (this.node)
      await this.refreshOwnBundle(
        credential,
        profile,
        this.node.endpointId,
        certificates,
      )
    // A workspace can be created after the initial page-start saw no mesh
    // credentials. Starting here makes the newly persisted owner credential
    // immediately usable for invitations instead of leaving Sync offline.
    await this.start()
    await this.notify()
    void Promise.allSettled([...this.sessions.values()].map(async entry => {
      if (entry.remotePersonId !== profile.identity.personId || !entry.ownerWorkspaceOfferFrame) return
      const credential = await this.store.getWorkspaceCredential(entry.workspaceId)
      if (!credential) return
      await publishOwnerWorkspaceOffer(entry.connection, credential.transportSecret,
        await this.encodeOwnerWorkspaceOffer(workspaceId), entry.ownerWorkspaceOfferFrame)
    }))
  }

  protected async encodeOwnerWorkspaceOffer(workspaceId: string) {
    const [envelope] = await this.invitationPayload([workspaceId])
    const [workspace] = JSON.parse(new TextDecoder().decode(
      await workspaceSet(this.options.workspaceStore, [workspaceId]).snapshot(),
    ))
    return new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId, envelope, workspace }))
  }

  protected async receiveOwnerWorkspaceOffer(bytes: Uint8Array, remotePersonId: string) {
    const profile = await this.options.getProfile()
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { envelope: MeshWorkspaceEnvelope; workspace: unknown }
    const workspaceId = meshRustRuntime().state.validateOwnerWorkspaceOffer(value, remotePersonId, profile.identity.personId)
    // Persist the signed document before activating its credential. Otherwise
    // an interrupted offer leaves durable mesh retrying a workspace which has
    // no local document yet.
    await workspaceSet(this.options.workspaceStore, [workspaceId]).receive(
      new TextEncoder().encode(JSON.stringify([value.workspace])), false)
    await this.receiveInvitation([value.envelope], [workspaceId], profile, [])
    if (!this.node) throw new Error("Workspace mesh is unavailable")
    await this.ensureOwnerWorkspaces([workspaceId], this.node.endpointId, profile)
  }

  protected async offerMissingOwnerWorkspaces(connection: SyncConnection, secret: string,
    remoteWorkspaceIds: unknown, remotePersonId: string, ownerWorkspaceOfferFrame: "mesh-owner-workspace-offer" | undefined) {
    const profile = await this.options.getProfile()
    if (remotePersonId !== profile.identity.personId || !ownerWorkspaceOfferFrame) return
    const missing = meshRustRuntime().state.missingOwnerWorkspaces(await this.ownerWorkspaceIds(profile), remoteWorkspaceIds)
    for (const workspaceId of missing) {
      await publishOwnerWorkspaceOffer(connection, secret, await this.encodeOwnerWorkspaceOffer(workspaceId), ownerWorkspaceOfferFrame)
    }
  }

  async createGuestAdvertisements(workspaceIds: string[], endpoint: string, profile: LocalProfile): Promise<WorkspaceMemberBundle[]> {
    await this.acquireInstance()
    const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
    return Promise.all(workspaceIds.map(workspaceId => createPeerAdvertisement(profile, workspaceId, endpoint,
      { certificates, instanceId: this.instanceId })))
  }

  async forgetEnrolledDevice(workspaceIds: string[], deviceId: string): Promise<void> {
    for (const workspaceId of new Set(workspaceIds)) {
      for (const [key, entry] of [...this.sessions]) {
        if (entry.workspaceId !== workspaceId || entry.deviceId !== deviceId) continue
        this.runtime().clearRouteAttempt(key)
        this.clearRouteReconnect(key)
        await entry.evict("device forgotten")
      }
      await this.store.removePeer(workspaceId, deviceId)
    }
  }

  async knowsWorkspaceIssuer(workspaceIds: string[], personId: string, deviceId: string): Promise<boolean> {
    const profile = await this.options.getProfile()
    const workspaces = await Promise.all(workspaceIds.map(async id => ({
      credential: await this.store.getWorkspaceCredential(id), issuer: await this.store.getPeer(id, deviceId),
    })))
    return meshRustRuntime().state.knowsWorkspaceIssuer(workspaces, personId,
      profile.identity.personId, profile.device.deviceId)
  }

  async acceptGuest(workspaceIds: string[], rawBundles: unknown, grants: WorkspaceGrant[]): Promise<void> {
    const credentials = await Promise.all(workspaceIds.map(id => this.store.getWorkspaceCredential(id)))
    const entries = meshRustRuntime().state.planGuestAdvertisements({ raw: rawBundles, workspaceIds,
      grantWorkspaceIds: grants.map(grant => grant.payload.workspaceId),
      credentialPresent: credentials.map(Boolean) })
    for (const entry of entries) {
      const credential = credentials[workspaceIds.indexOf(entry.workspaceId)]!
      const raw = (rawBundles as WorkspaceMemberBundle[])[entry.bundleIndex]!
      const grant = grants[entry.grantIndex]!
      await this.putVerifiedBundle(credential, { ...raw, grant, ownerPublicKey: credential.ownerPublicKey,
        ownerCertificates: credential.ownerCertificates } as WorkspaceMemberBundle)
      await this.refreshSuccessionPolicy(entry.workspaceId)
    }
    await this.notify()
  }

  async invitationPayload(workspaceIds: string[]): Promise<MeshWorkspaceEnvelope[]> {
    return this.invitations.payload(workspaceIds)
  }

  /** Returns a real signed grant only when this identity still verifies for it. */
  async enrollmentGrant(workspaceId: string, profile: LocalProfile): Promise<WorkspaceGrant | undefined> {
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential || credential.ownerPersonId === profile.identity.personId) return undefined
    if (!await this.credentialBelongsToProfile(credential, profile)) return undefined
    return credential.localGrant as WorkspaceGrant | undefined
  }

  protected async verifyInvitationAuthority(workspaceId: string, envelope: MeshWorkspaceEnvelope, profile: LocalProfile,
    localGrant: WorkspaceGrant | undefined): Promise<DeviceCertificate[]> {
    const existing = await this.store.getWorkspaceCredential(workspaceId)
    const authority = await this.store.getWorkspaceAuthority(workspaceId)
    const credential = meshRustRuntime().state.planInvitationCredential({ workspaceId, envelope,
      previousCredential: existing ?? null, previousAuthority: authority ?? null,
      localPersonId: profile.identity.personId, localGrant: localGrant ?? null,
      updatedAt: new Date().toISOString() }) as WorkspaceMeshCredential
    return credential.ownerCertificates as DeviceCertificate[]
  }

  protected async installInvitationWorkspace(workspaceId: string, envelope: MeshWorkspaceEnvelope, profile: LocalProfile,
    localGrant: WorkspaceGrant | undefined): Promise<void> {
    const previous = await this.store.getWorkspaceCredential(workspaceId)
    const previousAuthority = await this.store.getWorkspaceAuthority(workspaceId)
    const credential = meshRustRuntime().state.planInvitationCredential({ workspaceId, envelope,
      previousCredential: previous ?? null, previousAuthority: previousAuthority ?? null,
      localPersonId: profile.identity.personId, localGrant: localGrant ?? null,
      updatedAt: new Date().toISOString() }) as WorkspaceMeshCredential
    await this.store.putWorkspaceCredential(credential)
    await this.mergeInvitationCatalog(credential, envelope)
  }

  private async mergeInvitationCatalog(credential: WorkspaceMeshCredential, envelope: MeshWorkspaceEnvelope) {
    const workspaceId = credential.workspaceId
    for (const action of meshRustRuntime().state.planAuthorityImport("invitation", Boolean(envelope.revocations), false)) {
      switch (action) {
        case "deviceRevocations": await this.mergeDeviceRevocations(credential, envelope.deviceRevocations ?? []); break
        case "departures": await this.mergeDepartures(credential, envelope.departures ?? []); break
        case "revocations": await this.mergeRevocations(credential, envelope.revocations ?? []); break
        case "succession": await this.mergeSuccessionState(credential, envelope.successionPolicy,
          envelope.successionVotes ?? [], envelope.successionClaims ?? []); break
        case "refreshCredential": credential = await this.store.getWorkspaceCredential(workspaceId) ?? credential; break
        case "peers": await this.mergePeerBundles(credential, envelope.peers); break
      }
    }
  }

  async receiveInvitation(raw: unknown, workspaceIds: string[], profile: LocalProfile, grants: WorkspaceGrant[]): Promise<void> {
    await this.invitations.receive(raw, workspaceIds, profile, grants, grant => grant.payload.workspaceId)
    await this.notify()
  }

  async validateInvitation(raw: unknown, workspaceIds: string[], profile: LocalProfile, grants: WorkspaceGrant[]): Promise<void> {
    await this.invitations.validate(raw, workspaceIds, profile, grants, grant => grant.payload.workspaceId)
  }

  async nextAccessEpoch(workspaceId: string): Promise<number> {
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    const issued = await defaultProofStore.listGrants(workspaceId)
    return meshRustRuntime().state.nextAccessEpoch(credential ?? null, issued)
  }

  async exportWorkspace(workspaceId: string): Promise<MeshExport> {
    const peers = (await this.peerInstances(workspaceId)).filter(peer => !peer.revokedAt && peer.advertisement)
      .map(peer => peer.advertisement as WorkspaceMemberBundle)
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    return { version: 1, peers, deviceRevocations: credential ? deviceRevocations(credential) : [], departures: credential ? departures(credential) : [], revocations: credential ? revocations(credential) : [],
      ownershipTransfers: credential ? ownershipTransfers(credential) : [],
      successionPolicy: credential ? successionPolicy(credential) : undefined,
      successionVotes: credential ? successionVotes(credential) : [],
      successionClaims: credential ? successionClaims(credential) : [] }
  }
}
