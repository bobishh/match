import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import { execFileSync } from "node:child_process"

function buildCommit() {
  try {
    const commit = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { encoding: "utf8" }).trim()
    return /^[0-9a-f]{40}$/i.test(commit) ? commit : "unknown"
  } catch {
    return "unknown"
  }
}

export default defineConfig(({ command }) => ({
  define: {
    __MATCH_BUILD_COMMIT__: JSON.stringify(command === "build" ? buildCommit() : "dev"),
  },
  plugins: [
    vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === "berlin-tower" } } }),
    {
      name: "agent-route",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === "/agent" || req.url === "/agent/") {
            res.writeHead(302, { Location: "/agent/index.html" })
            res.end()
            return
          }
          next()
        })

      },
    },
  ],
}))
