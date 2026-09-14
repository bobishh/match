import { MeshTraceBuffer, type MeshTraceEvent, type MeshTraceLevel } from "@meta-uber/mesh-transport"

export type { MeshTraceEvent, MeshTraceLevel }

const traceBuffer = new MeshTraceBuffer("match.mesh")

export function meshTrace(event: string, detail: Record<string, unknown> = {}, level: MeshTraceLevel = "info") {
  traceBuffer.trace(event, detail, level)
}

export function meshTraceSnapshot(): MeshTraceEvent[] {
  return traceBuffer.snapshot()
}

export function clearMeshTrace() {
  traceBuffer.clear()
}
