export type MeshTraceLevel = "info" | "warn"

export type MeshTraceEvent = {
  sequence: number
  timestamp: string
  level: MeshTraceLevel
  event: string
  [key: string]: unknown
}

const TRACE_LIMIT = 500
const events: MeshTraceEvent[] = []
let sequence = 0

export function meshTrace(event: string, detail: Record<string, unknown> = {}, level: MeshTraceLevel = "info") {
  const entry: MeshTraceEvent = {
    sequence: ++sequence,
    timestamp: new Date().toISOString(),
    level,
    event,
    ...detail,
  }
  events.push(entry)
  if (events.length > TRACE_LIMIT) events.splice(0, events.length - TRACE_LIMIT)

  const line = `[match.mesh] ${JSON.stringify(entry)}`
  if (level === "warn") console.warn(line)
  else console.info(line)
}

export function meshTraceSnapshot(): MeshTraceEvent[] {
  return events.map(event => ({ ...event }))
}

export function clearMeshTrace() {
  events.length = 0
  sequence = 0
}
