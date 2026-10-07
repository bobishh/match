import policyInit, { WasmStateCore } from "@meta-uber/mesh-transport/wasm"
import { initializeAutomerge } from "../crdt"
import { computeWorkspaceAdmission, type WorkspaceAdmissionRequest, type WorkspaceAdmissionResponse } from "./workspaceAdmissionCore"

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkspaceAdmissionRequest>) => void) | null
  postMessage(response: WorkspaceAdmissionResponse): void
}
const ready = Promise.all([initializeAutomerge(), policyInit()])
// Catch startup failures immediately, then report the same failure to each job.
void ready.catch(() => undefined)
let queue = Promise.resolve()
scope.onmessage = event => {
  queue = queue.then(() => handleAdmission(event.data)).catch(() => undefined)
}

async function handleAdmission({ id, input }: WorkspaceAdmissionRequest) {
  try { await ready }
  catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error), fatal: true })
    return
  }
  let response: WorkspaceAdmissionResponse
  try {
    response = { id, result: computeWorkspaceAdmission({ ...input, now: Date.now() }, WasmStateCore) }
  } catch (error) {
    response = { id, error: error instanceof Error ? error.message : String(error) }
  }
  scope.postMessage(response)
}
