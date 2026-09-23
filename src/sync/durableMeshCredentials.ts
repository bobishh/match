import { type LocalProfile } from "../domain/identity"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import { defaultProofStore } from "../domain/proofs"
import { createPairingSecret} from "@meta-uber/mesh-pairing"
import { activeCredentialsForProfile as selectActiveCredentials, BrowserMeshCredentials, BrowserMeshInvitations, credentialBelongsToProfile as credentialMatchesProfile } from "@meta-uber/mesh-runtime"
import { createPeerAdvertisement, verifyDeviceChain, verifyWorkspaceGrant,
  type WorkspaceMemberBundle, type WorkspaceOwnershipTransfer,
  type WorkspaceSuccessionPolicy, type WorkspaceSuccessionVote, type WorkspaceSuccessionClaim,
  type WorkspaceDeparture, type WorkspaceDeviceRevocation } from "./meshRecords"
import { type WorkspaceMeshCredential} from "./peerStore"
import type { SyncConnection} from "./transport"
import { workspaceSet, publishOwnerWorkspaceOffer} from "./workspaceSet"
import { departures, hasLeftWorkspace, deviceRevocations, isDeviceRevoked, uniqueCertificates, isEnvelope, meshCatalog, revocations, ownershipTransfers, successionPolicy, successionVotes, successionClaims, ownerAuthorities, revokedPersonIds,
  type MeshExport, type MeshWorkspaceEnvelope } from "./durableMeshBase"
import { DurableMeshBase } from "./durableMeshBase"

export abstract class DurableMeshCredentials extends DurableMeshBase {
  protected abstract mergeDepartures(credential: WorkspaceMeshCredential, records: WorkspaceDeparture[], disconnect?: boolean): Promise<void>
  protected abstract mergeDeviceRevocations(credential: WorkspaceMeshCredential, records: WorkspaceDeviceRevocation[]): Promise<void>
  private readonly credentialIdentityHost = {
    grant: (credential: WorkspaceMeshCredential) => {
      const grant = credential.localGrant as WorkspaceGrant | undefined
      return grant && { personId: grant.payload.personId }
    },
    authorities: (credential: WorkspaceMeshCredential) => ownerAuthorities(credential),
    verifyGrant: async (grant: unknown, workspaceId: string, personId: string, authority: { personId: string; publicKey: string; certificates: unknown[] }) => {
      await verifyWorkspaceGrant(grant as WorkspaceGrant, {
        workspaceId, personId, ownerPersonId: authority.personId, ownerPublicKey: authority.publicKey,
        ownerCertificates: authority.certificates as DeviceCertificate[],
      })
    },
  }
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
    ownerPersonId: envelope => envelope.ownerPersonId,
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
    if (credential.ownerPersonId !== profile.identity.personId) return credential
    const ownerCertificates = [...new Map([
      ...credential.ownerCertificates as DeviceCertificate[],
      ...certificates,
    ].filter(certificate => certificate?.payload?.personId === credential.ownerPersonId)
      .map(certificate => [certificate.signature, certificate])).values()]
    const hasStaleGrant = credential.localGrant !== undefined
    if (ownerCertificates.length === credential.ownerCertificates.length && !hasStaleGrant) return credential
    const ownerCredential = { ...credential }
    delete ownerCredential.localGrant
    const next = { ...ownerCredential, ownerCertificates, updatedAt: new Date().toISOString() }
    await this.store.putWorkspaceCredential(next)
    return next
  }


  protected async credentialBelongsToProfile(credential: WorkspaceMeshCredential, profile: LocalProfile): Promise<boolean> {
    if (hasLeftWorkspace(credential, profile.identity.personId, credential.localGrant as WorkspaceGrant | undefined) || isDeviceRevoked(credential, profile.identity.personId, profile.device.deviceId)) return false
    return credentialMatchesProfile(this.credentialIdentityHost, credential, {
      personId: profile.identity.personId, publicKey: profile.identity.publicKey,
    })
  }

  protected async activeCredentialsForProfile(credentials: WorkspaceMeshCredential[], profile: LocalProfile) {
    const { active, mismatched } = await selectActiveCredentials(this.credentialIdentityHost, credentials.filter(credential => !hasLeftWorkspace(credential, profile.identity.personId, credential.localGrant as WorkspaceGrant | undefined) && !isDeviceRevoked(credential, profile.identity.personId, profile.device?.deviceId)), {
      personId: profile.identity.personId, publicKey: profile.identity.publicKey,
    })
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
    return (await this.store.listWorkspaceCredentials())
      .filter(credential => credential.ownerPersonId === profile.identity.personId &&
        credential.ownerPublicKey === profile.identity.publicKey)
      .map(credential => credential.workspaceId)
      .sort()
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
    const value = JSON.parse(new TextDecoder().decode(bytes)) as {
      version?: unknown; workspaceId?: unknown; envelope?: unknown; workspace?: unknown
    }
    if (remotePersonId !== profile.identity.personId || value.version !== 1 ||
      typeof value.workspaceId !== "string" || !value.workspaceId ||
      (value.envelope as MeshWorkspaceEnvelope | undefined)?.ownerPersonId !== profile.identity.personId ||
      (value.envelope as MeshWorkspaceEnvelope | undefined)?.workspaceId !== value.workspaceId ||
      (value.workspace as { id?: unknown } | undefined)?.id !== value.workspaceId) {
      throw new Error("Invalid owner workspace offer")
    }
    // Persist the signed document before activating its credential. Otherwise
    // an interrupted offer leaves durable mesh retrying a workspace which has
    // no local document yet.
    await workspaceSet(this.options.workspaceStore, [value.workspaceId]).receive(
      new TextEncoder().encode(JSON.stringify([value.workspace])), false)
    await this.receiveInvitation([value.envelope], [value.workspaceId], profile, [])
    if (!this.node) throw new Error("Workspace mesh is unavailable")
    await this.ensureOwnerWorkspaces([value.workspaceId], this.node.endpointId, profile)
  }

  protected async offerMissingOwnerWorkspaces(connection: SyncConnection, secret: string,
    remoteWorkspaceIds: unknown, remotePersonId: string, ownerWorkspaceOfferFrame: "mesh-owner-workspace-offer" | undefined) {
    const profile = await this.options.getProfile()
    if (remotePersonId !== profile.identity.personId || !ownerWorkspaceOfferFrame) return
    const known = new Set(Array.isArray(remoteWorkspaceIds)
      ? remoteWorkspaceIds.filter((id): id is string => typeof id === "string")
      : [])
    for (const workspaceId of await this.ownerWorkspaceIds(profile)) {
      if (known.has(workspaceId)) continue
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
    for (const id of workspaceIds) {
      const credential = await this.store.getWorkspaceCredential(id)
      const issuer = await this.store.getPeer(id, deviceId)
      if (!credential || credential.ownerPersonId !== personId || !issuer?.advertisement ||
        issuer.personId !== personId || issuer.revokedAt || revokedPersonIds(credential).has(profile.identity.personId)) return false
      if (profile.identity.personId !== personId &&
        (credential.localGrant as WorkspaceGrant | undefined)?.payload.personId !== profile.identity.personId) return false
    }
    return workspaceIds.length > 0
  }

  async acceptGuest(workspaceIds: string[], rawBundles: unknown, grants: WorkspaceGrant[]): Promise<void> {
    if (!Array.isArray(rawBundles) || rawBundles.length !== workspaceIds.length) throw new Error("Invalid peer advertisements")
    for (const workspaceId of workspaceIds) {
      const credential = await this.store.getWorkspaceCredential(workspaceId)
      const raw = rawBundles.find((bundle: unknown) =>
        (bundle as { advertisement?: { payload?: { workspaceId?: unknown } } })?.advertisement?.payload?.workspaceId === workspaceId)
      const grant = grants.find(item => item.payload.workspaceId === workspaceId)
      if (!credential || !raw || !grant) throw new Error("Missing workspace mesh authority")
      await this.putVerifiedBundle(credential, { ...raw, grant, ownerPublicKey: credential.ownerPublicKey,
        ownerCertificates: credential.ownerCertificates } as WorkspaceMemberBundle)
      await this.refreshSuccessionPolicy(workspaceId)
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
    if (existing && (existing.ownerPersonId !== envelope.ownerPersonId || existing.ownerPublicKey !== envelope.ownerPublicKey)) {
      throw new Error("Workspace authority conflict: this device and the invitation name different owners. Existing permissions were preserved.")
    }
    const ownerCertificates = envelope.ownerCertificates as DeviceCertificate[]
    const ownerDeviceId = ownerCertificates[0]?.payload?.deviceId
    if (!ownerDeviceId) throw new Error("Invalid mesh invitation")
    if (envelope.ownerPersonId !== profile.identity.personId && (!localGrant || localGrant.payload.personId !== profile.identity.personId)) {
      throw new Error("Missing local workspace grant")
    }
    await verifyDeviceChain({ personId: envelope.ownerPersonId, publicKey: envelope.ownerPublicKey, deviceId: ownerDeviceId, certificates: ownerCertificates })
    for (const authority of envelope.ownerHistory ?? []) {
      await verifyDeviceChain({ personId: authority.personId, publicKey: authority.publicKey,
        deviceId: authority.certificates[0]?.payload.deviceId, certificates: authority.certificates })
    }
    if (localGrant) await verifyWorkspaceGrant(localGrant, { workspaceId, personId: profile.identity.personId,
      ownerPersonId: envelope.ownerPersonId, ownerPublicKey: envelope.ownerPublicKey, ownerCertificates })
    return ownerCertificates
  }

  protected async installInvitationWorkspace(workspaceId: string, envelope: MeshWorkspaceEnvelope, profile: LocalProfile,
    localGrant: WorkspaceGrant | undefined): Promise<void> {
    const ownerCertificates = await this.verifyInvitationAuthority(workspaceId, envelope, profile, localGrant)
    const previous = await this.store.getWorkspaceCredential(workspaceId)
    const previousAuthority = await this.store.getWorkspaceAuthority(workspaceId)
    if (previousAuthority && (previousAuthority.ownerPersonId !== envelope.ownerPersonId || previousAuthority.ownerPublicKey !== envelope.ownerPublicKey)) {
      throw new Error("Workspace authority conflict: this device and the invitation name different owners. Existing permissions were preserved.")
    }
    const retained = previous ?? previousAuthority
    const credential: WorkspaceMeshCredential = {
      version: 1, workspaceId, ownerPersonId: envelope.ownerPersonId, ownerPublicKey: envelope.ownerPublicKey,
      ownerCertificates, ownerHistory: envelope.ownerHistory, transportSecret: envelope.transportSecret,
      epoch: Math.max(retained?.epoch ?? 1, envelope.epoch),
      updatedAt: new Date().toISOString(), ...(localGrant ? { localGrant } : {}),
      catalog: { ...(retained ? meshCatalog(retained) : {}), revocations: retained ? revocations(retained) : [], ownershipTransfers: envelope.ownershipTransfers ?? [], successionPolicy: undefined,
        successionVotes: [], successionClaims: [] },
    }
    await this.store.putWorkspaceCredential(credential)
    await this.mergeInvitationCatalog(credential, envelope)
  }

  private async mergeInvitationCatalog(credential: WorkspaceMeshCredential, envelope: MeshWorkspaceEnvelope) {
    const workspaceId = credential.workspaceId
    await this.mergeDeviceRevocations(credential, envelope.deviceRevocations ?? [])
    credential = await this.store.getWorkspaceCredential(workspaceId) ?? credential
    await this.mergeDepartures(credential, envelope.departures ?? [])
    credential = await this.store.getWorkspaceCredential(workspaceId) ?? credential
    if (envelope.revocations) await this.mergeRevocations(credential, envelope.revocations)
    await this.mergeSuccessionState(await this.store.getWorkspaceCredential(workspaceId) ?? credential,
      envelope.successionPolicy, envelope.successionVotes ?? [], envelope.successionClaims ?? [])
    credential = await this.store.getWorkspaceCredential(workspaceId) ?? credential
    await this.mergePeerBundles(credential, envelope.peers)
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
    return Math.max(
      credential?.epoch ?? 0,
      ...issued.map(grant => grant.payload.accessEpoch ?? 1),
      ...(credential ? departures(credential).map(value => value.record.payload.accessEpoch) : []),
      ...(credential ? revocations(credential).map(value => value.payload.epoch) : []),
    ) + 1
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
