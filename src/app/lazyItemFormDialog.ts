import { defineAsyncComponent, type Component } from "vue"
import LazyDialogFailure from "../components/LazyDialogFailure.vue"

export const ItemFormDialog = defineAsyncComponent({
  loader: () => import("../components/ItemFormDialog.vue") as Promise<{ default: Component }>,
  errorComponent: LazyDialogFailure as Component,
  delay: 0,
})
