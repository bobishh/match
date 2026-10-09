import * as Automerge from "@automerge/automerge/slim"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { canonicalizeJson } from "../domain/identity"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { WorkspaceRole } from "../domain/permissions"
import { diagnoseStartupStep } from "./startupDiagnostics"
import { telemetryConfig } from "./telemetryConfig"

type Entry = { evidence: string; result: Promise<WorkspaceRole>; expires: number }
export type AccessWorkerRequest = { id: number; diagnosticsEnabled?: boolean; input: Record<string, unknown> & { snapshot: Record<string, unknown> & { document: Uint8Array } } }
const cache = new Map<string, Entry>()
const jobs = new Map<number, { resolve(role: WorkspaceRole): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
let worker: Worker | undefined
let sequence = 0

function documentKey(doc: Automerge.Doc<WorkspaceDocumentV2>) {
  return `${doc.id}:${Automerge.getHeads(doc).sort().join()}`
}

export function inheritLocalMoveAccess(before: Automerge.Doc<WorkspaceDocumentV2>, after: Automerge.Doc<WorkspaceDocumentV2>) {
  const entry = cache.get(documentKey(before))
  if (entry && before.ownerPersonId === after.ownerPersonId) {
    cache.set(documentKey(after), { ...entry })
    trimCache()
  }
}

export function decideAccess(doc: Automerge.Doc<WorkspaceDocumentV2>, evidence: { snapshot: Record<string, unknown> } & Record<string, unknown>): Promise<WorkspaceRole> {
  const key = documentKey(doc)
  const signature = canonicalizeJson(evidence)
  const previous = cache.get(key)
  if (previous?.evidence === signature && previous.expires > Date.now()) return previous.result
  const detail = { workspaceId: doc.id, bytes: 0 }
  const result = (async () => {
    const input = await diagnoseStartupStep("access-serialize", () => {
      const document = Automerge.save(doc)
      detail.bytes = document.byteLength
      return { ...evidence, snapshot: { ...evidence.snapshot, document } }
    }, detail)
    return diagnoseStartupStep("access-policy", () => typeof window === "undefined"
      ? meshRustRuntime().state.decideWorkspaceAccess({ ...input,
        snapshot: { ...input.snapshot, document: Array.from(input.snapshot.document) } }, Date.now()) : offThread(input), detail)
  })()
  const entry = { evidence: signature, result, expires: Date.now() + 60_000 }
  cache.set(key, entry)
  void result.catch(() => { if (cache.get(key) === entry) cache.delete(key) })
  trimCache()
  return result
}

function trimCache() { if (cache.size > 100) cache.delete(cache.keys().next().value!) }

function fail(error: Error) {
  worker?.terminate()
  worker = undefined
  for (const job of jobs.values()) { clearTimeout(job.timer); job.reject(error) }
  jobs.clear()
}

function offThread(input: AccessWorkerRequest["input"]): Promise<WorkspaceRole> {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    try {
      if (!worker) {
        worker = new Worker(new URL("./workspaceAccessWorker.ts", import.meta.url), { type: "module", name: "workspace-access" })
        worker.onmessage = ({ data }: MessageEvent<{ id: number; role?: WorkspaceRole; error?: string; fatal?: boolean }>) => {
          if (data.fatal) { fail(new Error(data.error ?? "Workspace access unavailable")); return }
          const job = jobs.get(data.id)
          if (!job) return
          jobs.delete(data.id)
          clearTimeout(job.timer)
          if (data.role) job.resolve(data.role)
          else job.reject(new Error(data.error ?? "Workspace access unavailable"))
        }
        worker.onerror = event => { event.preventDefault(); fail(new Error("Workspace access worker unavailable")) }
        worker.onmessageerror = () => fail(new Error("Workspace access response unavailable"))
      }
      jobs.set(id, { resolve, reject, timer: setTimeout(() => fail(new Error("Workspace access worker timed out")), 60_000) })
      worker.postMessage({ id, input, diagnosticsEnabled: telemetryConfig().enabled } satisfies AccessWorkerRequest, [input.snapshot.document.buffer as ArrayBuffer])
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); reject(error) }
  })
}
