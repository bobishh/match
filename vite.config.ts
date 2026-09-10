import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"

export default defineConfig({
  plugins: [
    vue(),
    {
      name: "sync-signaling-bridge",
      configureServer(server) {
        const bus = new Map<string, any[]>()
        server.middlewares.use((req, res, next) => {
          if (req.url === "/agent" || req.url === "/agent/") {
            res.writeHead(302, { Location: "/agent/index.html" })
            res.end()
            return
          }
          next()
        })
        server.middlewares.use("/api/sync-signal", (req, res) => {
          const url = new URL(req.url || "", "http://127.0.0.1")
          const topic = url.searchParams.get("topic") || "default"

          if (req.method === "POST") {
            let body = ""
            req.on("data", (chunk) => { body += chunk })
            req.on("end", () => {
              try {
                const msg = JSON.parse(body)
                const list = bus.get(topic) || []
                list.push(msg)
                bus.set(topic, list)
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify({ ok: true }))
              } catch {
                res.writeHead(400).end()
              }
            })
          } else if (req.method === "GET") {
            const list = bus.get(topic) || []
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify(list))
          } else {
            res.writeHead(405).end()
          }
        })
      },
    },
  ],
})
