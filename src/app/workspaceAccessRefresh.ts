import type { WorkspaceRole } from "../domain/permissions"
import { mergeWorkspaceAccessState, type WorkspaceAccessResult, type WorkspaceAccessState } from "./workspaceAccessState"

type Ref<T> = { value: T }
type LoadedWorkspaceAccess = { role: WorkspaceRole; ownerId: string; access: Record<string, WorkspaceAccessResult> }

export async function refreshWorkspaceAccess(options: {
  workspaceId: string
  includeOthers: boolean
  cancelled: () => boolean
  getActiveWorkspaceId: () => string
  getDocVersion: () => number
  getWorkspaceIds: () => string[]
  load: (includeOthers: boolean, onActive: (result: LoadedWorkspaceAccess) => void) => Promise<LoadedWorkspaceAccess>
  state: {
    currentRole: Ref<WorkspaceRole>
    currentWorkspaceOwnerId: Ref<string>
    roleWorkspaceId: Ref<string>
    workspaceAccess: Ref<Record<string, WorkspaceAccessResult>>
    workspaceAccessErrors: Ref<string[]>
  }
}): Promise<void> {
  const version = options.getDocVersion()
  const commit = (result: LoadedWorkspaceAccess) => {
    if (options.cancelled() || options.getActiveWorkspaceId() !== options.workspaceId) return
    const activeResultFresh = options.getDocVersion() === version
    if (activeResultFresh) {
      options.state.currentRole.value = result.role
      options.state.currentWorkspaceOwnerId.value = result.ownerId
      options.state.roleWorkspaceId.value = options.workspaceId
    }
    const state: WorkspaceAccessState = mergeWorkspaceAccessState(options.state.workspaceAccess.value, result.access,
      options.getWorkspaceIds(), options.workspaceId, activeResultFresh)
    options.state.workspaceAccess.value = state.access
    options.state.workspaceAccessErrors.value = state.errors
  }
  const result = await options.load(options.includeOthers, active => {
    if (options.getDocVersion() === version) commit(active)
  })
  commit(result)
}
