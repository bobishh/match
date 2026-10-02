import { defineAsyncComponent, defineComponent, h, type Component } from "vue"
import ModalLayer from "../components/ModalLayer.vue"

export function createLazySyncDialog(dismiss: () => unknown): Component {
  const component = (failed: boolean) => defineComponent({
    inheritAttrs: false,
    render: () => h(ModalLayer, { class: "overlay", onClose: dismiss }, { default: () => [
      h("section", { class: "dialog sync-dialog-pending", role: "dialog", "aria-modal": "true", "aria-label": "Device sync" }, [
        h("div", { class: "dialog-head" }, [h("h2", "Device sync"),
          h("button", { class: "icon-button", type: "button", "aria-label": "Close", onClick: dismiss }, "×")]),
        h("p", { role: failed ? "alert" : "status" }, failed ? "Sync controls could not load. Reload Match to retry." : "Loading sync controls…"),
        ...(failed ? [h("button", { class: "button button-primary", type: "button", onClick: () => window.location.reload() }, "Reload Match")] : []),
      ]),
    ] }),
  })
  return defineAsyncComponent<Component>({
    loader: () => import("../components/SyncDialog.vue"),
    loadingComponent: component(false),
    errorComponent: component(true),
    delay: 0,
  })
}
