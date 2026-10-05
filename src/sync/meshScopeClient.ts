import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import type { MeshScopeExecutor } from "@meta-uber/mesh-runtime"
import { scopeMethods, type ScopeMethod, type ScopeRequestBody, type ScopeResponse } from "./meshScopeProtocol"
import { assertScopeDocument } from "./meshScopeDocument"

type Job = { resolve(result: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
let shared: ScopeWorkerChannel | undefined
let scopeSequence = 0

class ScopeWorkerChannel {
  private readonly worker = new Worker(new URL("./meshScopeWorker.ts", import.meta.url), { type: "module", name: "mesh-documents" })
  private readonly jobs = new Map<number, Job>()
  private sequence = 0
  private failure?: Error

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<ScopeResponse>) => {
      if ("error" in data && data.fatal) { this.fail(new Error(data.error)); return }
      const job = this.jobs.get(data.id)
      if (!job) return
      this.jobs.delete(data.id)
      clearTimeout(job.timer)
      if ("error" in data) job.reject(new Error(data.error))
      else job.resolve(data.result)
    }
    this.worker.onerror = event => { event.preventDefault(); this.fail(new Error(`Mesh worker failed: ${event.message}`)) }
    this.worker.onmessageerror = () => this.fail(new Error("Mesh worker response could not be decoded"))
  }

  request(body: ScopeRequestBody): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => this.fail(new Error("Mesh worker timed out")), 60_000)
      this.jobs.set(id, { resolve, reject, timer })
      // Copy inputs: storage, proofs and outgoing callbacks can retain buffers.
      try { this.worker.postMessage({ ...body, id }) }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
    })
  }

  private fail(error: Error): void {
    this.failure = error
    this.worker.terminate()
    if (shared === this) shared = undefined
    for (const job of this.jobs.values()) { clearTimeout(job.timer); job.reject(error) }
    this.jobs.clear()
  }
}

export async function validateBackgroundScopeDocument(workspaceId: string, document: Uint8Array): Promise<void> {
  if (typeof window === "undefined") return assertScopeDocument(workspaceId, document)
  shared ??= new ScopeWorkerChannel()
  await shared.request({ kind: "validate", scopeId: 0, workspaceId, document })
}

/** One worker owns scope state; browser failures never fall back onto UI. */
export function createBackgroundMeshScope(workspaceId: string, secret: string): MeshScopeExecutor {
  if (typeof window === "undefined") return meshRustRuntime().createMeshScopeRuntime(workspaceId, secret)
  shared ??= new ScopeWorkerChannel()
  const channel = shared
  const scopeId = ++scopeSequence
  const ready = channel.request({ kind: "create", scopeId, workspaceId, secret })
  void ready.catch(() => undefined)
  let closed: Promise<void> | undefined
  return new Proxy({} as MeshScopeExecutor, {
    get(_target, method: string | symbol) {
      // Runtime is an RPC handle, never a Promise or a symbol-based protocol.
      if (typeof method !== "string") return undefined
      if (method === "free") return () => {
        closed ??= ready.then(() => channel.request({ kind: "free", scopeId })).then(() => undefined)
        return closed
      }
      if (!Object.hasOwn(scopeMethods, method)) return undefined
      return (...args: unknown[]) => {
        if (closed) return Promise.reject(new Error("Mesh scope already closed"))
        return ready.then(() => channel.request({ kind: "call", scopeId, method: method as ScopeMethod, args }))
      }
    },
  })
}
