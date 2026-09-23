import { fromBase64Url, type LocalProfile } from "../domain/identity"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import * as Automerge from "@automerge/automerge/slim"
import { defaultProofStore, createWorkspaceGrant } from "../domain/proofs"
import { BrowserMeshAuthority, BrowserMeshCatalog, BrowserMeshOwnershipTransfer, BrowserMeshRecovery, BrowserMeshSuccession, mergeOwnershipTransfers, type OwnershipTransferHost } from "@meta-uber/mesh-runtime"
import { adaptVerifiedWorkspaceAdvertisement } from "@meta-uber/mesh-replication/protocol"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { createWorkspaceDeparture, type WorkspaceDeparture, createWorkspaceDeviceRevocation, type WorkspaceDeviceRevocation, createWorkspaceOwnershipTransfer, createWorkspaceRevocation,
  verifyWorkspaceMemberBundle,
  createWorkspaceSuccessionPolicy, createWorkspaceSuccessionVote, createWorkspaceSuccessionClaim,
  type WorkspaceMemberBundle, type WorkspaceOwnershipTransfer, type WorkspaceRevocation,
  type WorkspaceSuccessionPolicy, type WorkspaceSuccessionVote, type WorkspaceSuccessionClaim } from "./meshRecords"
import { type WorkspaceMeshCredential, type WorkspacePeerRecord } from "./peerStore"
import { workspaceSet, publishConfirmedWorkspace} from "./workspaceSet"
import { mergeSuccessionState, type SuccessionHost } from "@meta-uber/mesh-runtime"
import { deviceRevocations, isDeviceRevoked, uniqueCertificates, meshCatalog, revocations, ownershipTransfers, successionPolicy, successionVotes, successionClaims, ownerAuthorities, revokedPersonIds, isGrantRevoked, type MeshExport, type SessionEntry } from "./durableMeshBase"
import { DurableMeshCredentials } from "./durableMeshCredentials"

type VerifiedWorkspaceMember = Awaited<ReturnType<typeof verifyWorkspaceMemberBundle>>

export abstract class DurableMeshAuthority extends DurableMeshCredentials {
  private readonly catalog = new BrowserMeshCatalog<WorkspaceMeshCredential, MeshExport>({
    parse: raw => meshRustRuntime().state.validateMeshCatalog(raw) as MeshExport,
    credential: async workspaceId => (await this.store.getWorkspaceCredential(workspaceId)) ?? undefined,
    ownership: (credential, value) => this.mergeOwnershipTransfers(credential, value.ownershipTransfers ?? []),
    revocations: async (credential, value) => {
      try {
        await this.mergeDeviceRevocations(credential, value.deviceRevocations ?? [])
        credential = await this.store.getWorkspaceCredential(credential.workspaceId) ?? credential
        await this.mergeDepartures(credential, value.departures ?? [])
        credential = await this.store.getWorkspaceCredential(credential.workspaceId) ?? credential
        await this.mergeRevocations(credential, value.revocations)
      }
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
    credential = await this.store.getWorkspaceCredential(credential.workspaceId) ?? credential
    const previous = await this.store.getPeer(credential.workspaceId, raw.advertisement.payload.deviceId)
    raw = meshRustRuntime().state.planMemberGrant({ kind: "prefer",
      previous: previous?.advertisement ?? null, incoming: raw }).bundle as WorkspaceMemberBundle
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
    if (isDeviceRevoked(credential, p.personId, p.deviceId)) throw new Error("Device access revoked")
    const route = await adaptVerifiedWorkspaceAdvertisement(verified.advertisement)
    if (isGrantRevoked(credential, p.personId, raw.grant as WorkspaceGrant | undefined)) throw new Error("Workspace member is revoked")
    const profile = await this.options.getProfile()
    const local = meshRustRuntime().state.planMemberGrant({ kind: "persistLocal", credential,
      localPersonId: profile.identity.personId, grant: raw.grant ?? null,
      ownerCertificates, updatedAt: new Date().toISOString() })
    if (local.grantId && local.grant && local.credential) {
      await defaultProofStore.putGrant(local.grantId, local.grant as WorkspaceGrant)
      await this.store.putWorkspaceCredential(local.credential as WorkspaceMeshCredential)
    }
    const record: WorkspacePeerRecord = {
      workspaceId: route.scopeId,
      personId: route.personId,
      deviceId: route.deviceId,
      instanceId: route.instanceId,
      endpoint: route.endpoint,
      transportSecret: credential.transportSecret,
      role: verified.role,
      lastSeen: route.issuedAt,
      // A grant at a newer generation is the owner's explicit re-approval;
      // clear the old per-device tombstone so every device can reconnect.
      revokedAt: null,
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
      ownershipEpoch: credential => Math.max(1, ...[...ownershipTransfers(credential), ...successionClaims(credential)]
        .filter(record => record.payload.toOwnerPersonId === credential.ownerPersonId).map(record => record.payload.epoch)),
      authorities: ownerAuthorities, revokedPeople: revokedPersonIds,
      putCredential: credential => this.store.putWorkspaceCredential(credential),
      transferCredential: (previousOwner, credential) => this.store.transferWorkspaceCredential(previousOwner, credential),
      listPeers: workspaceId => this.store.listPeers(workspaceId),
      putPeers: async peers => { for (const peer of peers) await this.store.upsertPeer(peer as WorkspacePeerRecord) },
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
      listPeers: workspaceId => this.store.listPeers(workspaceId),
      putPeers: async peers => { for (const peer of peers) await this.store.upsertPeer(peer as WorkspacePeerRecord) },
      sessionCount: () => this.sessions.size, publishAll: () => this.publishAll(),
    }
  }
  private readonly authority = new BrowserMeshAuthority<WorkspaceMeshCredential, { personId: string; profile: LocalProfile }, WorkspaceRevocation>({
    profile: async () => {
      const profile = await this.options.getProfile()
      return { personId: profile.identity.personId, profile }
    },
    credential: async workspaceId => (await this.store.getWorkspaceCredential(workspaceId)) ?? undefined,
    createRevocation: async (owner, workspaceId, personId, epoch) => {
      const doc = Automerge.load(await this.options.workspaceStore.read(workspaceId))
      try {
        return await createWorkspaceRevocation(owner.profile, workspaceId, personId, epoch, Automerge.getHeads(doc))
      } finally { Automerge.free(doc) }
    },
    nextAccessEpoch: workspaceId => this.nextAccessEpoch(workspaceId),
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
  private readonly ownership = new BrowserMeshOwnershipTransfer<
    WorkspaceMeshCredential,
    { personId: string; profile: LocalProfile },
    WorkspacePeerRecord,
    VerifiedWorkspaceMember,
    WorkspaceOwnershipTransfer,
    SessionEntry
  >({
    profile: async () => {
      const profile = await this.options.getProfile()
      return { personId: profile.identity.personId, profile }
    },
    credential: async workspaceId => (await this.store.getWorkspaceCredential(workspaceId)) ?? undefined,
    peers: workspaceId => this.store.listPeers(workspaceId),
    online: (peer, workspaceId) => [...this.sessions.values()].some(session =>
      session.workspaceId === workspaceId && session.deviceId === peer.deviceId),
    confirmationSessions: (peers, workspaceId) => [...this.sessions.values()].filter(session =>
      session.workspaceId === workspaceId && peers.some(peer => peer.deviceId === session.deviceId) &&
      session.ownershipReceiptSupported),
    advertisement: peer => peer.advertisement,
    verifyTarget: (credential, raw) => verifyWorkspaceMemberBundle(raw, {
      workspaceId: credential.workspaceId, ownerPersonId: credential.ownerPersonId,
      ownerPublicKey: credential.ownerPublicKey,
      ownerCertificates: credential.ownerCertificates as DeviceCertificate[],
      ownerHistory: ownerAuthorities(credential).slice(1),
    }),
    transfers: ownershipTransfers,
    createTransfer: async (owner, credential, target) => {
      const doc = Automerge.load<Record<string, unknown>>(await this.options.workspaceStore.read(credential.workspaceId))
      try {
        return await createWorkspaceOwnershipTransfer(owner.profile, credential.workspaceId, {
          personId: target.payload.personId, publicKey: target.publicKey, certificates: target.certificates,
        }, Automerge.getHeads(doc), credential.epoch + 1)
      } finally { Automerge.free(doc) }
    },
    persistProposal: (credential, transfer) => this.store.putWorkspaceCredential({ ...credential,
      updatedAt: new Date().toISOString(), catalog: { ...meshCatalog(credential),
        ownershipTransfers: [...ownershipTransfers(credential), transfer] } }),
    confirmDelivery: async (sessions, credential) => {
      const snapshot = await workspaceSet(this.options.workspaceStore, [credential.workspaceId]).snapshot()
      await Promise.any(sessions.map(entry => publishConfirmedWorkspace(entry.connection, credential.transportSecret, snapshot)))
    },
    merge: (credential, transfer) => this.mergeOwnershipTransfers(credential, [transfer]).then(() => undefined),
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
    const refresh = meshRustRuntime().state.planSuccessionPolicyRefresh(current, eligible, credential.epoch)
    if (!refresh.changed) return
    const policy = await createWorkspaceSuccessionPolicy(profile, workspaceId, refresh.successorPersonId, eligible, credential.epoch)
    await this.store.putWorkspaceCredential({ ...credential, updatedAt: new Date().toISOString(),
      catalog: { ...meshCatalog(credential), successionPolicy: policy, successionVotes: [] } })
  }

  async voteForSuccessor(workspaceId: string, candidatePersonId: string): Promise<void> {
    await this.recovery.vote(workspaceId, candidatePersonId)
  }

  async claimSuccession(workspaceId: string): Promise<void> {
    await this.recovery.claim(workspaceId)
  }

  protected async mergeRevocations(credential: WorkspaceMeshCredential, raw: unknown[], disconnect = true) {
    const profile = await this.options.getProfile()
    const plan = meshRustRuntime().state.planAuthorityMerge({ credential,
      peers: await this.store.listPeers(credential.workspaceId), localPersonId: profile.identity.personId,
      localDeviceId: profile.device.deviceId, nowMs: Date.now(), records: { kind: "revocations", records: raw } })
    await this.store.putWorkspaceCredential(plan.credential as WorkspaceMeshCredential)
    for (const peer of plan.peers) await this.store.upsertPeer(peer as WorkspacePeerRecord)
    if (disconnect) for (const session of [...this.sessions.values()]) {
      if (session.workspaceId === credential.workspaceId && plan.evictDeviceIds.includes(session.deviceId)) await session.evict("peer revoked")
    }
    if (plan.localAccessRevoked) throw new Error("Workspace access revoked")
  }

  protected async mergeDepartures(credential: WorkspaceMeshCredential, records: WorkspaceDeparture[], disconnect = true): Promise<void> {
    if (!records.length) return
    const profile = await this.options.getProfile()
    const plan = meshRustRuntime().state.planAuthorityMerge({ credential,
      peers: await this.store.listPeers(credential.workspaceId), localPersonId: profile.identity.personId,
      localDeviceId: profile.device.deviceId, nowMs: Date.now(), records: { kind: "departures", records } })
    await this.store.putWorkspaceCredential(plan.credential as WorkspaceMeshCredential)
    if (!disconnect) return
    for (const peer of plan.peers) await this.store.upsertPeer(peer as WorkspacePeerRecord)
    for (const session of [...this.sessions.values()]) {
      if (session.workspaceId === credential.workspaceId && plan.evictPersonIds.includes(session.remotePersonId)) await session.evict("member left workspace")
    }
  }

  protected async mergeDeviceRevocations(credential: WorkspaceMeshCredential, records: WorkspaceDeviceRevocation[], disconnect = true): Promise<void> {
    if (!records.length) return
    const profile = await this.options.getProfile()
    const plan = meshRustRuntime().state.planAuthorityMerge({ credential,
      peers: await this.store.listPeers(credential.workspaceId), localPersonId: profile.identity.personId,
      localDeviceId: profile.device.deviceId, nowMs: Date.now(), records: { kind: "deviceRevocations", records } })
    await this.store.putWorkspaceCredential(plan.credential as WorkspaceMeshCredential)
    for (const peer of plan.peers) await this.store.upsertPeer(peer as WorkspacePeerRecord)
    if (disconnect) for (const session of [...this.sessions.values()]) {
      if (session.workspaceId === credential.workspaceId && plan.evictDeviceIds.includes(session.deviceId)) await session.evict("device revoked")
    }
    if (plan.localAccessRevoked) throw new Error("Workspace access revoked")
  }

  async removableDeviceWorkspaces(personId: string, deviceId: string): Promise<string[]> {
    const profile = await this.options.getProfile()
    const ids: string[] = []
    for (const credential of await this.store.listWorkspaceCredentials()) {
      const peer = await this.store.getPeer(credential.workspaceId, deviceId)
      if (meshRustRuntime().state.canRemoveWorkspaceDevice(credential, profile.identity.personId,
        profile.identity.publicKey, profile.device.deviceId, personId, deviceId, peer?.personId)) ids.push(credential.workspaceId)
    }
    return ids.sort()
  }

  async removeDevice(personId: string, deviceId: string, workspaceIds: string[]): Promise<void> {
    const eligible = await this.removableDeviceWorkspaces(personId, deviceId)
    if (!workspaceIds.length || workspaceIds.some(id => !eligible.includes(id))) throw new Error("Device removal scope is no longer authorized")
    const profile = await this.options.getProfile()
    if (deviceId === profile.device.deviceId) throw new Error("Remove this device from another device")
    const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
    for (const workspaceId of new Set(workspaceIds)) {
      const credential = (await this.store.getWorkspaceCredential(workspaceId))!
      const doc = Automerge.load(await this.options.workspaceStore.read(workspaceId))
      let heads: string[]
      try { heads = Automerge.getHeads(doc) } finally { Automerge.free(doc) }
      const record = await createWorkspaceDeviceRevocation(profile, workspaceId, personId, deviceId, heads, certificates)
      await this.mergeDeviceRevocations(credential, [record], false)
    }
    await this.publishAll()
    for (const workspaceId of new Set(workspaceIds)) {
      const credential = (await this.store.getWorkspaceCredential(workspaceId))!
      await this.mergeDeviceRevocations(credential, deviceRevocations(credential))
    }
    await this.notify()
  }

  async promotePerson(workspaceId: string, personId: string): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential || credential.ownerPersonId !== profile.identity.personId) throw new Error("Only the workspace owner can change roles")
    if (personId === credential.ownerPersonId) throw new Error("The owner is already authorized")
    const peers = (await this.peerInstances(workspaceId)).filter(peer => peer.personId === personId && !peer.revokedAt && peer.advertisement)
    if (!peers.length) throw new Error("No active membership found for this person")
    credential.ownerCertificates = uniqueCertificates(profile, [...credential.ownerCertificates as DeviceCertificate[], ...await defaultProofStore.listCertificates()])
    const epoch = await this.nextAccessEpoch(workspaceId)
    const grant = await createWorkspaceGrant(profile, workspaceId, personId, "editor", epoch)
    await defaultProofStore.putGrant(grant.payload.grantId, grant)
    await this.store.putWorkspaceCredential(credential)
    for (const peer of peers) {
      const bundle = { ...peer.advertisement as WorkspaceMemberBundle, grant, ownerPublicKey: credential.ownerPublicKey, ownerCertificates: credential.ownerCertificates as DeviceCertificate[] }
      await this.putVerifiedBundle(credential, bundle)
    }
    await this.refreshSuccessionPolicy(workspaceId)
    await this.notify()
    await this.publishAll()
  }

  async revokePerson(workspaceId: string, personId: string): Promise<void> {
    await this.authority.revokePerson(workspaceId, personId)
  }

  async transferOwnership(workspaceId: string, personId: string): Promise<void> {
    await this.ownership.transfer(workspaceId, personId)
  }


  async leaveWorkspace(workspaceId: string): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential) throw new Error("No workspace membership")
    if (credential.ownerPersonId === profile.identity.personId) throw new Error("Transfer ownership before leaving this workspace")
    const deadline = Date.now() + 20_000
    while (![...this.sessions.values()].some(session => session.workspaceId === workspaceId)) {
      if (Date.now() >= deadline) throw new Error("No verified workspace connection. Keep another device online, then retry leaving.")
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const snapshot = await workspaceSet(this.options.workspaceStore, [workspaceId]).snapshot()
    while (true) {
      const owners = [...this.sessions.values()].filter(session => session.workspaceId === workspaceId &&
        session.remotePersonId === credential.ownerPersonId && session.ownershipReceiptSupported)
      const receipts = await Promise.allSettled(owners.map(session =>
        publishConfirmedWorkspace(session.connection, credential.transportSecret, snapshot)))
      await Promise.all(owners.flatMap((session, index) => receipts[index]?.status === "rejected"
        ? [session.evict("workspace delivery unconfirmed")] : []))
      if (receipts.some(result => result.status === "fulfilled")) break
      if (Date.now() >= deadline) throw new Error("No owner confirmed the workspace before leaving. Keep an owner device online, then retry.")
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    const [{ bytes }] = JSON.parse(new TextDecoder().decode(snapshot)) as Array<{ bytes: string }>
    const workspaceDoc = Automerge.load(fromBase64Url(bytes))
    let workspaceHeads: string[]
    try { workspaceHeads = Automerge.getHeads(workspaceDoc) } finally { Automerge.free(workspaceDoc) }
    const departure = await createWorkspaceDeparture(profile, workspaceId, (credential.localGrant as WorkspaceGrant | undefined)?.payload.accessEpoch ?? 1,
      workspaceHeads,
      uniqueCertificates(profile, await defaultProofStore.listCertificates()))
    await this.mergeDepartures(credential, [departure], false)
    await this.publishAll()
    const current = await this.store.getWorkspaceCredential(workspaceId) ?? credential
    await this.mergeDepartures(current, [departure])
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
