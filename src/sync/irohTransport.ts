import type { SyncTransport } from "./transport"

export const irohTransport: SyncTransport = {
  async start(secret?: Uint8Array) {
    const { startIrohBrowserNode } = await import("../iroh")
    return startIrohBrowserNode(secret)
  },
}
