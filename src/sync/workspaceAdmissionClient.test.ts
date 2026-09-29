import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { WorkspaceAdmissionInput, WorkspaceAdmissionRequest, WorkspaceAdmissionResponse, WorkspaceAdmissionResult } from "./workspaceAdmissionCore"

const workers: FakeWorker[] = []
class FakeWorker {
  requests: WorkspaceAdmissionRequest[] = []
  onmessage?: (event: MessageEvent<WorkspaceAdmissionResponse>) => void
  onerror?: (event: ErrorEvent) => void
  onmessageerror?: () => void
  terminate = vi.fn()
  constructor() { workers.push(this) }
  postMessage(request: WorkspaceAdmissionRequest) { this.requests.push(request) }
  reply(response: WorkspaceAdmissionResponse) { this.onmessage?.({ data: response } as MessageEvent<WorkspaceAdmissionResponse>) }
}
const result: WorkspaceAdmissionResult = { neededHashes: [], admittedHashes: [], verifiedAuthorizations: [],
  unsignedHashes: [], unsignedError: "" }
function input(): WorkspaceAdmissionInput {
  return { workspaceId: "test", remote: new Uint8Array([1]), knownAuthority: null,
    authorization: {} as WorkspaceAdmissionInput["authorization"], now: Date.now() }
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  workers.length = 0
  vi.stubGlobal("window", {})
  vi.stubGlobal("Worker", FakeWorker)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it("rejects all queued admissions after initialization failure and starts a fresh worker on retry", async () => {
  const { runWorkspaceAdmission } = await import("./workspaceAdmissionClient")
  const first = runWorkspaceAdmission(input())
  const second = runWorkspaceAdmission(input())
  const firstRejected = expect(first).rejects.toThrow("WASM unavailable")
  const secondRejected = expect(second).rejects.toThrow("WASM unavailable")
  const failed = workers[0]!
  failed.reply({ id: failed.requests[0]!.id, error: "WASM unavailable", fatal: true })
  await Promise.all([firstRejected, secondRejected])
  expect(failed.terminate).toHaveBeenCalledOnce()
  const retry = runWorkspaceAdmission(input())
  expect(workers).toHaveLength(2)
  workers[1]!.reply({ id: workers[1]!.requests[0]!.id, result })
  await expect(retry).resolves.toEqual(result)
})

it("rejects a stalled worker, ignores its late result and leaves a new retry pending until its own result", async () => {
  const { runWorkspaceAdmission } = await import("./workspaceAdmissionClient")
  const stalled = runWorkspaceAdmission(input())
  const rejected = expect(stalled).rejects.toThrow("timed out")
  const old = workers[0]!
  await vi.advanceTimersByTimeAsync(60_000)
  await rejected
  expect(old.terminate).toHaveBeenCalledOnce()
  const retry = runWorkspaceAdmission(input())
  let completed = false
  void retry.then(() => { completed = true })
  old.reply({ id: old.requests[0]!.id, result })
  await Promise.resolve()
  expect(completed).toBe(false)
  workers[1]!.reply({ id: workers[1]!.requests[0]!.id, result })
  await expect(retry).resolves.toEqual(result)
})

it("keeps the initialized worker after a policy rejection so later valid admission can complete", async () => {
  const { runWorkspaceAdmission } = await import("./workspaceAdmissionClient")
  const invalid = runWorkspaceAdmission(input())
  const rejected = expect(invalid).rejects.toThrow("Invalid signature")
  workers[0]!.reply({ id: workers[0]!.requests[0]!.id, error: "Invalid signature" })
  await rejected
  const valid = runWorkspaceAdmission(input())
  expect(workers).toHaveLength(1)
  workers[0]!.reply({ id: workers[0]!.requests[1]!.id, result })
  await expect(valid).resolves.toEqual(result)
  expect(workers[0]!.terminate).not.toHaveBeenCalled()
})
