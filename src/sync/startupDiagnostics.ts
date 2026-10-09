import { telemetryConfig } from "./telemetryConfig"
import { diagnosticEvent } from "./telemetryEvent"

const sessionId = crypto.randomUUID()
const markerKey = "tincanban.startup.checkpoint.v1"
const deviceKey = "tincanban.startup.device.v1"
let deviceId = ""
let currentStage = "entry"

export function startupDiagnosticsEnabled(): boolean {
  return import.meta.env.VITE_STARTUP_DIAGNOSTICS === "1" && telemetryConfig().enabled
}

export function setStartupDiagnosticDevice(id: string): void {
  deviceId = id
  if (startupDiagnosticsEnabled()) try { localStorage.setItem(deviceKey, id) } catch { /* Diagnostic storage is optional. */ }
}

/** Debug checkpoints bypass batching so a process crash cannot erase every preceding stage. */
export async function startupCheckpoint(event: string, stage: string, detail: Record<string, unknown> = {}): Promise<void> {
  if (!startupDiagnosticsEnabled()) return
  currentStage = stage
  const config = telemetryConfig()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    try { sessionStorage.setItem(markerKey, JSON.stringify({ sessionId, stage, event })) } catch { /* Optional crash breadcrumb. */ }
    const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent
    const diagnostic = await diagnosticEvent(event, { ...detail, stage, component: "startup", operation: stage,
      browser: /Safari/.test(userAgent) && !/Chrome|Chromium|CriOS/.test(userAgent) ? "safari" : "other",
      platform: /iPhone|iPad|iPod/.test(userAgent) ? "ios" : "other",
    }, { project: config.project, sessionId, deviceId, timestamp: Date.now(), level: event.endsWith("failed") ? "warn" : "info" })
    const body = JSON.stringify({ schema_version: 2, project: config.project, stream: "telemetry", source: "browser", events: [diagnostic] })
    const deadline = new Promise<void>(resolve => { timer = setTimeout(() => { controller.abort(); resolve() }, 1200) })
    const delivery = fetch(config.endpoint, { method: "POST", credentials: "omit", keepalive: true,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.browserKey}` }, body, signal: controller.signal }).then(async response => {
      if (!response.ok || (await response.json() as { accepted?: number }).accepted !== 1) throw new Error("Startup diagnostic not accepted")
    })
    await Promise.race([delivery, deadline])
  } catch { /* A diagnostic failure must never block the local board. */ }
  finally { if (timer !== undefined) clearTimeout(timer) }
}

export async function diagnoseStartupStep<T>(stage: string, step: () => T | Promise<T>, detail: Record<string, unknown> = {}): Promise<T> {
  await startupCheckpoint("startup.phase.started", stage, detail)
  const started = performance.now()
  try {
    const result = await step()
    await startupCheckpoint("startup.phase.completed", stage, { ...detail, elapsedMs: performance.now() - started })
    return result
  } catch (error) {
    await startupCheckpoint("startup.phase.failed", stage, { ...detail, elapsedMs: performance.now() - started, errorCode: error instanceof Error ? error.name : "UnknownError" })
    throw error
  }
}

export async function beginStartupDiagnostics(): Promise<void> {
  if (!startupDiagnosticsEnabled()) return
  try { deviceId = localStorage.getItem(deviceKey) ?? "" } catch { /* Identity becomes available later. */ }
  try {
    const previous = JSON.parse(sessionStorage.getItem(markerKey) ?? "null") as { stage?: string; event?: string } | null
    if (previous?.stage && previous.event === "startup.phase.started") await startupCheckpoint("startup.previous.interrupted", previous.stage)
  } catch { /* Missing or malformed diagnostic breadcrumbs do not affect startup. */ }
  window.addEventListener("error", event => { void startupCheckpoint("startup.runtime.failed", currentStage, { errorCode: event.error instanceof Error ? event.error.name : "ScriptError" }) })
  window.addEventListener("unhandledrejection", event => { void startupCheckpoint("startup.runtime.failed", currentStage, { errorCode: event.reason instanceof Error ? event.reason.name : "UnhandledRejection" }) })
  await startupCheckpoint("startup.phase.started", "entry")
}
