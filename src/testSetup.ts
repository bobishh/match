import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { installPairingCodec } from "@meta-uber/mesh-pairing"
import { installMeshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import {
  initSync,
  WasmAutomergeSyncEngine,
  WasmDeviceRouteCatalog,
  WasmMeshRuntimeState,
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
})

installPairingCodec({
  encode(type, secret, bytes) {
    const header = new TextEncoder().encode(`${JSON.stringify({ type, version: "0.0.1", secret })}\n`)
    const frame = new Uint8Array(header.length + bytes.length)
    frame.set(header)
    frame.set(bytes, header.length)
    return frame
  },
  inspect(frame) {
    const separator = frame.indexOf(10)
    if (separator < 0) throw new Error("Pairing frame missing")
    return JSON.parse(new TextDecoder().decode(frame.slice(0, separator)))
  },
  decode(frame, expectedType, expectedSecret) {
    const separator = frame.indexOf(10)
    if (separator < 0) throw new Error("Pairing frame missing")
    const header = JSON.parse(new TextDecoder().decode(frame.slice(0, separator)))
    if (header.type !== expectedType || header.version !== "0.0.1" || header.secret !== expectedSecret) {
      throw new Error("Pairing authorization failed")
    }
    return frame.slice(separator + 1)
  },
})
