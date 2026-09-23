import { fromBase64Url, signEnvelope, type LocalProfile } from "../domain/identity"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import * as Automerge from "@automerge/automerge/slim"
import { defaultProofStore, createWorkspaceGrant } from "../domain/proofs"
import { adaptVerifiedWorkspaceAdvertisement } from "@meta-uber/mesh-replication/protocol"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { createWorkspaceDeparture, type WorkspaceDeparture, createWorkspaceDeviceRevocation, type WorkspaceDeviceRevocation, createWorkspaceOwnershipTransfer, createWorkspaceRevocation,
  verifyWorkspaceMemberBundle,
  createWorkspaceSuccessionPolicy, createWorkspaceSuccessionVote, createWorkspaceSuccessionClaim,
  type WorkspaceMemberBundle, type WorkspaceOwnershipTransfer, type WorkspaceRevocation,
  type WorkspaceSuccessionPolicy, type WorkspaceSuccessionVote, type WorkspaceSuccessionClaim } from "./meshRecords"
import { type WorkspaceMeshCredential, type WorkspacePeerRecord } from "./peerStore"
import { workspaceSet, publishConfirmedWorkspace} from "./workspaceSet"
import { deviceRevocations, isDeviceRevoked, uniqueCertificates, meshCatalog, revocations, ownershipTransfers, successionPolicy, successionVotes, successionClaims, ownerAuthorities, revokedPersonIds, isGrantRevoked, type MeshExport, type SessionEntry } from "./durableMeshBase"
import { DurableMeshCredentials } from "./durableMeshCredentials"

type VerifiedWorkspaceMember = Awaited<ReturnType<typeof verifyWorkspaceMemberBundle>>

export abstract class DurableMeshAuthority extends DurableMeshCredentials {
  async mergeWorkspace(workspaceId: string, raw: unknown): Promise<void> {
    const value = meshRustRuntime().state.validateMeshCatalog(raw) as MeshExport
    let credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential) return
    const effects: Record<string, () => Promise<void>> = {
      ownership: async () => { credential = await this.mergeOwnershipTransfers(credential!, value.ownershipTransfers ?? []) },
      revocations: async () => {
        try {
          await this.mergeDeviceRevocations(credential!, value.deviceRevocations ?? [])
          credential = await this.store.getWorkspaceCredential(workspaceId) ?? credential
          await this.mergeDepartures(credential!, value.departures ?? [])
          credential = await this.store.getWorkspaceCredential(workspaceId) ?? credential
          await this.mergeRevocations(credential!, value.revocations ?? [])
        } catch (error) {
          if (error instanceof Error && error.message === "Workspace access revoked") await this.notify()
          throw error
        }
      },
      refreshCredential: async () => { credential = await this.store.getWorkspaceCredential(workspaceId) ?? credential },
      succession: async () => { credential = await this.mergeSuccessionState(credential!, value.successionPolicy,
        value.successionVotes ?? [], value.successionClaims ?? []) },
      peers: () => this.mergePeerBundles(credential!, value.peers),
      notify: () => this.notify(),
    }
    for (const action of meshRustRuntime().state.planCatalogMerge()) {
      const effect = effects[action]
      if (!effect) throw new Error(`Unexpected mesh catalog action: ${action}`)
      await effect()
    }
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
    const plan = meshRustRuntime().state.planOwnershipMerge({ workspaceId: initialCredential.workspaceId,
      currentOwner: { personId: initialCredential.ownerPersonId, publicKey: initialCredential.ownerPublicKey,
        certificates: initialCredential.ownerCertificates }, ownerHistory: ownerAuthorities(initialCredential).slice(1),
      ownerEpoch: Math.max(1, ...[...ownershipTransfers(initialCredential), ...successionClaims(initialCredential)]
        .filter(record => record.payload.toOwnerPersonId === initialCredential.ownerPersonId).map(record => record.payload.epoch)),
      current: ownershipTransfers(initialCredential), incoming: raw,
      revokedPeople: [...revokedPersonIds(initialCredential)], nowMs: Date.now() }) as {
        accepted: WorkspaceOwnershipTransfer[]; steps: Array<{ record: WorkspaceOwnershipTransfer;
          accepted: WorkspaceOwnershipTransfer[]; previousOwnerEpoch: number }>; persistCatalog: boolean
      }
    let credential = initialCredential
    for (const step of plan.steps) {
      const profile = await this.options.getProfile()
      const adoption = meshRustRuntime().state.planOwnershipAdoption({ credential,
        peers: await this.store.listPeers(credential.workspaceId), localPersonId: profile.identity.personId,
        verifiedCurrentOwnerEpoch: step.previousOwnerEpoch,
        transition: { kind: "transfer", record: step.record, accepted: step.accepted } })
      credential = adoption.credential as WorkspaceMeshCredential
      await this.store.transferWorkspaceCredential(adoption.previousOwnerPersonId, credential)
      for (const peer of adoption.peers) await this.store.upsertPeer(peer as WorkspacePeerRecord)
    }
    if (plan.persistCatalog) {
      credential = { ...credential, catalog: { ...meshCatalog(credential), ownershipTransfers: plan.accepted } }
      await this.store.putWorkspaceCredential(credential)
    }
    return credential
  }

  protected async mergeSuccessionState(initialCredential: WorkspaceMeshCredential, rawPolicy: WorkspaceSuccessionPolicy | undefined,
    rawVotes: WorkspaceSuccessionVote[], rawClaims: WorkspaceSuccessionClaim[]): Promise<WorkspaceMeshCredential> {
    const plan = meshRustRuntime().state.planSuccessionMerge({ workspaceId: initialCredential.workspaceId,
      owner: { personId: initialCredential.ownerPersonId, publicKey: initialCredential.ownerPublicKey,
        certificates: initialCredential.ownerCertificates }, ownerHistory: ownerAuthorities(initialCredential), epoch: initialCredential.epoch,
      currentPolicy: successionPolicy(initialCredential) ?? null, currentVotes: successionVotes(initialCredential), currentClaims: successionClaims(initialCredential),
      incomingPolicy: rawPolicy ?? null, incomingVotes: rawVotes, incomingClaims: rawClaims,
      revokedPeople: [...revokedPersonIds(initialCredential)], revokedBeforeEpoch: [...new Set(revocations(initialCredential)
        .filter(record => record.payload.epoch < initialCredential.epoch).map(record => record.payload.personId))],
    }, Date.now()) as { noop: boolean; policy?: WorkspaceSuccessionPolicy; votes: WorkspaceSuccessionVote[];
      claims: WorkspaceSuccessionClaim[]; transitions: WorkspaceSuccessionClaim[]; conflicted: boolean }
    if (plan.noop) return initialCredential
    let credential = initialCredential
    if (!plan.conflicted) for (const claim of plan.transitions) {
      const profile = await this.options.getProfile()
      const adoption = meshRustRuntime().state.planOwnershipAdoption({ credential,
        peers: await this.store.listPeers(credential.workspaceId), localPersonId: profile.identity.personId,
        verifiedCurrentOwnerEpoch: credential.epoch,
        transition: { kind: "succession", record: claim, claims: plan.claims } })
      credential = adoption.credential as WorkspaceMeshCredential
      await this.store.transferWorkspaceCredential(adoption.previousOwnerPersonId, credential)
      for (const peer of adoption.peers) await this.store.upsertPeer(peer as WorkspacePeerRecord)
    }
    const catalogPlan = meshRustRuntime().state.planSuccessionCatalog({ originalCatalog: meshCatalog(initialCredential),
      originalOwnerPersonId: initialCredential.ownerPersonId, credential,
      policy: plan.policy ?? null, votes: plan.votes, claims: plan.claims,
      updatedAt: new Date().toISOString() })
    if (catalogPlan.persist) {
      credential = catalogPlan.credential as WorkspaceMeshCredential
      await this.store.putWorkspaceCredential(credential)
      credential = await this.store.getWorkspaceCredential(credential.workspaceId) ?? credential
    }
    if (catalogPlan.publish && this.sessions.size > 0) queueMicrotask(() => { void this.publishAll() })
    return credential
  }
  async setSuccessor(workspaceId: string, personId: string | null): Promise<void> {
    const [profile, credential] = await Promise.all([this.options.getProfile(), this.store.getWorkspaceCredential(workspaceId)])
    const eligible = credential?.ownerPersonId === profile.identity.personId
      ? meshRustRuntime().state.eligibleEditorPersonIds(await this.store.listPeers(workspaceId)) : []
    const actions = meshRustRuntime().state.planAuthorityCommand({ kind: "setSuccessor",
      localPersonId: profile.identity.personId, ownerPersonId: credential?.ownerPersonId ?? null,
      successorPersonId: personId, eligibleEditorPersonIds: eligible })
    let policy!: WorkspaceSuccessionPolicy
    for (const action of actions) {
      if (action === "createPolicy") policy = await createWorkspaceSuccessionPolicy(profile, workspaceId, personId, eligible, credential!.epoch)
      if (action === "setPolicy") await this.store.putWorkspaceCredential({ ...credential!, updatedAt: new Date().toISOString(),
        catalog: { ...meshCatalog(credential!), successionPolicy: policy, successionVotes: [] } })
      if (action === "notify") await this.notify()
      if (action === "publish") await this.publishAll()
    }
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
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    const policy = credential && successionPolicy(credential)
    const grant = credential?.localGrant as WorkspaceGrant | undefined
    const votes = credential ? successionVotes(credential) : []
    const existing = votes.find(vote => vote.signed.payload.voterPersonId === profile.identity.personId)
    const actions = meshRustRuntime().state.planAuthorityCommand({ kind: "vote", localPersonId: profile.identity.personId,
      hasCredential: Boolean(credential), hasPolicy: Boolean(policy), grantRole: grant?.payload.role ?? null,
      eligibleEditorPersonIds: policy?.payload.eligibleEditorPersonIds ?? [], successorPersonId: policy?.payload.successorPersonId ?? null,
      candidatePersonId, existingVoteFor: existing?.signed.payload.candidatePersonId ?? null })
    let vote!: WorkspaceSuccessionVote
    for (const action of actions) {
      if (action === "createVote") vote = await createWorkspaceSuccessionVote(profile, policy!, candidatePersonId, grant!,
        new Date().toISOString(), uniqueCertificates(profile, await defaultProofStore.listCertificates()))
      if (action === "mergeVote") await this.mergeSuccessionState(credential!, policy!, [vote], [])
      if (action === "notify") await this.notify()
      if (action === "publish") await this.publishAll()
    }
  }

  async claimSuccession(workspaceId: string): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    const policy = credential && successionPolicy(credential)
    const grant = credential?.localGrant as WorkspaceGrant | undefined
    const votes = credential ? successionVotes(credential) : []
    const actions = meshRustRuntime().state.planAuthorityCommand({ kind: "claim", localPersonId: profile.identity.personId,
      hasCredential: Boolean(credential), hasPolicy: Boolean(policy), grantRole: grant?.payload.role ?? null,
      grantPersonId: grant?.payload.personId ?? null })
    let claim!: WorkspaceSuccessionClaim
    for (const action of actions) {
      if (action === "createClaim") {
        const doc = Automerge.load<Record<string, unknown>>(await this.options.workspaceStore.read(credential!.workspaceId))
        try { claim = await createWorkspaceSuccessionClaim(profile, policy!, votes, grant!, Automerge.getHeads(doc), credential!.epoch + 1,
          uniqueCertificates(profile, await defaultProofStore.listCertificates())) } finally { Automerge.free(doc) }
      }
      if (action === "mergeClaim") await this.mergeSuccessionState(credential!, policy!, votes, [claim])
      if (action === "notify") await this.notify()
      if (action === "publish") await this.publishAll()
    }
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
    const peers = (await this.peerInstances(workspaceId)).filter(peer => peer.personId === personId && !peer.revokedAt && peer.advertisement)
    const actions = meshRustRuntime().state.planAuthorityCommand({ kind: "promote",
      localPersonId: profile.identity.personId, ownerPersonId: credential?.ownerPersonId ?? null,
      targetPersonId: personId, hasActiveMembership: peers.length > 0 })
    if (!credential) throw new Error("Workspace credential unavailable")
    credential.ownerCertificates = uniqueCertificates(profile, [...credential.ownerCertificates as DeviceCertificate[], ...await defaultProofStore.listCertificates()])
    let grant: WorkspaceGrant | undefined
    for (const action of actions) {
      if (action === "createGrant") {
        const epoch = await this.nextAccessEpoch(workspaceId)
        grant = await createWorkspaceGrant(profile, workspaceId, personId, "editor", epoch)
      }
      if (action === "persistGrant") {
        if (!grant) throw new Error("Promotion grant was not created")
        await defaultProofStore.putGrant(grant.payload.grantId, grant)
        await this.store.putWorkspaceCredential(credential!)
        for (const peer of peers) {
          const bundle = { ...peer.advertisement as WorkspaceMemberBundle, grant, ownerPublicKey: credential!.ownerPublicKey, ownerCertificates: credential!.ownerCertificates as DeviceCertificate[] }
          await this.putVerifiedBundle(credential!, bundle)
        }
      }
      if (action === "refreshSuccessionPolicy") await this.refreshSuccessionPolicy(workspaceId)
      if (action === "notify") await this.notify()
      if (action === "publish") await this.publishAll()
    }
  }

  async revokePerson(workspaceId: string, personId: string): Promise<void> {
    const profile = await this.options.getProfile()
    let current = await this.store.getWorkspaceCredential(workspaceId)
    const actions = meshRustRuntime().state.planAuthorityCommand({ kind: "revoke", localPersonId: profile.identity.personId,
      ownerPersonId: current?.ownerPersonId ?? null })
    let record!: WorkspaceRevocation
    for (const action of actions) {
      if (action === "createRevocation") {
        const doc = Automerge.load(await this.options.workspaceStore.read(workspaceId))
        try { record = await createWorkspaceRevocation(profile, workspaceId, personId, await this.nextAccessEpoch(workspaceId), Automerge.getHeads(doc)) }
        finally { Automerge.free(doc) }
      }
      if (action === "mergeRevocation") await this.mergeRevocations(current!, [record], false)
      if (action === "refreshSuccessionPolicy") await this.refreshSuccessionPolicy(workspaceId)
      if (action === "publish") await this.publishAll()
      if (action === "reloadCredential") current = await this.store.getWorkspaceCredential(workspaceId) ?? current
      if (action === "disconnectRevoked") await this.mergeRevocations(current!, [record], true)
      if (action === "notify") await this.notify()
    }
  }

  async transferOwnership(workspaceId: string, personId: string): Promise<void> {
    await this.transferOwnershipWithReceipt(workspaceId, personId)
  }

  private async transferOwnershipWithReceipt(workspaceId: string, personId: string): Promise<void> {
    const [profile, credential, allPeers] = await Promise.all([
      this.options.getProfile(), this.store.getWorkspaceCredential(workspaceId), this.peerInstances(workspaceId),
    ])
    const advertisements = allPeers.map(peer => peer.advertisement)
    const targetPeers = allPeers.filter(peer => peer.personId === personId && !peer.revokedAt)
    const sessions = [...this.sessions.values()].filter(session => session.workspaceId === workspaceId &&
      session.remotePersonId === personId && session.ownershipReceiptSupported)
    const plan = meshRustRuntime().state.planOwnershipAuthorityFlow({
      localPersonId: profile.identity.personId, ownerPersonId: credential?.ownerPersonId ?? null,
      credentialEpoch: credential?.epoch ?? null, targetPersonId: personId,
      peers: allPeers.map((peer, index) => ({ personId: peer.personId, revoked: Boolean(peer.revokedAt),
        online: targetPeers.some(target => target.deviceId === peer.deviceId && sessions.some(session => session.deviceId === target.deviceId)),
        hasAdvertisement: Boolean(advertisements[index]) })),
      transfers: credential ? ownershipTransfers(credential).map(record => record.payload) : [],
      confirmationSessionCount: sessions.length,
    })
    const targetAdvertisement = plan.selection.advertisementIndex === null ? undefined
      : advertisements[plan.selection.advertisementIndex] as WorkspaceMemberBundle | undefined
    const pending = credential && plan.selection.pendingIndex === null ? undefined
      : ownershipTransfers(credential!)[plan.selection.pendingIndex!]
    let target!: VerifiedWorkspaceMember
    let transfer: WorkspaceOwnershipTransfer = pending!
    let current = credential!
    let nextScopeAuthoritySnapshot: {
      genesis: unknown; grants: unknown[]; grantIssuers: unknown[]; revocations: unknown[]; controlTransfers: unknown[]
    } | undefined
    for (const action of plan.actions) {
      if (action === "verifyTarget") target = await verifyWorkspaceMemberBundle(targetAdvertisement!, {
        workspaceId, ownerPersonId: credential!.ownerPersonId, ownerPublicKey: credential!.ownerPublicKey,
        ownerCertificates: credential!.ownerCertificates as DeviceCertificate[], ownerHistory: ownerAuthorities(credential!).slice(1),
      })
      if (action === "createTransfer") {
        const doc = Automerge.load(await this.options.workspaceStore.read(workspaceId))
        try { transfer = await createWorkspaceOwnershipTransfer(profile, workspaceId, {
          personId: target.payload.personId, publicKey: target.publicKey, certificates: target.certificates,
        }, Automerge.getHeads(doc), credential!.epoch + 1) } finally { Automerge.free(doc) }
        const authority = await this.store.getWorkspaceAuthority(workspaceId)
        const snapshot = authority?.scopeAuthoritySnapshot
        if (snapshot) {
          const payload = meshRustRuntime().state.createScopeControlTransferPayload({ snapshot,
            toController: { personId: target.payload.personId, publicKey: target.publicKey, certificates: target.certificates } }) as { kind: string }
          const controlTransfer = await signEnvelope(profile.privateKeys.devicePrivateKey, payload, profile.device.deviceId)
          nextScopeAuthoritySnapshot = { ...snapshot, controlTransfers: [...snapshot.controlTransfers, controlTransfer] }
          meshRustRuntime().state.validateScopeAuthority(nextScopeAuthoritySnapshot)
        }
      }
      if (action === "persistProposal") await this.store.putWorkspaceCredential({ ...credential!, updatedAt: new Date().toISOString(),
        catalog: { ...meshCatalog(credential!), ownershipTransfers: [...ownershipTransfers(credential!), transfer] } })
      if (action === "confirmDelivery") {
        const snapshot = await workspaceSet(this.options.workspaceStore, [workspaceId]).snapshot()
        const receipts = await Promise.allSettled(sessions.map(session =>
          publishConfirmedWorkspace(session.connection, credential!.transportSecret, snapshot)))
        await Promise.all(sessions.flatMap((session, index) => receipts[index]?.status === "rejected"
          ? [session.evict("ownership delivery unconfirmed")] : []))
        if (!receipts.some(receipt => receipt.status === "fulfilled")) {
          throw new Error("Ownership delivery is unconfirmed. Keep both devices open and retry the same recipient.")
        }
      }
      if (action === "mergeTransfer") {
        current = await this.store.getWorkspaceCredential(workspaceId) ?? current
        await this.mergeOwnershipTransfers(current, [transfer])
        if (nextScopeAuthoritySnapshot) {
          const authority = await this.store.getWorkspaceAuthority(workspaceId)
          if (!authority) throw new Error("Workspace authority disappeared during ownership transfer")
          await this.store.putWorkspaceAuthority({ ...authority, scopeAuthoritySnapshot: nextScopeAuthoritySnapshot })
        }
      }
      if (action === "notify") await this.notify()
      if (action === "publish") await this.publishAll()
    }
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
    for (const action of meshRustRuntime().state.planAuthorityCommand({ kind: "leave", workspaceId })) {
      if (action === "leave") await this.leaveWorkspaceHost(workspaceId)
      if (action === "notify") await this.notify()
    }
  }

  private async leaveWorkspaceHost(workspaceId: string): Promise<void> {
    for (const [, entry] of [...this.sessions]) {
      if (entry.workspaceId !== workspaceId) continue
      await entry.evict("workspace left")
    }
    this.gossip.close(workspaceId)
    await this.store.removeWorkspaceMeshData(workspaceId)
    await defaultProofStore.removeWorkspaceGrants(workspaceId)
    this.lastDiagnostic = ""
    this.options.onDiagnostic?.("")
    this.clearRouteReconnects(`${workspaceId}:`)
  }

}
