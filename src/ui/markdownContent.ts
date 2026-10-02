import { defineAsyncComponent, h } from "vue"

const PlainText = (props: { source: string }) => h("div", { style: { whiteSpace: "pre-wrap" } }, props.source)

export const MarkdownContent = defineAsyncComponent({
  loader: () => import("../components/MarkdownContent.vue"),
  loadingComponent: PlainText,
  errorComponent: PlainText,
  delay: 0,
})
