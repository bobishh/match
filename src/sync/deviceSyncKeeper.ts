import { createKeeperWorkspaceHost, type WorkspaceHostContext } from "./deviceSyncHost"
import type { KeeperDisconnectScope, KeeperIntegrationStatus, KeeperPairing, KeeperPairingStatus } from "./lighthousePairing"
import type { KeeperDisconnectReceipt } from "./keeperIntegrationStatus"
import type { WorkspaceJoinInvitation } from "@meta-uber/mesh-pairing"
import { keeperIntegrationReferences, ownerKeepers, removeOwnerKeeper, saveKeeperIntegrationReference, saveOwnerKeeper, type KeeperDetails } from "./ownerKeeper"
import type { LocalProfile } from "../domain/identity"
import type { KeeperIntegrationReference } from "../domain/model"
import type { LighthouseDiscovery } from "./lighthouseDiscovery"
import type { DurableMesh } from "./durableMesh"

function cachedDiscovery(details: KeeperDetails): LighthouseDiscovery | undefined {
  if (!details.origin || !details.servicePersonId || !details.serviceDeviceId || !details.servicePublicKey || !details.serviceCertificates) return undefined
  return {
    origin: details.origin,
    displayName: "Rusty keeper",
    personId: details.servicePersonId,
    deviceId: details.serviceDeviceId,
    publicKey: details.servicePublicKey,
    certificates: details.serviceCertificates,
    fingerprint: "",
    capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true, blobReplication: true, pairing: true },
  }
}

function findIntegration(status: { integrations: KeeperIntegrationStatus[] }, ownerIds: Set<string>,
  integrationId?: string): KeeperIntegrationStatus | undefined {
  const matching = status.integrations.filter(integration => (!integrationId || integration.integrationId === integrationId)
    && (integration.scopes.some(scope => ownerIds.has(scope.workspaceId)) || integration.pendingOperation !== undefined))
  if (matching.length > 1) throw new Error("Rusty returned multiple active integrations; choose one before removing access.")
  return matching[0] ?? (integrationId ? status.integrations.find(item => item.integrationId === integrationId) : undefined)
}

function selectRemovalScopes(integration: KeeperIntegrationStatus, localPending: KeeperIntegrationReference["pendingRemoval"],
  localOwners: Map<string, boolean>): KeeperDisconnectScope[] {
  const pending = integration.pendingOperation?.scopes ?? localPending?.scopes
  const requested = pending ?? integration.scopes.map(scope => ({ workspaceId: scope.workspaceId, expectedGrantEpoch: scope.grantEpoch }))
  const scopes = requested.map(scope => {
    if (localOwners.has(scope.workspaceId) && !localOwners.get(scope.workspaceId)) {
      throw new Error("Rusty listed a board that is not owned by this identity.")
    }
    const active = integration.scopes.find(candidate => candidate.workspaceId === scope.workspaceId)
    const tombstone = integration.tombstones.find(candidate => candidate.workspaceId === scope.workspaceId
      && candidate.grantEpoch === scope.expectedGrantEpoch)
    if (active?.grantEpoch !== scope.expectedGrantEpoch && !tombstone) {
      throw new Error("Pending removal refers to a different board grant generation.")
    }
    return { workspaceId: scope.workspaceId, expectedGrantEpoch: scope.expectedGrantEpoch }
  })
  if (new Set(scopes.map(scope => scope.workspaceId)).size !== scopes.length) throw new Error("Rusty returned duplicate pending removal scopes.")
  return scopes
}

function removalAlreadyCompleted(integration: KeeperIntegrationStatus, reference: KeeperIntegrationReference | undefined,
  localPending: KeeperIntegrationReference["pendingRemoval"]): boolean {
  if (integration.scopes.length) return false
  if (localPending) {
    const done = new Set(integration.tombstones.filter(item => item.state === "removed" && item.cleanup === "complete"
      && item.operationId === localPending.operationId).map(item => `${item.workspaceId}\0${item.grantEpoch}`))
    return localPending.scopes.every(scope => done.has(`${scope.workspaceId}\0${scope.expectedGrantEpoch}`))
  }
  if (reference?.completedRemoval) {
    const done = new Set(integration.tombstones.filter(item => item.state === "removed" && item.cleanup === "complete"
      && item.operationId === reference.completedRemoval!.operationId).map(item => `${item.workspaceId}\0${item.grantEpoch}`))
    return reference.completedRemoval.scopes.every(scope => done.has(`${scope.workspaceId}\0${scope.grantEpoch}`))
  }
  return !!reference?.scopeReceipts?.length && reference.scopeReceipts.every(scope => integration.tombstones.some(item =>
    item.workspaceId === scope.workspaceId && item.grantEpoch === scope.grantEpoch
      && item.state === "removed" && item.cleanup === "complete"))
}

async function revokeLocalScopes(mesh: DurableMesh, personId: string, scopes: string[], localOwners: Map<string, boolean>,
  alreadyRevoked: Set<string>, trace?: RemovalOptions["trace"]) {
  for (const workspaceId of scopes) {
    const owned = localOwners.get(workspaceId) === true
    traceRemoval(trace, "scope-check", { peerId: personId, workspaceId, outcome: owned ? "owner" : "not-owner" })
    if (owned && !alreadyRevoked.has(workspaceId)) {
      traceRemoval(trace, "revoke-start", { peerId: personId, workspaceId, outcome: "requested" })
      await mesh.revokePerson(workspaceId, personId)
      alreadyRevoked.add(workspaceId)
      traceRemoval(trace, "revoke-complete", { peerId: personId, workspaceId, outcome: "success" })
    }
  }
}

async function persistRemovalReceipt(profile: LocalProfile, personId: string, discovery: LighthouseDiscovery,
  integration: KeeperIntegrationStatus, receipt: KeeperDisconnectReceipt,
  descriptor: KeeperIntegrationReference) {
  const removedIds = new Set(receipt.scopes.map(scope => scope.workspaceId))
  const remaining = integration.scopes.filter(scope => !removedIds.has(scope.workspaceId))
  const nextDescriptor: KeeperIntegrationReference = { ...descriptor,
    workspaceIds: remaining.map(scope => scope.workspaceId),
    scopeReceipts: remaining.map(scope => ({ workspaceId: scope.workspaceId,
      grantEpoch: scope.grantEpoch, activationOperationId: scope.activationOperationId })),
    state: remaining.length ? "active" : "removed", revision: receipt.revision,
    pendingRemoval: undefined,
    completedRemoval: remaining.length ? descriptor.completedRemoval : {
      operationId: receipt.operationId,
      scopes: receipt.scopes.map(scope => ({ workspaceId: scope.workspaceId, grantEpoch: scope.grantEpoch })),
    }, verifiedAt: new Date().toISOString() }
  await saveKeeperIntegrationReference(nextDescriptor)
  if (!remaining.length) {
    try {
      await removeOwnerKeeper(profile.identity.personId, personId)
    } catch (error) {
      throw new Error("Rusty confirmed removal; local keeper cleanup is pending. Retry removal to finish.", { cause: error })
    }
    await saveKeeperIntegrationReference({ ...nextDescriptor, scopeReceipts: [] })
    return
  }
  await saveOwnerKeeper(profile.identity.personId, { personId, role: "editor", details: {
    origin: discovery.origin, boardIds: nextDescriptor.workspaceIds, futureBoards: nextDescriptor.futureBoards,
    futureBoardBaselineIds: nextDescriptor.futureBoardBaselineIds,
    integrationId: nextDescriptor.integrationId, servicePersonId: nextDescriptor.servicePersonId,
    serviceDeviceId: nextDescriptor.serviceDeviceId, servicePublicKey: nextDescriptor.servicePublicKey,
    serviceCertificates: nextDescriptor.serviceCertificates, revision: nextDescriptor.revision,
  } })
}

export type RemovalOptions = {
  getProfile: () => Promise<LocalProfile>
  workspaces: { id: string }[]
  workspaceOwner?: (id: string) => Promise<string>
  mesh: () => Promise<DurableMesh | undefined>
  activeWorkspaceId?: string
  discovery?: LighthouseDiscovery
  knownServiceDeviceIds?: string[]
  trace?: (event: string, detail: Record<string, unknown>) => void
}

function traceRemoval(trace: RemovalOptions["trace"], event: string, detail: Record<string, unknown>) {
  trace?.(event, detail)
}

function removalSource(reference: KeeperIntegrationReference | undefined, legacyKeeper: Awaited<ReturnType<typeof ownerKeepers>>[number] | undefined) {
  if (reference) return "integration-reference"
  if (legacyKeeper?.details?.boardIds?.length) return "legacy-saved"
  return "legacy-current-workspaces"
}

function keeperReferenceForPerson(integrations: Record<string, KeeperIntegrationReference>, personId: string) {
  const priority = (state: KeeperIntegrationReference["state"]) => state === "active" ? 0 : state === "removing" ? 1 : 2
  return Object.values(integrations).filter(item => item.servicePersonId === personId)
    .sort((left, right) => priority(left.state) - priority(right.state) || right.revision - left.revision)[0]
}

function resolveRemovalDiscovery(personId: string, reference: KeeperIntegrationReference | undefined,
  legacyKeeper: Awaited<ReturnType<typeof ownerKeepers>>[number] | undefined, options: RemovalOptions) {
  const discovery = options.discovery ?? (reference ? cachedDiscovery({
    origin: reference.serviceOrigin, boardIds: reference.workspaceIds, futureBoards: reference.futureBoards,
    integrationId: reference.integrationId, servicePersonId: reference.servicePersonId,
    serviceDeviceId: reference.serviceDeviceId, servicePublicKey: reference.servicePublicKey,
    serviceCertificates: reference.serviceCertificates, revision: reference.revision,
  }) : legacyKeeper?.details ? cachedDiscovery(legacyKeeper.details) : undefined)
  if (!discovery) throw new Error("Enter and verify this Rusty keeper's address before removing it.")
  if (discovery.personId !== personId) throw new Error("This address points to a different keeper identity.")
  if (options.knownServiceDeviceIds?.length && !options.knownServiceDeviceIds.includes(discovery.deviceId)) {
    throw new Error("This address points to a different keeper device.")
  }
  return discovery
}

async function localOwnerFlags(workspaces: { id: string }[], workspaceOwner: (id: string) => Promise<string>, ownerId: string) {
  const flags = new Map<string, boolean>()
  for (const workspace of workspaces) flags.set(workspace.id, await workspaceOwner(workspace.id) === ownerId)
  return flags
}

async function removalIntent(discovery: LighthouseDiscovery, profile: LocalProfile, integrationId: string | undefined,
  reference: KeeperIntegrationReference | undefined, localOwners: Map<string, boolean>, trace?: RemovalOptions["trace"]) {
  const { getKeeperIntegrationStatus } = await import("./lighthousePairing")
  const status = await getKeeperIntegrationStatus(discovery)
  const ownerIds = new Set([...localOwners].filter(([, owned]) => owned).map(([id]) => id))
  const integration = findIntegration(status, ownerIds, integrationId)
  if (!integration) throw new Error("Rusty has no verified integration for this keeper identity.")
  traceRemoval(trace, "status-verified", { peerId: discovery.personId, recordId: integration.integrationId,
    outcome: `revision:${integration.revision};scopes:${integration.scopes.length}` })
  const localPending = reference?.pendingRemoval
  const servicePending = integration.pendingOperation
  const scopes = selectRemovalScopes(integration, localPending, localOwners)
  if (servicePending && (servicePending.scopes.length !== scopes.length || servicePending.scopes.some(scope =>
    !scopes.some(candidate => candidate.workspaceId === scope.workspaceId && candidate.expectedGrantEpoch === scope.expectedGrantEpoch)))) {
    throw new Error("Rusty has another pending operation for this integration. Retry or resolve it first.")
  }
  if (scopes.some(scope => scope.expectedGrantEpoch < 1)) throw new Error("Rusty status omitted an owner grant epoch.")
  return { integration, statusIntegrations: status.integrations, reference, localPending, servicePending, scopes,
    operationId: servicePending?.operationId ?? localPending?.operationId ?? crypto.randomUUID(),
    expectedRevision: servicePending?.expectedRevision ?? localPending?.expectedRevision ?? integration.revision }
}

async function localRemovalContext(personId: string, options: RemovalOptions, profile: LocalProfile) {
  const { integrations } = await keeperIntegrationReferences()
  const reference = keeperReferenceForPerson(integrations, personId)
  const legacyKeeper = (await ownerKeepers(profile.identity.personId)).find(item => item.personId === personId)
  const integrationId = reference?.integrationId ?? legacyKeeper?.details?.integrationId
  const discovery = resolveRemovalDiscovery(personId, reference, legacyKeeper, options)
  const mesh = await options.mesh()
  if (!mesh) throw new Error("Mesh unavailable")
  const localOwners = await localOwnerFlags(options.workspaces, options.workspaceOwner!, profile.identity.personId)
  const locallyRevoked = new Set<string>()
  traceRemoval(options.trace, "scopes-loaded", { peerId: personId, recordId: integrationId ?? "none",
    outcome: removalSource(reference, legacyKeeper),
    phase: `owned:${[...localOwners.values()].filter(Boolean).length};available:${localOwners.size}` })
  await revokeLocalScopes(mesh, personId, reference?.workspaceIds ?? legacyKeeper?.details?.boardIds ?? [], localOwners, locallyRevoked, options.trace)
  traceRemoval(options.trace, "local-context-ready", { peerId: personId, recordId: integrationId ?? "none",
    outcome: `locally-revoked:${locallyRevoked.size}` })
  return { reference, discovery, mesh, localOwners, locallyRevoked, integrationId }
}

async function revokeVisibleOwnedPeerScopes(mesh: DurableMesh, personId: string, localOwners: Map<string, boolean>,
  alreadyRevoked: Set<string>, trace?: RemovalOptions["trace"]) {
  const workspaceIds = [...new Set((await mesh.views()).filter(peer => peer.personId === personId && !peer.revokedAt
    && localOwners.get(peer.workspaceId) === true).map(peer => peer.workspaceId))]
  await revokeLocalScopes(mesh, personId, workspaceIds, localOwners, alreadyRevoked, trace)
  return workspaceIds
}

async function removalIntentWithLocalError(discovery: LighthouseDiscovery, profile: LocalProfile, integrationId: string | undefined,
  reference: KeeperIntegrationReference | undefined, localOwners: Map<string, boolean>, locallyRevoked: Set<string>, trace?: RemovalOptions["trace"]) {
  try {
    return await removalIntent(discovery, profile, integrationId, reference, localOwners, trace)
  } catch (error) {
    if (locallyRevoked.size) throw new Error("Local access was revoked; Rusty confirmation is still pending. Retry when Rusty is available.", { cause: error })
    throw error
  }
}

async function finishAlreadyRemoved(personId: string, profile: LocalProfile, reference: KeeperIntegrationReference | undefined,
  integration: KeeperIntegrationStatus, localPending: KeeperIntegrationReference["pendingRemoval"]): Promise<boolean> {
  if (!removalAlreadyCompleted(integration, reference, localPending)) return false
  try {
    await removeOwnerKeeper(profile.identity.personId, personId)
  } catch (error) {
    throw new Error("Rusty confirmed removal; local keeper cleanup is pending. Retry removal to finish.", { cause: error })
  }
  if (reference) await saveKeeperIntegrationReference({ ...reference, state: "removed", workspaceIds: [], scopeReceipts: [],
    revision: integration.revision, pendingRemoval: undefined, verifiedAt: new Date().toISOString() })
  return true
}

async function submitRemoval(personId: string, profile: LocalProfile, discovery: LighthouseDiscovery, intent: Awaited<ReturnType<typeof removalIntent>>,
  mesh: DurableMesh, localOwners: Map<string, boolean>, locallyRevoked: Set<string>, trace?: RemovalOptions["trace"]) {
  const { integration, scopes, operationId, expectedRevision, servicePending } = intent
  await revokeLocalScopes(mesh, personId, scopes.map(scope => scope.workspaceId), localOwners, locallyRevoked, trace)
  const descriptor: KeeperIntegrationReference = {
    integrationId: integration.integrationId,
    serviceOrigin: discovery.origin,
    servicePersonId: discovery.personId,
    serviceDeviceId: discovery.deviceId,
    servicePublicKey: discovery.publicKey,
    serviceCertificates: discovery.certificates as KeeperIntegrationReference["serviceCertificates"],
    workspaceIds: integration.scopes.map(scope => scope.workspaceId),
    scopeReceipts: integration.scopes.map(scope => ({ workspaceId: scope.workspaceId,
      grantEpoch: scope.grantEpoch, activationOperationId: scope.activationOperationId })),
    futureBoards: integration.futureBoards,
    futureBoardBaselineIds: intent.reference?.futureBoardBaselineIds,
    revision: integration.revision,
    state: "removing",
    verifiedAt: new Date().toISOString(),
    pendingRemoval: { operationId, expectedRevision, scopes },
  }
  await saveKeeperIntegrationReference(descriptor)
  traceRemoval(trace, "intent-saved", { peerId: personId, recordId: integration.integrationId, outcome: "pending-rusty-confirmation" })
  let receipt: KeeperDisconnectReceipt
  try {
    const { disconnectKeeperIntegration } = await import("./lighthousePairing")
    receipt = await disconnectKeeperIntegration(discovery, integration.integrationId, expectedRevision, operationId, scopes,
      servicePending?.requestHash)
  } catch (error) {
    throw new Error(`Removal pending Rusty confirmation: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  traceRemoval(trace, "receipt", { peerId: personId, recordId: integration.integrationId, outcome: receipt.status })
  if (receipt.status === "pending") return "pending" as const
  try {
    await persistRemovalReceipt(profile, personId, discovery, integration, receipt, descriptor)
    traceRemoval(trace, "receipt-persisted", { peerId: personId, recordId: integration.integrationId, outcome: receipt.status })
    return "removed" as const
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Rusty confirmed removal;")) throw error
    throw new Error("Rusty confirmed removal; local keeper cleanup is pending. Retry removal to finish.", { cause: error })
  }
}

export async function removeKeeperAccess(personId: string, options: RemovalOptions): Promise<"removed" | "pending"> {
  traceRemoval(options.trace, "start", { peerId: personId, outcome: "requested" })
  const profile = await options.getProfile()
  if (personId === profile.identity.personId) throw new Error("Cannot remove this identity")
  if (!options.workspaceOwner) throw new Error("Workspace ownership is unavailable")
  const { integrations } = await keeperIntegrationReferences()
  const reference = keeperReferenceForPerson(integrations, personId)
  const legacyKeeper = (await ownerKeepers(profile.identity.personId)).find(item => item.personId === personId)
  if (!reference && !legacyKeeper?.details?.integrationId) {
    const { beginLegacyLocalRemoval } = await import("./legacyKeeperRemoval")
    const result = await beginLegacyLocalRemoval(personId, profile, options, legacyKeeper)
    traceRemoval(options.trace, "complete", { peerId: personId, outcome: result })
    return result
  }
  traceRemoval(options.trace, "selection", { peerId: personId, recordId: reference?.integrationId ?? legacyKeeper?.details?.integrationId ?? "none",
    outcome: "selected" })
  const context = await localRemovalContext(personId, options, profile)
  const intent = await removalIntentWithLocalError(context.discovery, profile, context.integrationId,
    context.reference, context.localOwners, context.locallyRevoked, options.trace)
  const { integration, statusIntegrations, localPending, scopes } = intent
  if (!scopes.length) {
    const otherActiveOwnedIntegration = statusIntegrations.some(candidate => candidate.integrationId !== integration.integrationId
      && candidate.scopes.some(scope => context.localOwners.get(scope.workspaceId) === true))
    if (otherActiveOwnedIntegration) {
      throw new Error("Rusty has another active integration for this keeper. Remove that integration before retrying cleanup.")
    }
    await revokeVisibleOwnedPeerScopes(context.mesh, personId, context.localOwners, context.locallyRevoked, options.trace)
    if (await finishAlreadyRemoved(personId, profile, context.reference, integration, localPending)) {
      traceRemoval(options.trace, "complete", { peerId: personId, recordId: integration.integrationId, outcome: "already-removed" })
      return "removed"
    }
    throw new Error("Rusty has no active or pending removal for this identity.")
  }
  const result = await submitRemoval(personId, profile, context.discovery, intent,
    context.mesh, context.localOwners, context.locallyRevoked, options.trace)
  traceRemoval(options.trace, "complete", { peerId: personId, recordId: integration.integrationId, outcome: result })
  return result
}

export function createKeeperProvisioner(
  ensureDurableMesh: () => Promise<unknown>,
  hostContext: () => WorkspaceHostContext,
) {
  const invitationHosts = new Map<string, Promise<WorkspaceJoinInvitation>>()
  return async (pairing: KeeperPairing): Promise<KeeperPairingStatus> => {
    await ensureDurableMesh()
    let invitationTask = invitationHosts.get(pairing.pairingId)
    if (!invitationTask) {
      invitationTask = createKeeperWorkspaceHost(hostContext(), pairing.workspaces, pairing.discovery.personId, pairing.futureBoards === true)
      invitationHosts.set(pairing.pairingId, invitationTask)
      void invitationTask.catch(() => {
        if (invitationHosts.get(pairing.pairingId) === invitationTask) invitationHosts.delete(pairing.pairingId)
      })
    }
    const invitation = await invitationTask
    const { deliverKeeperInvitation, rememberActiveKeeperIntegration } = await import("./lighthousePairing")
    const status = await deliverKeeperInvitation(pairing, invitation)
    if (status === "active") await rememberActiveKeeperIntegration(pairing)
    return status
  }
}
