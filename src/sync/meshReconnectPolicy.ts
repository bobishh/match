import type { SyncConnection, SyncNode } from "./transport"
import { isNetworkFailure } from "./workspaceSet"

export class MeshReconnectPolicy {
  private readonly relayUntil = new Map<string, number>()
  private readonly now: () => number
  private readonly relayCooldownMs: number
  private readonly fallbackDelayMs: number

  constructor(options: { now?: () => number; relayCooldownMs?: number; fallbackDelayMs?: number } = {}) {
    this.now = options.now ?? Date.now
    this.relayCooldownMs = options.relayCooldownMs ?? 60_000
    this.fallbackDelayMs = options.fallbackDelayMs ?? 1_500
  }

  recordFailure(peerKey: string, error: unknown) {
    if (isNetworkFailure(error)) this.relayUntil.set(peerKey, this.now() + this.relayCooldownMs)
  }

  mode(node: SyncNode, peerKey: string): "direct" | "relay" {
    const until = this.relayUntil.get(peerKey) ?? 0
    if (until <= this.now()) this.relayUntil.delete(peerKey)
    return until > this.now() && node.dialRelay ? "relay" : "direct"
  }

  async dial(node: SyncNode, peerKey: string, endpoint: string): Promise<SyncConnection> {
    if (this.mode(node, peerKey) === "relay") return node.dialRelay!(endpoint)
    if (!node.dialRelay) return node.dial(endpoint)

    type Result = { mode: "direct" | "relay"; connection: SyncConnection }
    const direct = node.dial(endpoint).then(connection => ({ mode: "direct", connection }) as Result)
    let timer: ReturnType<typeof setTimeout> | undefined
    let relayStarted = false
    let startRelay!: () => void
    const relay = new Promise<Result>((resolve, reject) => {
      startRelay = () => {
        if (relayStarted) return
        relayStarted = true
        clearTimeout(timer)
        node.dialRelay!(endpoint).then(connection => resolve({ mode: "relay", connection }), reject)
      }
      timer = setTimeout(startRelay, this.fallbackDelayMs)
    })
    void direct.catch(startRelay)
    const winner = await Promise.any([direct, relay])
    clearTimeout(timer)
    if (winner.mode === "direct") this.relayUntil.delete(peerKey)
    else this.relayUntil.set(peerKey, this.now() + this.relayCooldownMs)
    void direct.then(result => { if (result.connection !== winner.connection) void result.connection.close() }).catch(() => {})
    void relay.then(result => { if (result.connection !== winner.connection) void result.connection.close() }).catch(() => {})
    return winner.connection
  }
}
