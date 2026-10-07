import type { Page } from "./coverage"

type PhaseEvent = { at: number; kind: string; detail?: string }
type ProbeState = { events: PhaseEvent[]; pending: Map<number, number>; timers: number[]; record(kind: string, detail?: string): void }

declare global {
  interface Window { __workspacePhaseProbe?: ProbeState }
}

export async function installWorkspacePhaseProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as Window & { __workspacePhaseProbe?: ProbeState }
    if (target.__workspacePhaseProbe) return
    const events: PhaseEvent[] = []
    const pending = new Map<number, number>()
    const timers: number[] = []
    const record = (kind: string, detail?: string) => {
      if (events.length >= 80) events.shift()
      events.push({ at: Math.round(performance.now()), kind, detail })
    }
    target.__workspacePhaseProbe = { events, pending, timers, record }
    const originalPostMessage = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (message: unknown, transfer?: Transferable[]) {
      const request = message as { id?: number; diagnostics?: boolean; input?: { remote?: unknown } }
      if (request.input?.remote instanceof ArrayBuffer || request.input?.remote instanceof Uint8Array) {
        request.diagnostics = true
        const id = request.id ?? -1
        pending.set(id, performance.now())
        record("admission", `request=${id}`)
        this.addEventListener("message", event => {
          const response = event.data as { id?: number; error?: string; diagnostics?: Record<string, number> }
          if (response.id !== id) return
          pending.delete(id)
          const phases = Object.entries(response.diagnostics ?? {}).map(([key, value]) => `${key}=${Math.round(value)}ms`).join(" ")
          record("admission", `response=${id}${response.error ? ` error=${response.error}` : ` ${phases}`}`)
        })
      }
      return originalPostMessage.call(this, message, transfer)
    }
    let previousState = ""
    const timer = window.setInterval(() => {
      const button = document.querySelector<HTMLButtonElement>('button[aria-label="Open workspaces"]')
      const label = document.querySelector<HTMLElement>('.boot-progress [role="status"]')?.innerText.trim() ?? ""
      const state = `${button ? (button.disabled ? "disabled" : "enabled") : "absent"} ${label}`
      if (state !== previousState) { previousState = state; record("startup", state) }
    }, 250)
    timers.push(timer)
  })
}

export async function startWorkspacePhaseProbe(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const target = window as Window & { __workspacePhaseProbe?: ProbeState }
    if (!target.__workspacePhaseProbe) {
      const events: PhaseEvent[] = []
      const pending = new Map<number, number>()
      const timers: number[] = []
      const record = (kind: string, detail?: string) => {
        if (events.length >= 80) events.shift()
        events.push({ at: Math.round(performance.now()), kind, detail })
      }
      target.__workspacePhaseProbe = { events, pending, timers, record }
    }
    const probe = target.__workspacePhaseProbe
    const [{ stateRuntime }, { defaultStorage }] = await Promise.all([
      import("/src/stateContext.ts"), import("/src/storage.ts"),
    ])
    const snapshot = () => probe.record("state", [stateRuntime.saveState.value, `pending=${stateRuntime.pendingWrites}`,
      `version=${stateRuntime.docVersion.value}`, `reconcile=${Boolean(stateRuntime.reconcilePromise)}`,
      `failed=${stateRuntime.batchSaveFailed}`, `review=${stateRuntime.causalReview.value.length}`,
      `reviewError=${Boolean(stateRuntime.causalReviewError.value)}`].join(" "))
    probe.timers.push(window.setInterval(snapshot, 250))
    const originalCommit = defaultStorage.commitWorkspace.bind(defaultStorage)
    defaultStorage.commitWorkspace = async (...args) => {
      probe.record("storage-commit", "start")
      try {
        const result = await originalCommit(...args)
        probe.record("storage-commit", "complete")
        return result
      } catch (error) {
        probe.record("storage-commit", `failed:${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    }
    probe.record("probe", "installed")
  })
}

export async function readWorkspacePhaseProbe(page: Page, waitForWorkerMs = 0): Promise<PhaseEvent[]> {
  return page.evaluate(async waitMs => {
    const target = window as Window & { __workspacePhaseProbe?: ProbeState }
    const probe = target.__workspacePhaseProbe
    if (!probe) return []
    const deadlines = [...probe.pending.values()].map(startedAt => startedAt + 60_000)
    const deadline = Math.min(performance.now() + waitMs, ...deadlines)
    while (waitMs > 0 && probe.pending.size > 0 && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    for (const timer of probe.timers) window.clearInterval(timer)
    return probe.events
  }, waitForWorkerMs)
}
