import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { installPairingCodec } from "@meta-uber/mesh-pairing"
import { installMeshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import {
  initSync,
  WasmAutomergeSyncEngine,
  WasmDeviceRouteCatalog,
  WasmMeshRuntimeState,
  WasmMeshHandshakeFlow,
  WasmPairingCodec,
  WasmStateCore,
} from "@meta-uber/mesh-transport/wasm"
const wasm = readFileSync(resolve(process.cwd(), "vendor/meta-mesh/packages/mesh-transport/wasm/meta_mesh_bg.wasm"))
initSync({ module: wasm })

installMeshRustRuntime({
  state: WasmStateCore,
  createDeviceRouteCatalog: () => new WasmDeviceRouteCatalog(),
  createAutomergeSyncEngine: (localDeviceId, maximumFrameBytes) =>
    new WasmAutomergeSyncEngine(localDeviceId, maximumFrameBytes),
  createMeshRuntimeState: () => new WasmMeshRuntimeState(),
  createMeshHandshakeFlow: direction => new WasmMeshHandshakeFlow(direction),
})

installPairingCodec(new WasmPairingCodec())
