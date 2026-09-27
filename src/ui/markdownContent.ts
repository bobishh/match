import { defineAsyncComponent } from "vue"

export const MarkdownContent = defineAsyncComponent(() => import("../components/MarkdownContent.vue"))
