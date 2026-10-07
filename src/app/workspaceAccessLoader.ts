import { bootstrapIdentity } from "../domain/identity"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { WorkspaceRole } from "../domain/permissions"
import { effectiveWorkspaceOwner, workspaceRole, workspaceWritesBlocked } from "../sync/changeAuthorization"
import type { useTincanban } from "../state"
import type { useDeviceSync } from "../sync/useDeviceSync"
import type { WorkspaceAccessResult } from "./workspaceAccessState"

type ActiveAccess = { role: WorkspaceRole; ownerId: string; access: Record<string, WorkspaceAccessResult> }

export async function loadWorkspaceAccess(tincanban: ReturnType<typeof useTincanban>, doc: WorkspaceDocumentV2,
  sync: ReturnType<typeof useDeviceSync>, includeOthers = true, onActive?: (result: ActiveAccess) => void): Promise<ActiveAccess> {
  const profile = await bootstrapIdentity("My Device")
  const resolve = async (item: { id: string; title: string }) => {
    try {
      let role: WorkspaceRole
      if (item.id === doc.id) {
        role = await workspaceRole(doc, profile).catch(async cause => {
          const { repairOwnerRevocationBoundary } = await import("../sync/ownerRevocationBoundaryRepair")
          await repairOwnerRevocationBoundary(cause, doc, profile, personId => sync.revokePeer(personId))
          return workspaceRole(doc, profile)
        })
      } else role = await tincanban.getWorkspaceRole(item.id)
      return [item.id, { role, blocked: await workspaceWritesBlocked(item.id) }] as const
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      const error = `“${item.title}” (${item.id}): permissions could not be verified. ${detail}`
      return [item.id, { role: "visitor" as const, blocked: true, error }] as const
    }
  }
  const items = tincanban.availableWorkspaces.value
  const activeItem = items.find(item => item.id === doc.id) ?? { id: doc.id, title: doc.title }
  const [activeId, activeRaw] = await resolve(activeItem)
  const active: WorkspaceAccessResult = activeRaw
  const ownerId = active?.error ? "" : await effectiveWorkspaceOwner(doc.id, doc.ownerPersonId)
  const initial = { role: active.role, ownerId, access: { [activeId]: active } }
  onActive?.(initial)
  const others = includeOthers ? await Promise.all(items.filter(item => item.id !== doc.id).map(resolve)) : []
  const access: Record<string, WorkspaceAccessResult> = Object.fromEntries([[activeId, active], ...others])
  return { ...initial, access }
}
