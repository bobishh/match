import { describe, expect, it } from "vitest"
import { acquireMeshInstanceLease, type MeshInstanceLocks } from "./meshInstanceLease"

class FakeLocks implements MeshInstanceLocks {
  private held = new Set<string>()

  async request(name: string, _options: { mode: "exclusive"; ifAvailable: true }, callback: (lock: unknown | null) => Promise<void>) {
    if (this.held.has(name)) return callback(null)
    this.held.add(name)
    try { await callback({ name }) } finally { this.held.delete(name) }
  }
}

describe("mesh transport instance lease", () => {
  it("Given multiple tabs, when slots are acquired and one closes, then each live tab is unique and freed endpoint identity is reused", async () => {
    const locks = new FakeLocks()
    const first = await acquireMeshInstanceLease({ locks })
    const second = await acquireMeshInstanceLease({ locks })

    expect(first.instanceId).toBe("slot-0")
    expect(second.instanceId).toBe("slot-1")

    await first.release()
    const replacement = await acquireMeshInstanceLease({ locks })
    expect(replacement.instanceId).toBe("slot-0")

    await second.release()
    await replacement.release()
  })

  it("Given Web Locks are unavailable, when one tab reloads, then its session instance identity stays stable", async () => {
    const instanceId = "ephemeral-8cc6b3bb-fdee-42c4-8d58-57ad04f47303"
    const first = await acquireMeshInstanceLease({ locks: undefined, preferredInstanceId: instanceId })

    expect(first.instanceId).toBe(instanceId)
    await first.release()
  })

  it("Given the previous bundle still owns its legacy endpoint, when the new bundle starts, then it uses another instance slot", async () => {
    const locks = new FakeLocks()
    let releaseLegacy!: () => void
    let markLegacyReady!: () => void
    const legacyReady = new Promise<void>(resolve => { markLegacyReady = resolve })
    const legacyTask = locks.request("match:mesh-leader", { mode: "exclusive", ifAvailable: true }, async lock => {
      expect(lock).not.toBeNull()
      markLegacyReady()
      await new Promise<void>(resolve => { releaseLegacy = resolve })
    })
    await legacyReady

    const upgraded = await acquireMeshInstanceLease({ locks })
    expect(upgraded.instanceId).toBe("slot-1")

    await upgraded.release()
    releaseLegacy()
    await legacyTask
  })
})
