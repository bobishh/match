import { describe, expect, it } from "vitest"
import { createDeviceSyncState } from "./deviceSyncState"
import { recoverLiveSession } from "./deviceSyncLiveRecovery"

describe("live session recovery", () => {
  it("keeps a terminal admission cause visible when durable mesh handoff fails", async () => {
    const state = createDeviceSyncState()
    const admissionError = new Error("Snapshot preparation failed")
    let run = 4

    await recoverLiveSession({
      error: admissionError,
      terminalError: admissionError,
      sessionRun: run,
      currentRun: () => run,
      supersede: () => ++run,
      state,
      handoff: async () => { throw new Error("Mesh restart failed") },
    })

    expect(state.step.value).toBe("error")
    expect(state.error.value).toBe("Snapshot preparation failed")
  })
})
