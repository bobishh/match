import { beforeEach, describe, expect, it, vi } from "vitest"
import { clearMeshTrace, meshTrace, meshTraceSnapshot } from "./meshTrace"

describe("mesh trace", () => {
  beforeEach(() => clearMeshTrace())

  it("Given a connection lifecycle, when events are traced, then ordered correlation data remains inspectable", () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})

    meshTrace("node.start", { tabId: "tab-1", runId: 3, endpoint: "endpoint-a" })
    meshTrace("dial.start", { tabId: "tab-1", runId: 3, connectionId: "c-1", peerId: "peer-b", mode: "relay" })
    meshTrace("session.closed", { tabId: "tab-1", runId: 3, connectionId: "c-1", peerId: "peer-b", reason: "connection lost" }, "warn")

    expect(meshTraceSnapshot()).toEqual([
      expect.objectContaining({ sequence: 1, event: "node.start", tabId: "tab-1", runId: 3 }),
      expect.objectContaining({ sequence: 2, event: "dial.start", connectionId: "c-1", mode: "relay" }),
      expect.objectContaining({ sequence: 3, event: "session.closed", reason: "connection lost", level: "warn" }),
    ])
  })

  it("Given more than the trace limit, when inspected, then only the newest bounded events remain", () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    for (let index = 0; index < 520; index += 1) meshTrace("heartbeat", { index })

    const events = meshTraceSnapshot()
    expect(events).toHaveLength(500)
    expect(events[0]?.index).toBe(20)
    expect(events.at(-1)?.index).toBe(519)
  })
})
