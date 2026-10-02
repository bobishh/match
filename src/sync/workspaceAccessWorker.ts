import init, { WasmStateCore } from "@meta-uber/mesh-transport/wasm"

const ready = init()
void ready.catch(() => undefined)
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<{ id: number; input: unknown }>) => void
  postMessage(response: { id: number; role?: string; error?: string; fatal?: boolean }): void
}
scope.onmessage = ({ data }) => { void decide(data) }
async function decide(data: { id: number; input: unknown }) {
  try { await ready } catch (error) {
    scope.postMessage({ id: data.id, error: String(error), fatal: true })
    return
  }
  try {
    scope.postMessage({ id: data.id, role: WasmStateCore.decideWorkspaceAccess(data.input, Date.now()) })
  } catch (error) {
    scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) })
  }
}
