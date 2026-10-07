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
