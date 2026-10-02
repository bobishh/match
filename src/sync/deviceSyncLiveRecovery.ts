import { formatSyncError, type DeviceSyncState, userMessage } from "./deviceSyncState"
import { meshTrace } from "./meshTrace"

type LiveSessionRecovery = {
  error: unknown
  terminalError?: unknown
  sessionRun: number
  currentRun: () => number
  supersede: () => number
  state: DeviceSyncState
  handoff: () => Promise<void>
}

export function recoverLiveSession(input: LiveSessionRecovery): Promise<void> {
  if (input.sessionRun !== input.currentRun()) return Promise.resolve()
  const reason = formatSyncError(input.error, "Live sync stopped.")
  const recoveryRun = input.supersede()
  meshTrace("live.session.failed", { runId: input.sessionRun, reason, recovery: "durable-mesh" }, "warn")
  input.state.step.value = input.terminalError === undefined ? "workspace-reconnecting" : "error"
  input.state.error.value = input.terminalError === undefined
    ? ""
    : userMessage(input.terminalError, "Workspace admission failed.")
  input.state.meshDiagnostic.value = `Direct session ended: ${reason}`
  return input.handoff().catch(error => {
    if (input.terminalError === undefined) reportRecoveryFailure(input, error, recoveryRun)
    else meshTrace("live.session.recovery.failed", { runId: recoveryRun, reason: formatSyncError(error, "Couldn’t restart live sync.") }, "warn")
  })
}

function reportRecoveryFailure(input: LiveSessionRecovery, error: unknown, recoveryRun: number) {
  if (recoveryRun !== input.currentRun()) return
  const reason = formatSyncError(error, "Couldn’t restart live sync.")
  meshTrace("live.session.recovery.failed", { runId: recoveryRun, reason }, "warn")
  input.state.step.value = "error"
  input.state.error.value = userMessage(error, "Couldn’t restart live sync.")
}
