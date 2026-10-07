import type { Page } from "./coverage"

type PhaseEvent = { at: number; kind: string; detail?: string }

export async function startWorkspacePhaseProbe(page: Page): Promise<void> {
  await page.evaluate(async () => {
    type ProbeWindow = Window & { __workspacePhaseProbe?: { events: PhaseEvent[]; timer: number } }
    const target = window as ProbeWindow
    const events: PhaseEvent[] = []
    const record = (kind: string, detail?: string) => {
      if (events.length >= 80) events.shift()
      events.push({ at: Math.round(performance.now()), kind, detail })
    }
    const [{ stateRuntime }, { defaultStorage }] = await Promise.all([
      import("/src/stateContext.ts"), import("/src/storage.ts"),
    ])
    const snapshot = () => record("state", [stateRuntime.saveState.value, `pending=${stateRuntime.pendingWrites}`,
      `version=${stateRuntime.docVersion.value}`, `reconcile=${Boolean(stateRuntime.reconcilePromise)}`,
      `failed=${stateRuntime.batchSaveFailed}`, `review=${stateRuntime.causalReview.value.length}`,
      `reviewError=${Boolean(stateRuntime.causalReviewError.value)}`].join(" "))
    const timer = window.setInterval(snapshot, 250)
    const originalCommit = defaultStorage.commitWorkspace.bind(defaultStorage)
    defaultStorage.commitWorkspace = async (...args) => {
      record("storage-commit", "start")
      try {
        const result = await originalCommit(...args)
        record("storage-commit", "complete")
        return result
      } catch (error) {
        record("storage-commit", `failed:${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    }
    const originalPostMessage = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (message: unknown, transfer?: Transferable[]) {
      const request = message as { id?: number; input?: { local?: { byteLength?: number }; remote?: { byteLength?: number } } }
      const isAdmission = request.input?.remote instanceof ArrayBuffer || request.input?.remote instanceof Uint8Array
      if (isAdmission) {
        Object.assign(request, { diagnostics: true })
        record("admission", `request=${request.id} worker=${this.name || "unnamed"} local=${request.input?.local?.byteLength ?? 0} remote=${request.input?.remote?.byteLength ?? 0}`)
        const onMessage = (event: MessageEvent) => {
          const response = event.data as { id?: number; error?: string; diagnostics?: Record<string, number>;
            result?: { decisions?: Array<{ status?: { type?: string } }> } }
          const counts = new Map<string, number>()
          for (const decision of response.result?.decisions ?? []) {
            const status = decision.status?.type ?? "unknown"
            counts.set(status, (counts.get(status) ?? 0) + 1)
          }
          const timings = Object.entries(response.diagnostics ?? {}).map(([key, value]) => `${key}=${Math.round(value)}ms`).join(" ")
          record("admission", `response=${response.id} ${response.error ? `error=${response.error}` : `decisions=${[...counts].map(([key, count]) => `${key}:${count}`).join(",")} ${timings}`}`)
        }
        this.addEventListener("message", onMessage)
      }
      return originalPostMessage.call(this, message, transfer)
    }
    target.__workspacePhaseProbe = { events, timer }
    record("probe", "installed")
  })
}

export async function readWorkspacePhaseProbe(page: Page): Promise<PhaseEvent[]> {
  return page.evaluate(() => {
    const target = window as Window & { __workspacePhaseProbe?: { events: PhaseEvent[]; timer: number } }
    const probe = target.__workspacePhaseProbe
    if (!probe) return []
    window.clearInterval(probe.timer)
    return probe.events
  })
}
