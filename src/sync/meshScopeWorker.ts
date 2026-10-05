import init, { WasmMeshScopeRuntime } from "@meta-uber/mesh-transport/wasm"
import { initializeAutomerge } from "../crdt"
import { assertScopeDocument } from "./meshScopeDocument"
import { scopeMethods, type ScopeRequest, type ScopeResponse } from "./meshScopeProtocol"

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ScopeRequest>) => void) | null
  postMessage(response: ScopeResponse, transfer?: ArrayBuffer[]): void
}
const runtimes = new Map<number, WasmMeshScopeRuntime>()
const ready = Promise.all([init(), initializeAutomerge()])
void ready.catch(() => undefined)
let queue = Promise.resolve()
scope.onmessage = ({ data }) => {
  queue = queue.then(() => execute(data)).catch(() => undefined)
}

async function execute(request: ScopeRequest): Promise<void> {
  try { await ready }
  catch (error) {
    scope.postMessage({ id: request.id, error: message(error), fatal: true })
    return
  }
  try {
    let result: unknown
    if (request.kind === "validate") {
      assertScopeDocument(request.workspaceId, request.document)
    } else if (request.kind === "create") {
      if (runtimes.has(request.scopeId)) throw new Error("Duplicate mesh scope")
      runtimes.set(request.scopeId, new WasmMeshScopeRuntime(request.workspaceId, request.secret))
    } else {
      const runtime = runtimes.get(request.scopeId)
      if (!runtime) throw new Error("Mesh scope already closed")
      if (request.kind === "free") {
        runtimes.delete(request.scopeId)
        runtime.free()
      } else {
        if (!Object.hasOwn(scopeMethods, request.method)) throw new Error("Unknown mesh scope operation")
        result = Reflect.apply(runtime[request.method], runtime, request.args) as unknown
      }
    }
    const wire = transferableResult(result)
    scope.postMessage({ id: request.id, result: wire.result }, wire.buffers)
  } catch (error) { scope.postMessage({ id: request.id, error: message(error) }) }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** Rust Vec<u8> effects arrive as number arrays. Convert before crossing UI. */
function transferableResult(value: unknown): { result: unknown; buffers: ArrayBuffer[] } {
  const buffers = new Set<ArrayBuffer>()
  const bytes = (input: unknown): unknown => {
    if (!(input instanceof Uint8Array) && !Array.isArray(input)) return input
    const output = input instanceof Uint8Array ? input : Uint8Array.from(input as number[])
    const owned = output.buffer instanceof ArrayBuffer ? output : output.slice()
    buffers.add(owned.buffer as ArrayBuffer)
    return owned
  }
  let result = value
  if (value instanceof Uint8Array || Array.isArray(value)) result = bytes(value)
  else if (value && typeof value === "object") {
    const record = { ...value } as Record<string, unknown>
    // Authorization/control JSON retains its original types and signed values.
    for (const key of ["document", "payload", "frame", "response", "acknowledgement", "documentFrame", "controlSnapshot"]) {
      if (key in record) record[key] = bytes(record[key])
    }
    if (Array.isArray(record.controlFrames)) record.controlFrames = record.controlFrames.map(bytes)
    result = record
  }
  return { result, buffers: [...buffers] }
}
