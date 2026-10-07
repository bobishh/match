import type { LocalProfile } from "../domain/identity"
import { removeOwnerKeeper, saveOwnerKeeper } from "./ownerKeeper"
import type { OwnerKeeper } from "./ownerKeeper"
import type { DurableMesh } from "./durableMesh"

type LegacyRemovalOptions = {
  workspaces: { id: string }[]
  workspaceOwner?: (id: string) => Promise<string>
  mesh: () => Promise<DurableMesh | undefined>
  knownServiceDeviceIds?: string[]
}

export async function beginLegacyLocalRemoval(personId: string, profile: LocalProfile, options: LegacyRemovalOptions,
  keeper: OwnerKeeper | undefined): Promise<"removed"> {
  if (!keeper && !options.knownServiceDeviceIds?.length) throw new Error("Keeper identity is unavailable. Local access was not changed.")
  const details = keeper?.details ?? { boardIds: [], futureBoards: false }
  const boardIds = details.boardIds?.length ? details.boardIds : options.workspaces.map(workspace => workspace.id)
  const ownerIds = await ownedLegacyRemovalScopes(boardIds, options.workspaceOwner, profile.identity.personId)
  const record: OwnerKeeper = keeper ?? { personId, role: "visitor" }
  const pendingDetails = { ...details, boardIds, futureBoards: false, removalPending: true }
  const mesh = await options.mesh()
  if (!mesh) throw new Error("Mesh unavailable")

  const serviceDeviceIds = [...new Set([...(details.serviceDeviceIds ?? []), ...(options.knownServiceDeviceIds ?? [])])]
  await saveOwnerKeeper(profile.identity.personId, {
    ...record,
    details: { ...pendingDetails, localRevocationComplete: false, serviceDeviceIds },
  })
  for (const workspaceId of ownerIds) await mesh.revokePerson(workspaceId, personId)
  await removeOwnerKeeper(profile.identity.personId, personId)
  return "removed"
}

async function ownedLegacyRemovalScopes(workspaceIds: string[], workspaceOwner: LegacyRemovalOptions["workspaceOwner"], ownerId: string) {
  if (!Array.isArray(workspaceIds) || !workspaceIds.length || workspaceIds.length > 512
    || workspaceIds.some(id => typeof id !== "string" || !id.trim())) {
    throw new Error("This legacy keeper has no saved board list. Local access was not changed.")
  }
  if (!workspaceOwner) throw new Error("Workspace ownership is unavailable")
  const ownerIds: string[] = []
  for (const workspaceId of new Set(workspaceIds)) {
    if (await workspaceOwner(workspaceId) === ownerId) ownerIds.push(workspaceId)
  }
  if (!ownerIds.length) throw new Error("No saved keeper board is still owned by this identity.")
  return ownerIds
}
