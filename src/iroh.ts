import { installPairingCodec } from "@meta-uber/mesh-pairing"
import irohInit, { BrowserNode, WasmBlobEngine, WasmGossipEngine, WasmPairingCodec } from "@meta-uber/mesh-transport/wasm"
export { BrowserNode, WasmBlobEngine, WasmGossipEngine, WasmPairingCodec }

let pairingCodecInstalled = false

export type IrohStatus = "unavailable" | "starting" | "ready" | "error"

export type IrohNode = {
  endpointId: string
  dial: (remoteEndpoint: string) => Promise<IrohConnection>
  dialRelay: (remoteEndpoint: string) => Promise<IrohConnection>
  accept: () => Promise<IrohAcceptor>
  close: (reason?: string) => Promise<void>
}

export type IrohConnection = {
  remoteEndpointId: string
  openStream: () => Promise<IrohStream>
  acceptStream: () => Promise<IrohStream>
  close: () => Promise<void>
}

export type IrohAcceptor = {
  accept: () => Promise<IrohConnection | undefined>
  close: () => Promise<void>
}

export type IrohStream = {
  send: (bytes: Uint8Array) => Promise<void>
  read: () => Promise<Uint8Array>
  closeSend: () => Promise<void>
}

type IrohModule = {
  default: () => Promise<void>
  BrowserNode: { start: (secret?: Uint8Array) => Promise<IrohNode> }
}

export function irohArtifactAvailable(): boolean {
  return typeof WebAssembly !== "undefined"
}

export async function startIrohBrowserNode(secret?: Uint8Array): Promise<IrohNode> {
  if (!irohArtifactAvailable()) throw new Error("WebAssembly unavailable in this browser")
  if (secret !== undefined && secret.byteLength !== 32) {
    throw new Error("Iroh node secret must be exactly 32 bytes")
  }
  await irohInit()
  if (!pairingCodecInstalled) {
    installPairingCodec(new WasmPairingCodec())
    pairingCodecInstalled = true
  }
  return BrowserNode.start(secret)
}
