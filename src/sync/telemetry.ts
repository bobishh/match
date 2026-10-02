type Detail = Record<string, unknown>
type Event = { timestamp_ms: number; event: string; session_id: string; workspace_id: string; peer_id: string;
  record_id: string; connection_id: string; phase: string; duration_ms: number; outcome: string }

const sessionId = crypto.randomUUID()
const queue: Event[] = []
let timer: ReturnType<typeof setTimeout> | undefined
const endpoint = import.meta.env.VITE_SYNC_TELEMETRY_URL ||
  (location.hostname === "match.meta-uber-engineer.dev" ? "https://ingest.meta-uber-engineer.dev/telemetry" : "")

function id(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : ""
}

export function diagnosticEvent(event: string, detail: Detail): Event {
  // Explicit allowlist: never forward bodies, names, URLs, proofs, or error text.
  return { timestamp_ms: typeof detail.timestampMs === "number" ? detail.timestampMs : Date.now(),
    event: id(event), session_id: sessionId, workspace_id: id(detail.workspaceId), peer_id: id(detail.peerId),
    record_id: id(detail.recordId), connection_id: id(detail.connectionId), phase: id(detail.phase),
    duration_ms: typeof detail.elapsedMs === "number" ? Math.min(86_400_000, Math.max(0, Math.round(detail.elapsedMs))) : 0,
    outcome: id(detail.outcome) }
}

export function record(event: string, detail: Detail) {
  if (!endpoint) return
  queue.push(diagnosticEvent(event, detail))
  if (queue.length > 1000) queue.shift()
  timer ??= setTimeout(() => { timer = undefined; void flush() }, 2000)
}

async function flush() {
  if (!navigator.onLine || !queue.length) return
  const events = queue.splice(0, 50)
  try {
    const response = await fetch(endpoint, { method: "POST", credentials: "omit", keepalive: true,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, events }),
      signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error("Telemetry unavailable")
  } catch { queue.unshift(...events); queue.splice(1000) }
  if (queue.length) timer ??= setTimeout(() => { timer = undefined; void flush() }, 5000)
}

addEventListener("online", () => { void flush() })
addEventListener("pagehide", () => {
  if (endpoint && queue.length) navigator.sendBeacon(endpoint,
    new Blob([JSON.stringify({ sessionId, events: queue.splice(0, 50) })], { type: "application/json" }))
})
