import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { BrowserNode, initSync } from "./iroh-runtime/match_iroh.js"
import { startIrohBrowserNode } from "./iroh"

// Ensure WASM is initialized for Node environment
const wasmPath = resolve(__dirname, "./iroh-runtime/match_iroh_bg.wasm")
const wasmBytes = readFileSync(wasmPath)
initSync({ module: wasmBytes })

describe("Iroh persistent node secret support", () => {
  it("maintains no-arg compatibility and generates a valid endpointId", async () => {
    const node = await startIrohBrowserNode()
    try {
      expect(node.endpointId).toBeDefined()
      expect(node.endpointId.length).toBe(64) // hex-encoded 32-byte public key
    } finally {
      await node.close()
    }
  })

  it("produces deterministic endpointId for the same 32-byte secret", async () => {
    const secret = new Uint8Array(32)
    secret.fill(42)

    const node1 = await startIrohBrowserNode(secret)
    const endpoint1 = node1.endpointId
    await node1.close()

    const node2 = await startIrohBrowserNode(secret)
    const endpoint2 = node2.endpointId
    await node2.close()

    expect(endpoint1).toBe(endpoint2)
  })

  it("produces different endpointIds for different secrets", async () => {
    const secret1 = new Uint8Array(32)
    secret1.fill(1)

    const secret2 = new Uint8Array(32)
    secret2.fill(2)

    const node1 = await startIrohBrowserNode(secret1)
    const endpoint1 = node1.endpointId
    await node1.close()

    const node2 = await startIrohBrowserNode(secret2)
    const endpoint2 = node2.endpointId
    await node2.close()

    expect(endpoint1).not.toBe(endpoint2)
  })

  it("rejects caller-provided secrets with invalid byte length", async () => {
    const shortSecret = new Uint8Array(16)
    const longSecret = new Uint8Array(33)
    const emptySecret = new Uint8Array(0)

    await expect(startIrohBrowserNode(shortSecret)).rejects.toThrow(/32 bytes/)
    await expect(startIrohBrowserNode(longSecret)).rejects.toThrow(/32 bytes/)
    await expect(startIrohBrowserNode(emptySecret)).rejects.toThrow(/32 bytes/)

    await expect(BrowserNode.start(shortSecret)).rejects.toThrow(/32 bytes/)
    await expect(BrowserNode.start(longSecret)).rejects.toThrow(/32 bytes/)
    await expect(BrowserNode.start(emptySecret)).rejects.toThrow(/32 bytes/)
  })

  it("BrowserNode.start directly accepts a 32-byte secret and retains no-arg compatibility", async () => {
    const defaultNode = await BrowserNode.start()
    try {
      expect(defaultNode.endpointId.length).toBe(64)
    } finally {
      await defaultNode.close()
    }

    const secret = new Uint8Array(32)
    secret[0] = 7
    const customNode = await BrowserNode.start(secret)
    try {
      expect(customNode.endpointId.length).toBe(64)
    } finally {
      await customNode.close()
    }
  })
})
