import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { BrowserNode, initSync } from "@meta-uber/mesh-transport/wasm"
import { startIrohBrowserNode, WasmBlobEngine, WasmGossipEngine, WasmPairingCodec } from "./iroh"
import { fileReferenceSchema } from "./domain/entitySchemas"

// Ensure WASM is initialized for Node environment
const wasmPath = resolve(__dirname, "../vendor/meta-mesh/packages/mesh-transport/wasm/meta_mesh_bg.wasm")
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

describe("Iroh gossip and blobs support in match", () => {
  it("Given the shared Rust core, when a pairing frame is decoded, then binary payload survives", () => {
    const codec = new WasmPairingCodec()
    const payload = new Uint8Array([0, 1, 255])
    const frame = codec.encode("mesh-control-sync", "workspace-secret", payload)

    expect(codec.inspect(frame)).toEqual({ type: "mesh-control-sync", secret: "workspace-secret" })
    expect(codec.decode(frame, "mesh-control-sync", "workspace-secret")).toEqual(payload)
  })

  it("Given the shared Rust core, when pairing secret is wrong, then decoding fails closed", () => {
    const codec = new WasmPairingCodec()
    const frame = codec.encode("sync-request", "secret-a", new Uint8Array([1]))

    expect(() => codec.decode(frame, "sync-request", "secret-b")).toThrow("Pairing authorization failed")
  })

  it("WasmBlobEngine creates content-addressed blob with ticket and verifies payload", () => {
    const engine = new WasmBlobEngine()
    const data = new TextEncoder().encode("resume attachment markdown")
    const blob = engine.createBlob(data, "resume.md", "text/markdown", null)

    expect(blob.blobId).toMatch(/^blake3:[0-9a-f]{64}$/)
    expect(blob.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(blob.ticket).toBeDefined()
    expect(blob.size).toBe(data.byteLength)

    expect(engine.hasBlob(blob.hash)).toBe(true)
    expect(engine.getBlob(blob.hash)).toEqual(data)
    expect(engine.verifyBlob(blob.hash, data)).toBe(true)

    // Verify Automerge entity schema validates the blob reference with ticket
    const fileRef = {
      type: "blob" as const,
      hash: blob.hash,
      ticket: blob.ticket,
      byteLength: blob.size,
      mimeType: blob.mediaType,
      fileName: blob.name,
    }
    const validated = fileReferenceSchema.parse(fileRef)
    expect(validated).toEqual(fileRef)
  })

  it("WasmGossipEngine joins workspace topic and broadcasts deduplicated messages", () => {
    const peer1 = "peer-alpha-001"
    const peer2 = "peer-beta-002"
    const engine1 = new WasmGossipEngine(peer1)
    const engine2 = new WasmGossipEngine(peer2)

    const topicHash1 = engine1.joinTopic("workspace-sync", [])
    const topicHash2 = engine2.joinTopic("workspace-sync", [])
    expect(topicHash1).toBe(topicHash2)

    const payload = new TextEncoder().encode("entity-change-notice")
    const packet = engine1.broadcast("workspace-sync", payload)
    expect(packet.byteLength).toBeGreaterThan(0)

    const received = engine2.handleMessage(peer1, packet)
    expect(received).toEqual(payload)

    // Duplicate message delivery returns undefined
    const duplicate = engine2.handleMessage(peer1, packet)
    expect(duplicate).toBeUndefined()
  })
})
