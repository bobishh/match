import type { WorkspaceRole } from "../domain/permissions"

export type WorkspaceAccessResult = { role: WorkspaceRole; blocked: boolean; error?: string }
export type WorkspaceAccessState = { access: Record<string, WorkspaceAccessResult>; errors: string[] }

export function mergeWorkspaceAccessState(
  current: Record<string, WorkspaceAccessResult>,
  incoming: Record<string, WorkspaceAccessResult>,
  workspaceIds: string[],
  activeWorkspaceId: string,
  activeResultFresh: boolean,
): WorkspaceAccessState {
  const next = Object.fromEntries(Object.entries(current).filter(([id]) => workspaceIds.includes(id)))
  const verified = activeResultFresh
    ? incoming
    : Object.fromEntries(Object.entries(incoming).filter(([id]) => id !== activeWorkspaceId))
  const access = { ...next, ...verified }
  return { access, errors: Object.values(access).flatMap(result => result.error ? [result.error] : []) }
}
