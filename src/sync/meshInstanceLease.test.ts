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
})
