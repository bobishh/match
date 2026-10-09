import init, { WasmStateCore } from "@meta-uber/mesh-transport/wasm"
import type { AccessWorkerRequest } from "./workspaceAccess"
import { diagnoseStartupStep, setStartupDiagnosticDevice } from "./startupDiagnostics"
import type { WorkspaceRole } from "../domain/permissions"

let ready: ReturnType<typeof init> | undefined
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<AccessWorkerRequest>) => void
  postMessage(response: { id: number; role?: string; error?: string; fatal?: boolean }): void
}
scope.onmessage = ({ data }) => { void decide(data) }
async function decide(data: AccessWorkerRequest) {
  if (data.diagnosticsEnabled && typeof data.input.deviceId === "string") setStartupDiagnosticDevice(data.input.deviceId)
  const diagnose = data.diagnosticsEnabled ? diagnoseStartupStep : async <T>(_stage: string, step: () => T | Promise<T>) => step()
  const detail = { workspaceId: data.input.snapshot.workspaceId, bytes: 0 }
  let wasm: Awaited<ReturnType<typeof init>>
  try {
    ready ??= diagnose("access-worker-wasm", async () => {
      const wasm = await init()
      detail.bytes = wasm.memory.buffer.byteLength
      return wasm
    }, detail)
    wasm = await ready
    detail.bytes = wasm.memory.buffer.byteLength
  } catch (error) {
    scope.postMessage({ id: data.id, error: String(error), fatal: true })
    return
  }
  try {
    const input = await diagnose("access-worker-decode", () => ({ ...data.input,
      snapshot: { ...data.input.snapshot, document: Array.from(data.input.snapshot.document) } }),
    { workspaceId: detail.workspaceId, bytes: data.input.snapshot.document.byteLength })
    const role = await diagnose("access-worker-decide", () => {
      const result = WasmStateCore.decideWorkspaceAccess(input, Date.now()) as WorkspaceRole
      detail.bytes = wasm.memory.buffer.byteLength
      return result
    }, detail)
    scope.postMessage({ id: data.id, role })
  } catch (error) {
    scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) })
  }
}
