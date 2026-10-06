import { createApp } from "vue"
import App from "./App.vue"
import LighthouseLogin from "./components/LighthouseLogin.vue"
import "./styles/design-system/index.css"
import "./style.css"

const page = window.location.pathname === "/login" ? LighthouseLogin : App
createApp(page).mount("#app")

void import("./vendor/berlin-tower.js").catch(() => {})
