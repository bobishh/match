import { describe, expect, it } from "vitest"
import { MeshNetworkError, MeshTerminalError } from "@meta-uber/mesh-transport"
import { diagnosticErrorCode } from "./failureDiagnostic"
import { diagnosticEvent } from "./telemetryEvent"

const context = { project: "tincanban", sessionId: "session", deviceId: "device", timestamp: Date.now(), level: "warn" }

describe("safe failure diagnostics", () => {
  it.each([
    [new MeshNetworkError("private network endpoint"), "MeshNetworkError"],
    [new MeshTerminalError("private authority value"), "MeshTerminalError"],
    [Object.assign(new Error("private record"), { name: "WorkspaceChangeRejected" }), "WorkspaceChangeRejected"],
    [new DOMException("private storage contents", "QuotaExceededError"), "QuotaExceededError"],
    [new AggregateError([new MeshNetworkError("private route one"), new MeshNetworkError("private route two")]), "MeshNetworkError"],
    [new AggregateError([new MeshNetworkError("private route"), new MeshTerminalError("private authority")]), "AggregateError"],
  ])("Given a typed failure, When telemetry encodes it, Then its code survives without private error content", async (error, code) => {
    const event = await diagnosticEvent("workspace.frame.rejected", {
      error, reason: String(error),
    }, context)
    expect(event.attrs.error_code).toBe(code)
    expect(JSON.stringify(event)).not.toContain("private")
  })

  it("Given a wrapped network failure, When classified, Then the underlying type remains visible", () => {
    const error = new Error("Workspace board-title snapshot failed", { cause: new MeshNetworkError("private peer") })
    expect(diagnosticErrorCode(error)).toBe("MeshNetworkError")
  })

  it("Given an unknown or cyclic failure, When classified, Then no dynamic name or content is exposed", () => {
    const unknown = Object.assign(new Error("private body"), { name: "PrivateUserValue" })
    const cycle = new Error("private cycle")
    cycle.cause = cycle
    expect(diagnosticErrorCode(unknown)).toBe("UnknownError")
    expect(diagnosticErrorCode(cycle)).toBe("UnknownError")
    expect(diagnosticErrorCode("private body")).toBe("UnknownError")
  })
})
