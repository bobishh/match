import * as Automerge from "@automerge/automerge"
import { chromium } from "@playwright/test"

const endpoint = process.argv[2]
if (!endpoint) throw new Error("Pass the native endpoint ID")
const port = Number(process.env.MATCH_E2E_PORT ?? 4244)
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(90_000)
  await page.goto(`http://127.0.0.1:${port}/`)
  const source = Automerge.save(Automerge.from({ browser: "from-wasm" }))
  const result = await page.evaluate(async ({ remote, bytes }) => {
    const { startIrohBrowserNode } = await import("/src/iroh.ts")
    const { meshRustRuntime } = await import("/vendor/meta-mesh/packages/mesh-replication/src/runtime.ts")
    const node = await startIrohBrowserNode()
    const engine = meshRustRuntime().createAutomergeSyncEngine(node.endpointId)
    engine.loadDocument("browser-native-e2e", "document", Uint8Array.from(bytes))
    try {
      const connection = await node.dialRelay(remote)
      const rpc = async request => {
        const stream = await connection.openStream()
        await stream.send(new TextEncoder().encode(JSON.stringify(request)))
        await stream.closeSend()
        const response = JSON.parse(new TextDecoder().decode(await stream.read()))
        if (response.error) throw new Error(response.error)
        return response
      }
      let frame = engine.generate("document", remote, true, null)
      if (!frame) throw new Error("Missing initial sync frame")
      // Transport endpoint must match the claimed Automerge device.
      const forged = { ...frame, fromDeviceId: "forged-device", message: Array.from(frame.message) }
      const forgedReply = await rpc({ kind: "sync", frame: forged }).then(
        () => "accepted",
        error => String(error.message),
      )
      if (forgedReply !== "Invalid Automerge sync frame") throw new Error(`Forged frame: ${forgedReply}`)
      let converged = false
      for (let round = 0; round < 16; round += 1) {
        const response = await rpc({ kind: "sync", frame: { ...frame, message: Array.from(frame.message) } })
        const next = response.response
          ? engine.receive(remote, { ...response.response, message: Uint8Array.from(response.response.message) }, true, null).response
          : engine.generate("document", remote, true, null)
        if (!next) { converged = true; break }
        frame = next
      }
      if (!converged) throw new Error("Automerge sync did not converge")
      const native = await rpc({ kind: "read" })
      await connection.close()
      return { browser: Array.from(engine.saveDocument("document")), native: native.document }
    } finally {
      await node.close("probe complete")
    }
  }, { remote: endpoint, bytes: Array.from(source) })
  for (const [side, bytes] of Object.entries(result)) {
    const doc = Automerge.load(Uint8Array.from(bytes))
    if (String(doc.browser) !== "from-wasm" || String(doc.native) !== "from-rust") {
      throw new Error(`${side} did not converge: ${JSON.stringify(doc)}`)
    }
  }
  console.log("Browser/native Rust Automerge sync converged; forged device rejected")
} finally {
  await browser.close()
}
