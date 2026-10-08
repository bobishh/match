import { readLocal, writeLocal } from "../localDb"
import { bootstrapIdentity } from "../domain/identity"
import type { KeeperIntegrationReference, PersonalRootDocumentV1 } from "../domain/model"
import { defaultStorage } from "../storage"

export type KeeperDetails = {
  origin?: string
  boardIds: string[]
  futureBoards: boolean
  futureBoardBaselineIds?: string[]
  integrationId?: string
  servicePersonId?: string
  serviceDeviceId?: string
  serviceDeviceIds?: string[]
  servicePublicKey?: string
  serviceCertificates?: unknown[]
  revision?: number
  integrationSettingsSupported?: boolean
  removalPending?: boolean
  localRevocationComplete?: boolean
}
export type OwnerKeeper = { personId: string; role: "visitor" | "editor"; details?: KeeperDetails }
const key = (ownerPersonId: string) => `tincanban.owner-keepers.v1:${ownerPersonId}`

export async function ownerKeepers(ownerPersonId: string): Promise<OwnerKeeper[]> {
  const raw = await readLocal(key(ownerPersonId))
  if (!raw) return []
  let value: unknown
  try { value = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(value)) return []
  const records = value as OwnerKeeper[]
  return records.filter(record => !!record && typeof record.personId === "string" &&
    (record.role === "visitor" || record.role === "editor"))
}

/** Existing scopes need explicit selection; future consent covers only later-created scopes. */
export function mayOfferFutureKeeperWorkspace(details: KeeperDetails | undefined, workspaceId: string): boolean {
  return details?.futureBoards === true
    && Array.isArray(details.futureBoardBaselineIds)
    && !details.futureBoardBaselineIds.includes(workspaceId)
}

export async function saveOwnerKeeper(ownerPersonId: string, keeper: OwnerKeeper) {
  const records = await ownerKeepers(ownerPersonId)
  const previous = records.find(record => record.personId === keeper.personId)
  await writeLocal(key(ownerPersonId), JSON.stringify([
    ...records.filter(record => record.personId !== keeper.personId),
    { ...previous, ...keeper },
  ]))
}

export async function removeOwnerKeeper(ownerPersonId: string, personId: string) {
  const records = await ownerKeepers(ownerPersonId)
  await writeLocal(key(ownerPersonId), JSON.stringify(records.filter(record => record.personId !== personId)))
}

/** Reconcile locally saved settings after a verified durable activation receipt. */
export async function rememberActivatedKeeper(ownerPersonId: string, personId: string, details: KeeperDetails) {
  // Rusty integrations are provisioned only with the independent owner-signed
  // Editor grant; generic peer invitations continue to use their chosen role.
  await saveOwnerKeeper(ownerPersonId, { personId, role: "editor", details })
}

export async function keeperIntegrationReferences(root?: PersonalRootDocumentV1) {
  const profile = await bootstrapIdentity()
  const current = root ?? await defaultStorage.loadPersonalRoot()
  if (!current || current.identity.personId !== profile.identity.personId) throw new Error("Personal root does not belong to this identity.")
  return { root: current, integrations: current.keeperIntegrations ?? {} }
}

export async function saveKeeperIntegrationReference(reference: KeeperIntegrationReference) {
  const { root, integrations } = await keeperIntegrationReferences()
  if (!reference.integrationId || !reference.serviceOrigin || !reference.servicePersonId || !reference.serviceDeviceId
    || !Number.isSafeInteger(reference.revision) || reference.revision < 0) throw new Error("Keeper descriptor is invalid.")
  // References cross Vue component boundaries; serialize at this JSON persistence boundary to strip proxies.
  const serializable = JSON.parse(JSON.stringify(reference)) as KeeperIntegrationReference
  root.keeperIntegrations = { ...integrations, [reference.integrationId]: serializable }
  await defaultStorage.savePersonalRoot(root)
}

function withdrawalKey(pairingId: string, operationId: string) {
  return `${encodeURIComponent(pairingId)}.${encodeURIComponent(operationId)}`
}

export type PendingKeeperWithdrawal = {
  pairingId: string
  operationId: string
  pairing: Record<string, unknown>
  grantScopes?: Array<{ workspaceId: string; document: string; authorizationBundle: unknown; grant: unknown }>
  orphanResolution?: { verifiedAt: string; serviceRevision: number; integrationRevision: number;
    signedStatus: { payload: Record<string, unknown>; signerKeyId: string; signature: string };
    localRevocationScopes: Array<{ workspaceId: string; document: string; authorizationBundle: unknown }> }
}

export async function pendingKeeperWithdrawal(pairingId: string, operationId: string): Promise<PendingKeeperWithdrawal | undefined> {
  const { root } = await keeperIntegrationReferences()
  return root.pendingKeeperWithdrawals?.[withdrawalKey(pairingId, operationId)] as PendingKeeperWithdrawal | undefined
}

export async function pendingKeeperWithdrawals(): Promise<PendingKeeperWithdrawal[]> {
  const { root } = await keeperIntegrationReferences()
  return Object.values(root.pendingKeeperWithdrawals ?? {}) as PendingKeeperWithdrawal[]
}

export async function saveKeeperOrphanResolution(pairingId: string, operationId: string,
  resolution: NonNullable<PendingKeeperWithdrawal["orphanResolution"]>) {
  const { root } = await keeperIntegrationReferences()
  const key = withdrawalKey(pairingId, operationId)
  const previous = root.pendingKeeperWithdrawals?.[key] as PendingKeeperWithdrawal | undefined
  if (!previous) throw new Error("Keeper cancellation history was not saved; verified status remains available for retry.")
  const saved = JSON.parse(JSON.stringify({ ...previous, orphanResolution: resolution })) as PendingKeeperWithdrawal
  root.pendingKeeperWithdrawals = { ...root.pendingKeeperWithdrawals, [key]: saved }
  await defaultStorage.savePersonalRoot(root)
  return saved
}

export async function savePendingKeeperWithdrawal(pairingId: string, operationId: string, pairing: Record<string, unknown>,
  grantScopes?: Array<{ workspaceId: string; document: string; authorizationBundle: unknown; grant: unknown }>): Promise<PendingKeeperWithdrawal> {
  const { root } = await keeperIntegrationReferences()
  const key = withdrawalKey(pairingId, operationId)
  const previous = root.pendingKeeperWithdrawals?.[key]
  if (previous) return previous as PendingKeeperWithdrawal
  const serializable = JSON.parse(JSON.stringify({ pairingId, operationId, pairing, grantScopes })) as PendingKeeperWithdrawal
  root.pendingKeeperWithdrawals = { ...root.pendingKeeperWithdrawals,
    [key]: serializable }
  await defaultStorage.savePersonalRoot(root)
  return serializable
}

export async function savePendingKeeperWithdrawalProofs(pairingId: string, operationId: string,
  grantScopes: Array<{ workspaceId: string; document: string; authorizationBundle: unknown; grant: unknown }>) {
  const { root } = await keeperIntegrationReferences()
  const key = withdrawalKey(pairingId, operationId)
  const previous = root.pendingKeeperWithdrawals?.[key] as PendingKeeperWithdrawal | undefined
  if (!previous) throw new Error("Keeper cancellation intent was not saved. Retry cancellation.")
  if (previous.grantScopes) return previous
  const updated = JSON.parse(JSON.stringify({ ...previous, grantScopes })) as PendingKeeperWithdrawal
  root.pendingKeeperWithdrawals = { ...root.pendingKeeperWithdrawals, [key]: updated }
  await defaultStorage.savePersonalRoot(root)
  return updated
}

export async function clearPendingKeeperWithdrawalProofs(pairingId: string, operationId: string) {
  const { root } = await keeperIntegrationReferences()
  const key = withdrawalKey(pairingId, operationId)
  if (!root.pendingKeeperWithdrawals?.[key]) return
  const remaining = { ...root.pendingKeeperWithdrawals }
  delete remaining[key]
  root.pendingKeeperWithdrawals = remaining
  await defaultStorage.savePersonalRoot(root)
}
