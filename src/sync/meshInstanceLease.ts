export interface MeshInstanceLocks {
  request(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown | null) => Promise<void>,
  ): Promise<unknown>
}

export type MeshInstanceLease = {
  instanceId: string
  release: () => Promise<void>
}

type MeshInstanceLeaseOptions = {
  locks?: MeshInstanceLocks
  preferredInstanceId?: string | null
  slots?: number
}

const LOCK_PREFIX = "match:mesh-instance:"
const LEGACY_LEADER_LOCK = "match:mesh-leader"

export async function acquireMeshInstanceLease(options: MeshInstanceLeaseOptions = {}): Promise<MeshInstanceLease> {
  const locks = options.locks ?? (typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks as MeshInstanceLocks : undefined)
  if (!locks) {
    const preferred = options.preferredInstanceId
    const instanceId = preferred && /^(?:slot-\d+|ephemeral-[0-9a-f-]{36})$/.test(preferred)
      ? preferred : `ephemeral-${crypto.randomUUID()}`
    return { instanceId, release: async () => {} }
  }

  const count = options.slots ?? 32
  const preferred = options.preferredInstanceId?.match(/^slot-(\d+)$/)?.[1]
  const slots = [...new Set([
    ...(preferred === undefined ? [] : [Number(preferred)]),
    ...Array.from({ length: count }, (_, index) => index),
  ])].filter(slot => slot >= 0 && slot < count)

  for (const slot of slots) {
    let releaseLock: (() => void) | undefined
    let resolveAttempt!: (acquired: boolean) => void
    const attempted = new Promise<boolean>(resolve => { resolveAttempt = resolve })
    const completion = locks.request(`${LOCK_PREFIX}${slot}`, { mode: "exclusive", ifAvailable: true }, async lock => {
      if (!lock) return resolveAttempt(false)
      if (slot === 0) {
        let resolveLegacyAttempt!: (acquired: boolean) => void
        const legacyAttempted = new Promise<boolean>(resolve => { resolveLegacyAttempt = resolve })
        const legacyCompletion = locks.request(LEGACY_LEADER_LOCK, { mode: "exclusive", ifAvailable: true }, async legacyLock => {
          if (!legacyLock) return resolveLegacyAttempt(false)
          await new Promise<void>(resolve => {
            releaseLock = resolve
            resolveLegacyAttempt(true)
          })
        })
        if (!await legacyAttempted) {
          await legacyCompletion
          return resolveAttempt(false)
        }
        resolveAttempt(true)
        await legacyCompletion
        return
      }
      await new Promise<void>(resolve => {
        releaseLock = resolve
        resolveAttempt(true)
      })
    })
    if (await attempted) return { instanceId: `slot-${slot}`, release: async () => {
      releaseLock?.()
      await completion
    } }
  }

  return { instanceId: `ephemeral-${crypto.randomUUID()}`, release: async () => {} }
}
