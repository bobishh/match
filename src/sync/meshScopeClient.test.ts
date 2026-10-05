import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ScopeRequest, ScopeResponse } from "./meshScopeProtocol"

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage?: (event: MessageEvent<ScopeResponse>) => void
  onerror?: (event: { message: string; preventDefault(): void }) => void
  onmessageerror?: () => void
  requests: ScopeRequest[] = []
  terminate = vi.fn()
  constructor() { FakeWorker.instances.push(this) }
  postMessage(request: ScopeRequest): void {
    this.requests.push(request)
    if (request.kind === "create" || request.kind === "free" || request.kind === "call" && request.method === "startDocumentSync") {
      queueMicrotask(() => this.onmessage?.({ data: { id: request.id, result: undefined } } as MessageEvent<ScopeResponse>))
    }
  }
}

beforeEach(() => {
  vi.resetModules()
  FakeWorker.instances = []
  vi.stubGlobal("window", {})
  vi.stubGlobal("Worker", FakeWorker)
})
afterEach(() => { vi.unstubAllGlobals() })

describe("background scope failure boundary", () => {
  it("fails pending and old scopes after worker crash; new sessions get a fresh worker", async () => {
    const { createBackgroundMeshScope } = await import("./meshScopeClient")
    const runtime = createBackgroundMeshScope("workspace", "secret")
    await runtime.startDocumentSync("local", "remote")
    const worker = FakeWorker.instances[0]
    const bytes = new Uint8Array([1, 2, 3])
    const pending = runtime.provideDocument(bytes, undefined)
    const rejected = expect(pending).rejects.toThrow("Mesh worker failed: crash")
    await vi.waitFor(() => expect(worker.requests.some(request => request.kind === "call" && request.method === "provideDocument")).toBe(true))
    worker.onerror?.({ message: "crash", preventDefault() {} })
    await rejected
    await expect(runtime.publishFrame(bytes, undefined)).rejects.toThrow("Mesh worker failed: crash")
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(bytes.byteLength).toBe(3)
    const next = createBackgroundMeshScope("workspace", "secret")
    await next.startDocumentSync("local", "remote")
    expect(FakeWorker.instances).toHaveLength(2)
    await next.free?.()
  })

  it("rejects startup failure and never retries compute on the main thread", async () => {
    const { createBackgroundMeshScope } = await import("./meshScopeClient")
    const runtime = createBackgroundMeshScope("workspace", "secret")
    const pending = runtime.startDocumentSync("local", "remote")
    const rejected = expect(pending).rejects.toThrow("WASM unavailable")
    const worker = FakeWorker.instances[0]
    const create = worker.requests[0]
    worker.onmessage?.({ data: { id: create.id, error: "WASM unavailable", fatal: true } } as MessageEvent<ScopeResponse>)
    await rejected
    await expect(runtime.publishFrame(new Uint8Array(), undefined)).rejects.toThrow("WASM unavailable")
    expect(worker.requests).toHaveLength(1)
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
})
