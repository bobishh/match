import { MeshTraceBuffer, type MeshTraceEvent, type MeshTraceLevel } from "@meta-uber/mesh-transport"

export type { MeshTraceEvent, MeshTraceLevel }

let verboseConsoleLogging = false
const traceBuffer = new MeshTraceBuffer("match.mesh", 500, {
  info: line => { if (verboseConsoleLogging) console.info(line) },
  warn: line => console.warn(line),
})

/** Keeps routine mesh events out of the console while retaining them for diagnostic snapshots. */
export function setMeshTraceVerboseLogging(enabled: boolean) {
  verboseConsoleLogging = enabled
}

export function meshTrace(event: string, detail: Record<string, unknown> = {}, level: MeshTraceLevel = "info") {
  traceBuffer.trace(event, detail, level)
}

export function meshTraceSnapshot(): MeshTraceEvent[] {
  return traceBuffer.snapshot()
}

export function clearMeshTrace() {
  traceBuffer.clear()
}
