const queues = new Map<string, Promise<void>>()

/** Serialize read-modify-write operations on one local-state key across tabs and this JS realm. */
export async function withLocalStateWriteLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const lockName = `tincanban.local-state.write:${key}`
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks
  if (locks) {
    return new Promise<T>((resolve, reject) => {
      void locks.request(lockName, { mode: "exclusive" }, async () => operation()).then(resolve, reject)
    })
  }
  const previous = queues.get(lockName) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  queues.set(lockName, result.then(() => undefined, () => undefined))
  return result
}
