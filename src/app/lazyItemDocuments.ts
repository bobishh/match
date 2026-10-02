import { defineAsyncComponent, defineComponent, h, type Component } from "vue"

const statusComponent = (failed: boolean) => defineComponent({
  inheritAttrs: false,
  render: () => h("section", { class: "detail-section documents-section" }, [
    h("p", { role: failed ? "alert" : "status" }, failed
      ? "Document controls could not load. Reload Match to retry."
      : "Loading document controls…"),
    ...(failed ? [h("button", { class: "button button-primary", type: "button", onClick: () => window.location.reload() }, "Reload Match")] : []),
  ]),
})

export const LazyItemDocuments = defineAsyncComponent<Component>({
  loader: () => import("../components/ItemDocuments.vue"),
  loadingComponent: statusComponent(false),
  errorComponent: statusComponent(true),
  delay: 0,
})
