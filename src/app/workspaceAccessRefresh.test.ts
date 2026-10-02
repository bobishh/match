import { expect, it } from "vitest"
import { refreshWorkspaceAccess } from "./workspaceAccessRefresh"
import type { WorkspaceAccessResult } from "./workspaceAccessState"
import type { WorkspaceRole } from "../domain/permissions"

it("keeps active role and exposed errors after delayed full check finishes", async () => {
  const state = {
    currentRole: { value: "owner" as WorkspaceRole },
    currentWorkspaceOwnerId: { value: "owner-person" },
    roleWorkspaceId: { value: "active" },
    workspaceAccess: { value: { active: { role: "owner" as const, blocked: false } } as Record<string, WorkspaceAccessResult> },
    workspaceAccessErrors: { value: [] as string[] },
  }
  let version = 1
  let resolveFull!: () => void
  const fullGate = new Promise<void>(resolve => { resolveFull = resolve })
  const fullRefresh = refreshWorkspaceAccess({
    workspaceId: "active", includeOthers: true, cancelled: () => false,
    getActiveWorkspaceId: () => "active", getDocVersion: () => version,
    getWorkspaceIds: () => ["active", "inactive"], state,
    load: async (_includeOthers, onActive) => {
      const oldActive = { role: "owner" as const, ownerId: "owner-person", access: { active: { role: "owner" as const, blocked: false } } }
      onActive(oldActive)
      await fullGate
      const inactiveFailure = { role: "visitor" as const, blocked: true, error: "inactive permissions unavailable" }
      return { ...oldActive, access: { ...oldActive.access, inactive: inactiveFailure } }
    },
  })

  version++
  await refreshWorkspaceAccess({
    workspaceId: "active", includeOthers: false, cancelled: () => false,
    getActiveWorkspaceId: () => "active", getDocVersion: () => version,
    getWorkspaceIds: () => ["active", "inactive"], state,
    load: async (_includeOthers, onActive) => {
      const failedActive = { role: "visitor" as const, blocked: true, error: "active permissions unavailable" }
      const result = { role: "visitor" as const, ownerId: "", access: { active: failedActive } }
      onActive(result)
      return result
    },
  })
  resolveFull()
  await fullRefresh

  expect(state.currentRole.value).toBe("visitor")
  expect(state.workspaceAccess.value.active.error).toBe("active permissions unavailable")
  expect(state.workspaceAccessErrors.value).toEqual([
    "active permissions unavailable",
    "inactive permissions unavailable",
  ])
})
