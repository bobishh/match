import { defineAsyncComponent, h, type Component } from "vue"

const pendingStatus = (message: string): Component => ({
  setup: () => () => h("div", { role: "status", "aria-live": "polite" }, message),
})

export const IdentityRecoveryDialog = defineAsyncComponent<Component>(() => import("../components/IdentityRecoveryDialog.vue"))
export const IdentitySettingsPanel = defineAsyncComponent<Component>(() => import("../components/IdentitySettingsPanel.vue"))
export const ItemDetailDialog = defineAsyncComponent<Component>({
  loader: () => import("../components/ItemDetailDialog.vue"),
  delay: 0,
  loadingComponent: pendingStatus("Opening item…"),
})
export const SpatialWindow = defineAsyncComponent<Component>({
  loader: () => import("../components/SpatialWindow.vue"),
  delay: 0,
  loadingComponent: pendingStatus("Opening details…"),
})
export const WorkspacesDialog = defineAsyncComponent<Component>(() => import("../components/WorkspacesDialog.vue"))
export const ColumnDialog = defineAsyncComponent<Component>(() => import("../components/ColumnDialog.vue"))
export const WorkspaceFileActions = defineAsyncComponent<Component>(() => import("../components/WorkspaceFileActions.vue"))
export const SchemaEditorDialog = defineAsyncComponent<Component>(() => import("../components/SchemaEditorDialog.vue"))
export const MoveItemDialog = defineAsyncComponent<Component>(() => import("../components/MoveItemDialog.vue"))
export const WorkspaceParticipants = defineAsyncComponent<Component>(() => import("../components/WorkspaceParticipants.vue"))
