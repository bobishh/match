import { computed } from "vue"
import type { useAppController } from "./useAppController"
import { useDelayedFlag } from "../ui/useDelayedFlag"
import { createLazySyncDialog } from "./syncDialogStatus"

export function useAppViewState(app: ReturnType<typeof useAppController>) {
  const { activeWorkspace, ready } = app.workspace
  const { sync, chat } = app.collaboration.device
  const { confirmedRole, currentWorkspaceOwnerId, workspaceRoleStatus } = app.collaboration.permissions
  return {
    SyncDialog: createLazySyncDialog(sync.dismiss),
    reviewCausalChange: (hash: string) => app.workspace.reviewCausalChange(hash),
    chatCanView: computed(() => confirmedRole.value !== null && !sync.isWorkspaceAccessRevoked(activeWorkspace.id)),
    activeOwnerLabel: computed(() => currentWorkspaceOwnerId.value === chat.personId.value
      ? (chat.displayName.value || "You")
      : chat.members.value.find(member => member.personId === currentWorkspaceOwnerId.value)?.name ?? `Participant · ${currentWorkspaceOwnerId.value.slice(0, 6)}`),
    uiReady: computed(() => ready.value && workspaceRoleStatus.value !== "loading"),
    showAccessLoading: useDelayedFlag(() => ready.value && workspaceRoleStatus.value === "loading"),
  }
}
