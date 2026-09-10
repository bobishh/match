import { describe, expect, it, vi } from "vitest"
import {
  createMeshLeader,
  MeshLeader,
  type MeshLeaderBroadcastChannel,
  type MeshLeaderBroadcastMessage,
  type MeshLeaderEnvironment,
  type MeshLeaderLocks,
  type MeshLeaderStorage,
  type MeshLeaderWindow,
} from "./meshLeader"

// In-memory BroadcastChannel broker for multi-node simulation
class InMemoryBroadcastChannel implements MeshLeaderBroadcastChannel {
  private static channels = new Map<string, Set<InMemoryBroadcastChannel>>()

  name: string
  onmessage: ((ev: { data: MeshLeaderBroadcastMessage }) => void) | null = null

  constructor(name: string) {
    this.name = name
    let group = InMemoryBroadcastChannel.channels.get(name)
    if (!group) {
      group = new Set()
      InMemoryBroadcastChannel.channels.set(name, group)
    }
    group.add(this)
  }

  postMessage(message: MeshLeaderBroadcastMessage) {
    const group = InMemoryBroadcastChannel.channels.get(this.name)
    if (!group) return
    // Broadcast to other channels asynchronously like native BroadcastChannel
    queueMicrotask(() => {
      for (const ch of group!) {
        if (ch !== this && ch.onmessage) {
          ch.onmessage({ data: structuredClone(message) })
        }
      }
    })
  }

  close() {
    const group = InMemoryBroadcastChannel.channels.get(this.name)
    if (group) {
      group.delete(this)
      if (group.size === 0) {
        InMemoryBroadcastChannel.channels.delete(this.name)
      }
    }
  }

  static reset() {
    InMemoryBroadcastChannel.channels.clear()
  }
}

// In-memory Web Locks broker
class InMemoryLocks implements MeshLeaderLocks {
  private heldLocks = new Set<string>()

  async request(
    name: string,
    options: { mode: "exclusive"; ifAvailable?: boolean },
    callback: (lock: unknown | null) => Promise<unknown>,
  ): Promise<unknown> {
    if (this.heldLocks.has(name)) {
      if (options.ifAvailable) {
        return callback(null)
      }
      throw new Error("Lock queueing without ifAvailable not supported in mock")
    }

    this.heldLocks.add(name)
    try {
      return await callback({ name, mode: options.mode })
    } finally {
      this.heldLocks.delete(name)
    }
  }
}

// In-memory LocalStorage
class InMemoryStorage implements MeshLeaderStorage {
  private store = new Map<string, string>()

  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  clear() {
    this.store.clear()
  }
}

// Mock window for unload events
class InMemoryMockWindow implements MeshLeaderWindow {
  private listeners = new Map<string, Set<(ev: unknown) => void>>()

  addEventListener(type: string, listener: (ev: unknown) => void) {
    let list = this.listeners.get(type)
    if (!list) {
      list = new Set()
      this.listeners.set(type, list)
    }
    list.add(listener)
  }

  removeEventListener(type: string, listener: (ev: unknown) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  dispatchEvent(type: string) {
    const list = this.listeners.get(type)
    if (list) {
      for (const listener of list) {
        listener({ type })
      }
    }
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("MeshLeader integration (BDD outer loop)", () => {
  it("Given two nodes with Web Locks, when node 1 starts, it becomes leader; when node 2 starts, it queues as follower; when node 2 requests leadership, node 1 yields and node 2 acquires leadership", async () => {
    InMemoryBroadcastChannel.reset()
    const locks = new InMemoryLocks()

    let node1TaskRunning = false
    let node1TaskAborted = false
    let node2TaskRunning = false

    const leaderEvents1: boolean[] = []
    const leaderEvents2: boolean[] = []

    const env1: MeshLeaderEnvironment = {
      locks,
      BroadcastChannel: InMemoryBroadcastChannel,
      now: () => Date.now(),
    }

    const env2: MeshLeaderEnvironment = {
      locks,
      BroadcastChannel: InMemoryBroadcastChannel,
      now: () => Date.now(),
    }

    const node1 = new MeshLeader({ nodeId: "node-1", name: "test-mesh", env: env1 })
    const node2 = new MeshLeader({ nodeId: "node-2", name: "test-mesh", env: env2 })

    node1.subscribe((isLeader) => leaderEvents1.push(isLeader))
    node2.subscribe((isLeader) => leaderEvents2.push(isLeader))

    // Node 1 starts
    await node1.start(async (signal) => {
      node1TaskRunning = true
      signal.addEventListener("abort", () => {
        node1TaskAborted = true
        node1TaskRunning = false
      })
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")))
      }).catch(() => {})
    })

    expect(node1.isLeader).toBe(true)
    expect(node1TaskRunning).toBe(true)
    expect(leaderEvents1).toEqual([false, true])

    // Node 2 starts - should NOT acquire exclusive lock because node 1 holds it
    await node2.start(async (signal) => {
      node2TaskRunning = true
      signal.addEventListener("abort", () => {
        node2TaskRunning = false
      })
    })

    expect(node2.isLeader).toBe(false)
    expect(node2TaskRunning).toBe(false)
    expect(leaderEvents2).toEqual([false])

    // Node 2 requests leadership via BroadcastChannel
    await node2.requestLeadership()

    // Node 1 should have yielded and aborted its task
    expect(node1TaskAborted).toBe(true)
    expect(node1TaskRunning).toBe(false)
    expect(node1.isLeader).toBe(false)

    // Node 2 should now be leader and running its task
    expect(node2.isLeader).toBe(true)
    expect(node2TaskRunning).toBe(true)

    await node1.stop()
    await node2.stop()
  })

  it("Given browsers without Web Locks, elects leader via localStorage heartbeat and fails over when heartbeat is stale after 5s", async () => {
    InMemoryBroadcastChannel.reset()
    const storage = new InMemoryStorage()

    let simulatedTime = 10000

    const env1: MeshLeaderEnvironment = {
      locks: undefined, // No Web Locks
      localStorage: storage,
      BroadcastChannel: InMemoryBroadcastChannel,
      now: () => simulatedTime,
    }

    const env2: MeshLeaderEnvironment = {
      locks: undefined, // No Web Locks
      localStorage: storage,
      BroadcastChannel: InMemoryBroadcastChannel,
      now: () => simulatedTime,
    }

    let node1Running = false
    let node2Running = false

    const node1 = new MeshLeader({
      nodeId: "node-fb-1",
      name: "fb-mesh",
      env: env1,
      staleTimeoutMs: 5000,
      heartbeatIntervalMs: 1000,
      retryDelayMs: 20,
    })
    const node2 = new MeshLeader({
      nodeId: "node-fb-2",
      name: "fb-mesh",
      env: env2,
      staleTimeoutMs: 5000,
      heartbeatIntervalMs: 1000,
      retryDelayMs: 20,
    })

    await node1.start(async (signal) => {
      node1Running = true
      signal.addEventListener("abort", () => {
        node1Running = false
      })
    })

    expect(node1.isLeader).toBe(true)
    expect(node1Running).toBe(true)

    await node2.start(async (signal) => {
      node2Running = true
      signal.addEventListener("abort", () => {
        node2Running = false
      })
    })

    expect(node2.isLeader).toBe(false)
    expect(node2Running).toBe(false)

    // Node 1 stops emitting heartbeats (simulating node crash / hang without graceful stop)
    // Advance time by 5001ms
    simulatedTime += 5001

    // Wait for retry evaluation on node 2
    await delay(50)

    // Node 2 detects stale lease (>5s) and claims leadership
    expect(node2.isLeader).toBe(true)
    expect(node2Running).toBe(true)

    await node1.stop()
    await node2.stop()
  })
})

describe("MeshLeader unit specifications", () => {
  it("subscription notifies initial value immediately and changes over time with unsubscribe support", async () => {
    InMemoryBroadcastChannel.reset()
    const locks = new InMemoryLocks()
    const env: MeshLeaderEnvironment = {
      locks,
      BroadcastChannel: InMemoryBroadcastChannel,
    }

    const leader = new MeshLeader({ env, nodeId: "sub-node" })
    const history: boolean[] = []
    const unsubscribe = leader.subscribe((isLeader) => {
      history.push(isLeader)
    })

    // Immediately notified of current state (false)
    expect(history).toEqual([false])

    await leader.start(() => {})
    expect(history).toEqual([false, true])

    // Unsubscribe
    unsubscribe()

    await leader.stop()
    // Should NOT receive false because it unsubscribed
    expect(history).toEqual([false, true])
  })

  it("onLeaderChange alias mirrors subscribe behavior", async () => {
    InMemoryBroadcastChannel.reset()
    const locks = new InMemoryLocks()
    const leader = new MeshLeader({ env: { locks, BroadcastChannel: InMemoryBroadcastChannel } })

    let current = false
    const unsub = leader.onLeaderChange((isLeader) => {
      current = isLeader
    })
    expect(current).toBe(false)

    await leader.start(() => {})
    expect(current).toBe(true)

    unsub()
    await leader.stop()
  })

  it("task signal is aborted when node stops", async () => {
    InMemoryBroadcastChannel.reset()
    const locks = new InMemoryLocks()
    const leader = new MeshLeader({ env: { locks, BroadcastChannel: InMemoryBroadcastChannel } })

    let aborted = false
    await leader.start((signal) => {
      signal.addEventListener("abort", () => {
        aborted = true
      })
    })

    expect(leader.isLeader).toBe(true)
    expect(aborted).toBe(false)

    await leader.stop()
    expect(leader.isLeader).toBe(false)
    expect(aborted).toBe(true)
  })

  it("handles unload event on window: releases lock, aborts task, and notifies followers", async () => {
    InMemoryBroadcastChannel.reset()
    const locks = new InMemoryLocks()
    const win1 = new InMemoryMockWindow()
    const win2 = new InMemoryMockWindow()

    const env1: MeshLeaderEnvironment = {
      locks,
      BroadcastChannel: InMemoryBroadcastChannel,
      window: win1,
    }
    const env2: MeshLeaderEnvironment = {
      locks,
      BroadcastChannel: InMemoryBroadcastChannel,
      window: win2,
    }

    let task1Aborted = false
    const node1 = new MeshLeader({ nodeId: "n1", name: "unload-test", env: env1 })
    const node2 = new MeshLeader({ nodeId: "n2", name: "unload-test", env: env2 })

    await node1.start((signal) => {
      signal.addEventListener("abort", () => {
        task1Aborted = true
      })
    })

    await node2.start(() => {})
    expect(node1.isLeader).toBe(true)
    expect(node2.isLeader).toBe(false)

    // Simulate window beforeunload event on node 1
    win1.dispatchEvent("beforeunload")

    expect(task1Aborted).toBe(true)

    // Wait for microtask broadcast
    await delay(30)

    // Node 2 should have acquired leadership on leader release
    expect(node2.isLeader).toBe(true)

    await node1.stop()
    await node2.stop()
  })

  it("maintains queued followers order across multiple tabs", async () => {
    InMemoryBroadcastChannel.reset()
    const locks = new InMemoryLocks()

    const node1 = new MeshLeader({ nodeId: "leader-1", name: "queue-test", env: { locks, BroadcastChannel: InMemoryBroadcastChannel } })
    const node2 = new MeshLeader({ nodeId: "follower-2", name: "queue-test", env: { locks, BroadcastChannel: InMemoryBroadcastChannel } })
    const node3 = new MeshLeader({ nodeId: "follower-3", name: "queue-test", env: { locks, BroadcastChannel: InMemoryBroadcastChannel } })

    await node1.start(() => {})
    await node2.start(() => {})
    await node3.start(() => {})

    // Allow microtasks for follower-queued messages to propagate
    await delay(20)

    expect(node1.queuedFollowers).toEqual(["follower-2", "follower-3"])

    // Follower 2 stops, should be removed from queue
    await node2.stop()
    await delay(20)

    expect(node1.queuedFollowers).toEqual(["follower-3"])

    // Leader 1 stops, next queued follower (follower-3) gets elected
    await node1.stop()
    await delay(30)

    expect(node3.isLeader).toBe(true)

    await node3.stop()
  })

  it("requestLeadership on an already-leader node resolves immediately", async () => {
    InMemoryBroadcastChannel.reset()
    const locks = new InMemoryLocks()
    const node = new MeshLeader({ env: { locks, BroadcastChannel: InMemoryBroadcastChannel } })

    await node.start(() => {})
    expect(node.isLeader).toBe(true)

    await expect(node.requestLeadership()).resolves.toBeUndefined()
    expect(node.isLeader).toBe(true)

    await node.stop()
  })

  it("requestLeadership on stopped node rejects with error", async () => {
    InMemoryBroadcastChannel.reset()
    const locks = new InMemoryLocks()
    const node = new MeshLeader({ env: { locks, BroadcastChannel: InMemoryBroadcastChannel } })

    await node.start(() => {})
    await node.stop()

    await expect(node.requestLeadership()).rejects.toThrow("Cannot request leadership on stopped MeshLeader")
  })

  it("start on stopped node throws error", async () => {
    InMemoryBroadcastChannel.reset()
    const locks = new InMemoryLocks()
    const node = new MeshLeader({ env: { locks, BroadcastChannel: InMemoryBroadcastChannel } })

    await node.stop()
    await expect(node.start(() => {})).rejects.toThrow("Cannot start stopped MeshLeader")
  })

  it("start is idempotent when called multiple times on active leader", async () => {
    InMemoryBroadcastChannel.reset()
    const locks = new InMemoryLocks()
    const node = new MeshLeader({ env: { locks, BroadcastChannel: InMemoryBroadcastChannel } })

    await node.start(() => {})
    await node.start(() => {}) // Second call should be no-op

    expect(node.isLeader).toBe(true)
    await node.stop()
  })

  it("gracefully catches task error without crashing leader lifecycle", async () => {
    InMemoryBroadcastChannel.reset()
    const locks = new InMemoryLocks()
    const node = new MeshLeader({ env: { locks, BroadcastChannel: InMemoryBroadcastChannel } })

    await node.start(async () => {
      throw new Error("Task runtime error")
    })

    expect(node.isLeader).toBe(true)
    await node.stop()
    expect(node.isLeader).toBe(false)
  })

  it("fallback mode: stop removes lease immediately and yields without waiting 5s", async () => {
    InMemoryBroadcastChannel.reset()
    const storage = new InMemoryStorage()
    let now = 5000

    const env1: MeshLeaderEnvironment = {
      localStorage: storage,
      BroadcastChannel: InMemoryBroadcastChannel,
      now: () => now,
    }
    const env2: MeshLeaderEnvironment = {
      localStorage: storage,
      BroadcastChannel: InMemoryBroadcastChannel,
      now: () => now,
    }

    const node1 = new MeshLeader({ nodeId: "fb-stop-1", name: "stop-mesh", env: env1 })
    const node2 = new MeshLeader({ nodeId: "fb-stop-2", name: "stop-mesh", env: env2, retryDelayMs: 20 })

    await node1.start(() => {})
    await node2.start(() => {})

    expect(node1.isLeader).toBe(true)
    expect(node2.isLeader).toBe(false)
    expect(storage.getItem("stop-mesh")).not.toBeNull()

    // When node 1 stops gracefully, it removes its lease and yields via broadcast
    await node1.stop()

    // Node 2 should acquire immediately via broadcast and take over lease
    expect(node2.isLeader).toBe(true)
    expect(JSON.parse(storage.getItem("stop-mesh")!).leaderId).toBe("fb-stop-2")

    await node2.stop()
  })

  it("fallback mode: unload removes lease and hands over to follower", async () => {
    InMemoryBroadcastChannel.reset()
    const storage = new InMemoryStorage()
    const win1 = new InMemoryMockWindow()

    const env1: MeshLeaderEnvironment = {
      localStorage: storage,
      BroadcastChannel: InMemoryBroadcastChannel,
      window: win1,
    }
    const env2: MeshLeaderEnvironment = {
      localStorage: storage,
      BroadcastChannel: InMemoryBroadcastChannel,
    }

    const node1 = new MeshLeader({ nodeId: "fb-unl-1", name: "fb-unl", env: env1 })
    const node2 = new MeshLeader({ nodeId: "fb-unl-2", name: "fb-unl", env: env2, retryDelayMs: 20 })

    await node1.start(() => {})
    await node2.start(() => {})

    expect(node1.isLeader).toBe(true)
    expect(node2.isLeader).toBe(false)

    win1.dispatchEvent("pagehide")
    expect(storage.getItem("fb-unl")).toBeNull()

    await delay(30)
    expect(node2.isLeader).toBe(true)

    await node1.stop()
    await node2.stop()
  })

  it("strictly enforces one node task at a time across multiple leader transitions", async () => {
    InMemoryBroadcastChannel.reset()
    const locks = new InMemoryLocks()

    let activeTaskCount = 0
    let maxActiveTaskCount = 0

    const makeTask = (nodeId: string) => async (signal: AbortSignal) => {
      activeTaskCount++
      if (activeTaskCount > maxActiveTaskCount) {
        maxActiveTaskCount = activeTaskCount
      }
      signal.addEventListener("abort", () => {
        activeTaskCount--
      })
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")))
      }).catch(() => {})
    }

    const env = { locks, BroadcastChannel: InMemoryBroadcastChannel }
    const nodeA = new MeshLeader({ nodeId: "node-A", name: "one-task-mesh", env })
    const nodeB = new MeshLeader({ nodeId: "node-B", name: "one-task-mesh", env })
    const nodeC = new MeshLeader({ nodeId: "node-C", name: "one-task-mesh", env })

    await nodeA.start(makeTask("node-A"))
    await nodeB.start(makeTask("node-B"))
    await nodeC.start(makeTask("node-C"))

    expect(activeTaskCount).toBe(1)
    expect(maxActiveTaskCount).toBe(1)

    // Handover to B
    await nodeB.requestLeadership()
    expect(activeTaskCount).toBe(1)
    expect(maxActiveTaskCount).toBe(1)

    // Handover to C
    await nodeC.requestLeadership()
    expect(activeTaskCount).toBe(1)
    expect(maxActiveTaskCount).toBe(1)

    // Stop active leader C
    await nodeC.stop()
    await delay(30)
    expect(activeTaskCount).toBe(1)
    expect(maxActiveTaskCount).toBe(1)

    await nodeA.stop()
    await nodeB.stop()
    expect(activeTaskCount).toBe(0)
  })

  it("fallback mode: supports explicit yield via requestLeadership", async () => {
    InMemoryBroadcastChannel.reset()
    const storage = new InMemoryStorage()

    const env1: MeshLeaderEnvironment = {
      localStorage: storage,
      BroadcastChannel: InMemoryBroadcastChannel,
    }
    const env2: MeshLeaderEnvironment = {
      localStorage: storage,
      BroadcastChannel: InMemoryBroadcastChannel,
    }

    let node1Running = false
    let node2Running = false

    const node1 = new MeshLeader({ nodeId: "fb-yield-1", name: "fb-yield-mesh", env: env1 })
    const node2 = new MeshLeader({ nodeId: "fb-yield-2", name: "fb-yield-mesh", env: env2 })

    await node1.start((signal) => {
      node1Running = true
      signal.addEventListener("abort", () => {
        node1Running = false
      })
    })

    await node2.start((signal) => {
      node2Running = true
      signal.addEventListener("abort", () => {
        node2Running = false
      })
    })

    expect(node1.isLeader).toBe(true)
    expect(node1Running).toBe(true)
    expect(node2.isLeader).toBe(false)
    expect(node2Running).toBe(false)

    // Node 2 explicitly requests leadership in fallback mode
    await node2.requestLeadership()

    expect(node1.isLeader).toBe(false)
    expect(node1Running).toBe(false)
    expect(node2.isLeader).toBe(true)
    expect(node2Running).toBe(true)

    await node1.stop()
    await node2.stop()
  })

  it("fallback mode: lease is not stale at 4900ms, but becomes stale after 5000ms", async () => {
    InMemoryBroadcastChannel.reset()
    const storage = new InMemoryStorage()
    let now = 10000

    const env: MeshLeaderEnvironment = {
      localStorage: storage,
      BroadcastChannel: InMemoryBroadcastChannel,
      now: () => now,
    }

    const node1 = new MeshLeader({ nodeId: "fb-stale-1", name: "stale-boundary", env, staleTimeoutMs: 5000 })
    const node2 = new MeshLeader({ nodeId: "fb-stale-2", name: "stale-boundary", env, staleTimeoutMs: 5000, retryDelayMs: 20 })

    await node1.start(() => {})
    await node2.start(() => {})

    expect(node1.isLeader).toBe(true)
    expect(node2.isLeader).toBe(false)

    // Advance 4900ms (less than 5s)
    now += 4900
    await delay(30)
    expect(node2.isLeader).toBe(false)

    // Advance beyond 5000ms
    now += 150
    await delay(30)
    expect(node2.isLeader).toBe(true)

    await node1.stop()
    await node2.stop()
  })

  it("createMeshLeader helper instantiates MeshLeader", () => {
    const leader = createMeshLeader({ name: "helper-test" })
    expect(leader).toBeInstanceOf(MeshLeader)
    expect(leader.lockName).toBe("helper-test")
  })
})
