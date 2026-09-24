import { formatSyncError, type DeviceSyncState, userMessage } from "./deviceSyncState"
import { meshTrace } from "./meshTrace"

type LiveSessionRecovery = {
  error: unknown
  sessionRun: number
  currentRun: () => number
  supersede: () => number
  state: DeviceSyncState
  handoff: () => Promise<void>
}

export function recoverLiveSession(input: LiveSessionRecovery) {
  if (input.sessionRun !== input.currentRun()) return
  const reason = formatSyncError(input.error, "Live sync stopped.")
  const recoveryRun = input.supersede()
  meshTrace("live.session.failed", { runId: input.sessionRun, reason, recovery: "durable-mesh" }, "warn")
  input.state.step.value = "workspace-reconnecting"
  input.state.error.value = ""
  input.state.meshDiagnostic.value = `Direct session ended: ${reason}`
  void input.handoff().catch(error => reportRecoveryFailure(input, error, recoveryRun))
}

function reportRecoveryFailure(input: LiveSessionRecovery, error: unknown, recoveryRun: number) {
  if (recoveryRun !== input.currentRun()) return
  const reason = formatSyncError(error, "Couldn’t restart live sync.")
  meshTrace("live.session.recovery.failed", { runId: recoveryRun, reason }, "warn")
  input.state.step.value = "error"
  input.state.error.value = userMessage(error, "Couldn’t restart live sync.")
}
