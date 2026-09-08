import type { SyncTransport } from "./transport"

export const irohTransport: SyncTransport = {
  async start() {
    const { startIrohBrowserNode } = await import("../iroh")
    return startIrohBrowserNode()
  },
}
