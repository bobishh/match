import init, { WasmStateCore } from "@meta-uber/mesh-transport/wasm"
import type { AccessWorkerRequest } from "./workspaceAccess"

const ready = init()
void ready.catch(() => undefined)
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<AccessWorkerRequest>) => void
  postMessage(response: { id: number; role?: string; error?: string; fatal?: boolean }): void
}
scope.onmessage = ({ data }) => { void decide(data) }
async function decide(data: AccessWorkerRequest) {
  try { await ready } catch (error) {
    scope.postMessage({ id: data.id, error: String(error), fatal: true })
    return
  }
  try {
    const input = { ...data.input, snapshot: { ...data.input.snapshot, document: Array.from(data.input.snapshot.document) } }
    scope.postMessage({ id: data.id, role: WasmStateCore.decideWorkspaceAccess(input, Date.now()) })
  } catch (error) {
    scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) })
  }
}
