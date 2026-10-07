import policyInit, { WasmStateCore } from "@meta-uber/mesh-transport/wasm"
import { initializeAutomerge } from "../crdt"
import { computeWorkspaceAdmission, type WorkspaceAdmissionRequest, type WorkspaceAdmissionResponse } from "./workspaceAdmissionCore"

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkspaceAdmissionRequest>) => void) | null
  postMessage(response: WorkspaceAdmissionResponse): void
}
const workerStartedAt = performance.now()
const ready = Promise.all([initializeAutomerge(), policyInit()])
let workerReadyMs = 0
void ready.then(() => { workerReadyMs = performance.now() - workerStartedAt })
// Catch startup failures immediately, then report the same failure to each job.
void ready.catch(() => undefined)
let queue = Promise.resolve()
scope.onmessage = event => {
  queue = queue.then(() => handleAdmission(event.data)).catch(() => undefined)
}

async function handleAdmission({ id, input, diagnostics }: WorkspaceAdmissionRequest) {
  const timings: Record<string, number> = {}
  const readyWaitStartedAt = performance.now()
  try { await ready }
  catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error), fatal: true })
    return
  }
  if (diagnostics) {
    timings["worker-ready-total"] = workerReadyMs
    timings["worker-ready-wait"] = performance.now() - readyWaitStartedAt
  }
  let response: WorkspaceAdmissionResponse
  try {
    response = { id, result: computeWorkspaceAdmission({ ...input, now: Date.now() }, WasmStateCore,
      diagnostics ? (phase, elapsedMs) => { timings[phase] = elapsedMs } : undefined),
    ...(diagnostics ? { diagnostics: timings } : {}) }
  } catch (error) {
    response = { id, error: error instanceof Error ? error.message : String(error) }
  }
  scope.postMessage(response)
}
