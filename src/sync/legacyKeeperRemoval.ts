import type { LocalProfile } from "../domain/identity"
import { removeOwnerKeeper, saveOwnerKeeper } from "./ownerKeeper"
import type { OwnerKeeper } from "./ownerKeeper"
import type { DurableMesh } from "./durableMesh"

type LegacyRemovalOptions = {
  workspaces: { id: string }[]
  workspaceOwner?: (id: string) => Promise<string>
  mesh: () => Promise<DurableMesh | undefined>
  knownServiceDeviceIds?: string[]
  trace?: (event: string, detail: Record<string, unknown>) => void
}

function traceRemoval(options: LegacyRemovalOptions, event: string, detail: Record<string, unknown>) {
  options.trace?.(event, detail)
}

function legacyScopeSource(keeper: OwnerKeeper | undefined) {
  return keeper?.details?.boardIds?.length ? "saved" : "current-workspaces"
}

function traceLegacyOwner(options: LegacyRemovalOptions, personId: string, workspaceId: string, owned: boolean) {
  traceRemoval(options, "scope-owner", { peerId: personId, workspaceId, outcome: owned ? "owner" : "other" })
}

export async function beginLegacyLocalRemoval(personId: string, profile: LocalProfile, options: LegacyRemovalOptions,
  keeper: OwnerKeeper | undefined): Promise<"removed"> {
    assertLegacyRemovalAvailable(keeper, options.knownServiceDeviceIds)
    const details = keeper?.details ?? { boardIds: [], futureBoards: false }
    const boardIds = details.boardIds?.length ? details.boardIds : options.workspaces.map(workspace => workspace.id)
    traceRemoval(options, "scopes-loaded", { peerId: personId, outcome: legacyScopeSource(keeper),
      phase: `saved:${keeper?.details?.boardIds?.length ?? 0};current:${options.workspaces.length}` })
    const ownerIds = await ownedLegacyRemovalScopes(boardIds, options.workspaceOwner, profile.identity.personId,
      (workspaceId, owned) => traceLegacyOwner(options, personId, workspaceId, owned))
    traceRemoval(options, "scopes-selected", { peerId: personId, outcome: `count:${ownerIds.length}` })
    const record: OwnerKeeper = keeper ?? { personId, role: "visitor" }
    const pendingDetails = { ...details, boardIds, futureBoards: false, removalPending: true }
    const mesh = await options.mesh()
    if (!mesh) throw new Error("Mesh unavailable")

    const serviceDeviceIds = [...new Set([...(details.serviceDeviceIds ?? []), ...(options.knownServiceDeviceIds ?? [])])]
    await saveOwnerKeeper(profile.identity.personId, {
      ...record,
      details: { ...pendingDetails, localRevocationComplete: false, serviceDeviceIds },
    })
    traceRemoval(options, "intent-saved", { peerId: personId, outcome: "pending-local-revocation" })
    for (const workspaceId of ownerIds) {
      traceRemoval(options, "revoke-start", { peerId: personId, workspaceId, outcome: "requested" })
      await mesh.revokePerson(workspaceId, personId)
      traceRemoval(options, "revoke-complete", { peerId: personId, workspaceId, outcome: "success" })
    }
    await removeOwnerKeeper(profile.identity.personId, personId)
    traceRemoval(options, "record-removed", { peerId: personId, outcome: "local-complete" })
    return "removed"
}

function assertLegacyRemovalAvailable(keeper: OwnerKeeper | undefined, knownServiceDeviceIds: string[] | undefined) {
  if (!keeper && !knownServiceDeviceIds?.length) throw new Error("Keeper identity is unavailable. Local access was not changed.")
}

async function ownedLegacyRemovalScopes(workspaceIds: string[], workspaceOwner: LegacyRemovalOptions["workspaceOwner"], ownerId: string,
  trace?: (workspaceId: string, owned: boolean) => void) {
  if (!Array.isArray(workspaceIds) || !workspaceIds.length || workspaceIds.length > 512
    || workspaceIds.some(id => typeof id !== "string" || !id.trim())) {
    throw new Error("This keeper has no saved board list. Local access was not changed.")
  }
  if (!workspaceOwner) throw new Error("Workspace ownership is unavailable")
  const ownerIds: string[] = []
  for (const workspaceId of new Set(workspaceIds)) {
    const owned = await workspaceOwner(workspaceId) === ownerId
    trace?.(workspaceId, owned)
    if (owned) ownerIds.push(workspaceId)
  }
  if (!ownerIds.length) throw new Error("No saved keeper board is still owned by this identity.")
  return ownerIds
}
