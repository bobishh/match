import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { computeWorkspaceAdmission, type WorkspaceAdmissionInput, type WorkspaceAdmissionResult,
  type WorkspaceAdmissionRequest, type WorkspaceAdmissionResponse } from "./workspaceAdmissionCore"

type PendingJob = { resolve(result: WorkspaceAdmissionResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
let worker: Worker | undefined
let nextId = 0
const pending = new Map<number, PendingJob>()
const admissionDeadlineMs = 60_000

function failWorker(error: Error) {
  worker?.terminate()
  worker = undefined
  for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error) }
  pending.clear()
}

function admissionWorker(): Worker {
  if (worker) return worker
  // Browser failures must reject admission, never fall back to blocking UI.
  worker = new Worker(new URL("./workspaceAdmissionWorker.ts", import.meta.url), { type: "module", name: "workspace-admission" })
  worker.onmessage = (event: MessageEvent<WorkspaceAdmissionResponse>) => {
    const response = event.data
    const job = pending.get(response.id)
    if (!job) return
    if ("error" in response && response.fatal) { failWorker(new Error(response.error)); return }
    pending.delete(response.id)
    clearTimeout(job.timer)
    if ("error" in response) job.reject(new Error(response.error))
    else job.resolve(response.result)
  }
  worker.onerror = event => { event.preventDefault(); failWorker(new Error(`Workspace admission worker failed: ${event.message}`)) }
  worker.onmessageerror = () => failWorker(new Error("Workspace admission worker response could not be decoded"))
  return worker
}

export function runWorkspaceAdmission(input: WorkspaceAdmissionInput): Promise<WorkspaceAdmissionResult> {
  // Non-browser callers (CLI/unit fixtures) use the identical pure algorithm.
  if (typeof window === "undefined") return Promise.resolve().then(() => computeWorkspaceAdmission(input, meshRustRuntime().state))
  return new Promise((resolve, reject) => {
    const id = ++nextId
    try {
      const target = admissionWorker()
      const timer = setTimeout(() => failWorker(new Error("Workspace admission worker timed out")), admissionDeadlineMs)
      pending.set(id, { resolve, reject, timer })
      const request: WorkspaceAdmissionRequest = { id, input }
      const buffers = [input.remote.buffer, ...(input.local ? [input.local.buffer] : [])] as ArrayBuffer[]
      target.postMessage(request, buffers)
    } catch (cause) {
      const job = pending.get(id)
      if (job) { clearTimeout(job.timer); pending.delete(id) }
      reject(cause instanceof Error ? cause : new Error(String(cause)))
    }
  })
}
