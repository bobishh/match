import { createApp } from "vue"
import App from "./App.vue"
import "./vendor/site-foundation.css"
import "./styles/design-system/tokens.css"
import "./styles/design-system/reset.css"
import "./styles/design-system/typography.css"
import "./styles/design-system/controls.css"
import "./styles/design-system/layout.css"
import "./styles/design-system/chrome.css"
import "./styles/design-system/icons.css"
import "../public/assets/primitive.css"
import "./style.css"

createApp(App).mount("#app")

void import("./vendor/berlin-tower.js").catch(() => {})
