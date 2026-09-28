import type { DeviceSyncState } from "./deviceSyncState"

export type JoinDecision = { role: "visitor" | "editor"; followOwner: boolean }

export function createDeviceSyncJoinApproval(state: Pick<DeviceSyncState, "pendingJoins" | "isOpen" | "step">) {
  const decisions = new Map<string, (decision: JoinDecision | null) => void>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function decideJoin(id: string, approve: boolean) {
    const request = state.pendingJoins.value.find(item => item.id === id)
    decisions.get(id)?.(approve ? { role: request?.role ?? "visitor",
      followOwner: request?.ownerConnectionRequested === true && request.followOwner === true } : null)
    decisions.delete(id)
    clearTimeout(timers.get(id))
    timers.delete(id)
    state.pendingJoins.value = state.pendingJoins.value.filter(item => item.id !== id)
  }

  function waitForJoinDecision(personId: string, name: string, ownerConnectionRequested = false) {
    const requestId = crypto.randomUUID()
    state.pendingJoins.value.push({ id: requestId, personId, name, role: "visitor", ownerConnectionRequested, followOwner: false })
    state.isOpen.value = true
    state.step.value = "workspace-host"
    return new Promise<JoinDecision | null>(resolve => {
      decisions.set(requestId, resolve)
      timers.set(requestId, setTimeout(() => decideJoin(requestId, false), 600_000))
    })
  }

  function cancelPending() {
    for (const resolve of decisions.values()) resolve(null)
    for (const timer of timers.values()) clearTimeout(timer)
    decisions.clear()
    timers.clear()
    state.pendingJoins.value = []
  }

  return { decideJoin, waitForJoinDecision, cancelPending }
}
