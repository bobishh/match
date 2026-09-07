import irohInit, { BrowserNode } from "./iroh-runtime/match_iroh.js"

export type IrohStatus = "unavailable" | "starting" | "ready" | "error"

export type IrohNode = {
  endpointId: string
  dial: (remoteEndpoint: string) => Promise<IrohConnection>
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
  BrowserNode: { start: () => Promise<IrohNode> }
}

export function irohArtifactAvailable(): boolean {
  return typeof WebAssembly !== "undefined"
}

export async function startIrohBrowserNode(): Promise<IrohNode> {
  if (!irohArtifactAvailable()) throw new Error("WebAssembly unavailable in this browser")
  await irohInit()
  return BrowserNode.start()
}
