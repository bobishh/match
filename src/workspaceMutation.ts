// All read/modify/commit operations for one workspace share this boundary.
// Web Locks coordinate independent tabs; the queue also covers non-browser tests.
const queues = new Map<string, Promise<unknown>>()

export function withWorkspaceMutation<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(workspaceId) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(() => {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request(`tincanban-workspace-command:${workspaceId}`, operation)
    }
    if (typeof indexedDB !== "undefined") {
      throw new Error("Workspace writes require cross-tab locking support")
    }
    return operation()
  })
  queues.set(workspaceId, current)
  const cleanup = () => { if (queues.get(workspaceId) === current) queues.delete(workspaceId) }
  void current.then(cleanup, cleanup)
  return current
}
