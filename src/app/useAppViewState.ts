import { computed } from "vue"
import type { useAppController } from "./useAppController"
import { useDelayedFlag } from "../ui/useDelayedFlag"
import { createLazySyncDialog } from "./syncDialogStatus"

export function useAppViewState(app: ReturnType<typeof useAppController>) {
  const { activeWorkspace, ready } = app.workspace
  const { sync } = app.collaboration.device
  const { confirmedRole, workspaceRoleStatus } = app.collaboration.permissions
  return {
    SyncDialog: createLazySyncDialog(sync.dismiss),
    reviewCausalChange: (hash: string) => app.workspace.reviewCausalChange(hash),
    chatCanView: computed(() => confirmedRole.value !== null && !sync.isWorkspaceAccessRevoked(activeWorkspace.id)),
    uiReady: computed(() => ready.value && workspaceRoleStatus.value !== "loading"),
    showAccessLoading: useDelayedFlag(() => ready.value && workspaceRoleStatus.value === "loading"),
  }
}
