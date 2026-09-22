import { installPairingCodec } from "@meta-uber/mesh-pairing"
import { installMeshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import type { GossipStateMachine } from "@meta-uber/mesh-replication"
import irohInit, {
  BrowserNode,
  WasmAutomergeSyncEngine,
  WasmBlobEngine,
  WasmDeviceRouteCatalog,
  WasmGossipEngine,
  WasmMeshRuntimeState,
  WasmMeshHandshakeFlow,
  WasmPairingCodec,
  WasmWorkspaceJoinHandshake,
  WasmWorkspaceJoinHandoff,
  WasmStateCore,
  setBrowserTransportDebugLogging,
} from "@meta-uber/mesh-transport/wasm"
export { WasmBlobEngine, WasmGossipEngine, WasmPairingCodec, WasmWorkspaceJoinHandshake, WasmWorkspaceJoinHandoff }

let pairingCodecInstalled = false
let rustRuntimeInstalled = false
let browserRuntimeInitialization: Promise<void> | undefined

export type IrohNode = {
  endpointId: string
  createGossipEngine: () => GossipStateMachine
  dial: (remoteEndpoint: string) => Promise<IrohConnection>
  dialRelay: (remoteEndpoint: string) => Promise<IrohConnection>
  accept: () => Promise<IrohAcceptor>
  close: (reason?: string) => Promise<void>
}

type IrohConnection = {
  remoteEndpointId: string
  openStream: () => Promise<IrohStream>
  acceptStream: () => Promise<IrohStream>
  close: () => Promise<void>
}

type IrohAcceptor = {
  accept: () => Promise<IrohConnection | undefined>
  close: () => Promise<void>
}

type IrohStream = {
  send: (bytes: Uint8Array) => Promise<void>
  read: () => Promise<Uint8Array>
  closeSend: () => Promise<void>
}

function irohArtifactAvailable(): boolean {
  return typeof WebAssembly !== "undefined"
}

async function installIrohBrowserRuntime(): Promise<void> {
  if (!irohArtifactAvailable()) throw new Error("WebAssembly unavailable in this browser")
  await irohInit()
  if (!rustRuntimeInstalled) {
    installMeshRustRuntime({
      state: WasmStateCore,
      createDeviceRouteCatalog: () => new WasmDeviceRouteCatalog(),
      createAutomergeSyncEngine: (localDeviceId, maximumFrameBytes) =>
        new WasmAutomergeSyncEngine(localDeviceId, maximumFrameBytes),
      createMeshRuntimeState: () => new WasmMeshRuntimeState(),
      createMeshHandshakeFlow: direction => new WasmMeshHandshakeFlow(direction),
    })
    rustRuntimeInstalled = true
  }
  if (!pairingCodecInstalled) {
    installPairingCodec(new WasmPairingCodec())
    pairingCodecInstalled = true
  }
}

/** Initializes the Rust/WASM policy runtime before application state reads it. */
export function initializeIrohBrowserRuntime(): Promise<void> {
  browserRuntimeInitialization ??= installIrohBrowserRuntime().catch(error => {
    browserRuntimeInitialization = undefined
    throw error
  })
  return browserRuntimeInitialization
}

export type IrohBrowserNodeOptions = {
  /** Enables Iroh's high-volume connection and stream events for a focused reproduction. */
  verboseTransportLogging?: boolean
}

export async function startIrohBrowserNode(secret?: Uint8Array, options: IrohBrowserNodeOptions = {}): Promise<IrohNode> {
  if (secret !== undefined && secret.byteLength !== 32) {
    throw new Error("Iroh node secret must be exactly 32 bytes")
  }
  await initializeIrohBrowserRuntime()
  setBrowserTransportDebugLogging(options.verboseTransportLogging === true)
  const node = await BrowserNode.start(secret)
  return {
    endpointId: node.endpointId,
    createGossipEngine: () => new WasmGossipEngine(node.endpointId) as GossipStateMachine,
    dial: endpoint => node.dial(endpoint),
    dialRelay: endpoint => node.dialRelay(endpoint),
    accept: () => node.accept(),
    close: reason => node.close(reason),
  }
}
