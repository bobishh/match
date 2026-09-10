export type LeaderTask = (signal: AbortSignal) => Promise<void> | void
export type LeaderSubscription = (isLeader: boolean) => void

export interface MeshLeaderLocks {
  request(
    name: string,
    options: { mode: "exclusive"; ifAvailable?: boolean },
    callback: (lock: unknown | null) => Promise<unknown>,
  ): Promise<unknown>
}

export interface MeshLeaderStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface MeshLeaderBroadcastMessage {
  type:
    | "follower-queued"
    | "follower-dequeued"
    | "yield-request"
    | "leader-yielded"
    | "leader-released"
    | "heartbeat"
  senderId: string
  targetId?: string
  timestamp: number
}

export interface MeshLeaderBroadcastChannel {
  name: string
  onmessage: ((ev: { data: MeshLeaderBroadcastMessage }) => void) | null
  postMessage(message: MeshLeaderBroadcastMessage): void
  close(): void
}

export interface MeshLeaderWindow {
  addEventListener(type: string, listener: (event: unknown) => void): void
  removeEventListener(type: string, listener: (event: unknown) => void): void
}

export interface MeshLeaderEnvironment {
  locks?: MeshLeaderLocks
  BroadcastChannel?: new (name: string) => MeshLeaderBroadcastChannel
  localStorage?: MeshLeaderStorage
  window?: MeshLeaderWindow
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (id: unknown) => void
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (id: unknown) => void
  now?: () => number
  randomUUID?: () => string
}

export interface MeshLeaderOptions {
  name?: string
  nodeId?: string
  env?: MeshLeaderEnvironment
  staleTimeoutMs?: number
  heartbeatIntervalMs?: number
  retryDelayMs?: number
}

interface LocalStorageLease {
  leaderId: string
  heartbeat: number
}

function getDefaultEnvironment(): Required<MeshLeaderEnvironment> {
  return {
    locks: typeof navigator !== "undefined" && "locks" in navigator ? (navigator.locks as MeshLeaderLocks) : (undefined as any),
    BroadcastChannel: typeof BroadcastChannel !== "undefined" ? (BroadcastChannel as any) : (undefined as any),
    localStorage: typeof localStorage !== "undefined" ? localStorage : (undefined as any),
    window: typeof window !== "undefined" ? (window as MeshLeaderWindow) : (undefined as any),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: any) => clearTimeout(id),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: any) => clearInterval(id),
    now: () => Date.now(),
    randomUUID: () => {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID()
      }
      return "node-" + Math.random().toString(36).substring(2, 11)
    },
  }
}

export class MeshLeader {
  readonly lockName: string
  readonly nodeId: string
  private readonly env: Required<MeshLeaderEnvironment>
  readonly staleTimeoutMs: number
  readonly heartbeatIntervalMs: number
  readonly retryDelayMs: number

  private _isLeader = false
  private _lastEmittedState = false
  private _started = false
  private _stopped = false

  private task: LeaderTask | null = null
  private subscribers = new Set<LeaderSubscription>()
  private _queuedFollowers: string[] = []

  private currentAbortController: AbortController | null = null
  private releaseLockCallback: (() => void) | null = null
  private channel: MeshLeaderBroadcastChannel | null = null

  private heartbeatTimer: unknown = null
  private staleCheckTimer: unknown = null
  private retryTimer: unknown = null

  private pendingLeadershipRequests: Array<{
    resolve: () => void
    reject: (err: Error) => void
  }> = []

  constructor(options?: MeshLeaderOptions) {
    const defaults = getDefaultEnvironment()
    this.env = {
      ...defaults,
      ...(options?.env ?? {}),
    }

    this.lockName = options?.name ?? "match:mesh-leader"
    this.nodeId = options?.nodeId ?? this.env.randomUUID()
    this.staleTimeoutMs = options?.staleTimeoutMs ?? 5000
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 1500
    this.retryDelayMs = options?.retryDelayMs ?? 100
  }

  get isLeader(): boolean {
    return this._isLeader
  }

  get queuedFollowers(): string[] {
    return [...this._queuedFollowers]
  }

  subscribe(listener: LeaderSubscription): () => void {
    this.subscribers.add(listener)
    listener(this._isLeader)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  onLeaderChange(listener: LeaderSubscription): () => void {
    return this.subscribe(listener)
  }

  async start(task: LeaderTask): Promise<void> {
    if (this._stopped) {
      throw new Error("Cannot start stopped MeshLeader")
    }
    if (this._started) {
      return
    }
    this._started = true
    this.task = task

    this.initBroadcastChannel()
    this.initUnloadHandler()

    await this.attemptElection()
  }

  async requestLeadership(): Promise<void> {
    if (this._stopped) {
      throw new Error("Cannot request leadership on stopped MeshLeader")
    }
    if (this._isLeader) {
      return
    }

    return new Promise<void>((resolve, reject) => {
      this.pendingLeadershipRequests.push({ resolve, reject })

      // Explicit yield request via BroadcastChannel
      this.channel?.postMessage({
        type: "yield-request",
        senderId: this.nodeId,
        timestamp: this.env.now(),
      })

      // Also try election immediately
      this.attemptElection().catch(() => {})
    })
  }

  async stop(): Promise<void> {
    if (this._stopped) return
    this._stopped = true
    this._started = false

    this.removeUnloadHandler()
    this.clearTimers()

    if (this._isLeader) {
      const nextTarget = this._queuedFollowers.shift()
      await this.stepDown(nextTarget)
    } else {
      this.channel?.postMessage({
        type: "follower-dequeued",
        senderId: this.nodeId,
        timestamp: this.env.now(),
      })
    }

    if (this.channel) {
      this.channel.close()
      this.channel = null
    }

    const pending = this.pendingLeadershipRequests.splice(0)
    for (const p of pending) {
      p.reject(new Error("MeshLeader stopped before acquiring leadership"))
    }
  }

  private initBroadcastChannel() {
    if (!this.env.BroadcastChannel) return
    this.channel = new this.env.BroadcastChannel(this.lockName)
    this.channel.onmessage = ({ data }) => {
      this.handleBroadcastMessage(data)
    }
  }

  private initUnloadHandler() {
    if (this.env.window) {
      this.env.window.addEventListener("beforeunload", this.handleUnload)
      this.env.window.addEventListener("pagehide", this.handleUnload)
    }
  }

  private removeUnloadHandler() {
    if (this.env.window) {
      this.env.window.removeEventListener("beforeunload", this.handleUnload)
      this.env.window.removeEventListener("pagehide", this.handleUnload)
    }
  }

  private handleUnload = () => {
    if (this._isLeader) {
      this._isLeader = false
      this.clearLeaderTimers()
      this.currentAbortController?.abort()
      this.currentAbortController = null

      if (this.isFallbackMode) {
        this.clearFallbackLease()
      }

      const releaseCallback = this.releaseLockCallback
      this.releaseLockCallback = null
      releaseCallback?.()

      const nextTarget = this._queuedFollowers.shift()
      this.channel?.postMessage({
        type: "leader-released",
        senderId: this.nodeId,
        targetId: nextTarget,
        timestamp: this.env.now(),
      })

      this.notifySubscribers()
    } else {
      this.channel?.postMessage({
        type: "follower-dequeued",
        senderId: this.nodeId,
        timestamp: this.env.now(),
      })
    }
  }

  private get isFallbackMode(): boolean {
    return !this.env.locks
  }

  private handleBroadcastMessage(message: MeshLeaderBroadcastMessage) {
    if (this._stopped || !message) return

    switch (message.type) {
      case "follower-queued": {
        if (message.senderId !== this.nodeId && !this._queuedFollowers.includes(message.senderId)) {
          this._queuedFollowers.push(message.senderId)
        }
        break
      }
      case "follower-dequeued": {
        this._queuedFollowers = this._queuedFollowers.filter((id) => id !== message.senderId)
        break
      }
      case "yield-request": {
        if (this._isLeader) {
          // Explicit yield requested
          void this.stepDown(message.senderId)
        }
        break
      }
      case "leader-yielded":
      case "leader-released": {
        if (this._isLeader) return
        if (message.targetId === this.nodeId || !message.targetId) {
          void this.attemptElectionWithRetry()
        } else {
          // Another target was chosen: wait small jitter before retry
          this.scheduleRetry(50)
        }
        break
      }
      case "heartbeat": {
        // Heartbeat heard from active leader
        break
      }
    }
  }

  private async attemptElectionWithRetry(): Promise<void> {
    await this.attemptElection()
    if (!this._isLeader && !this._stopped) {
      this.scheduleRetry(20)
    }
  }

  private scheduleRetry(delayMs: number) {
    if (this._stopped || this._isLeader) return
    if (this.retryTimer) {
      this.env.clearTimeout(this.retryTimer)
    }
    this.retryTimer = this.env.setTimeout(() => {
      this.retryTimer = null
      if (!this._isLeader && !this._stopped) {
        void this.attemptElection()
      }
    }, delayMs)
  }

  private async attemptElection(): Promise<void> {
    if (this._stopped || this._isLeader) return

    if (this.env.locks) {
      await this.attemptWebLockElection()
    } else {
      this.attemptFallbackElection()
    }
  }

  private attemptWebLockElection(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false

      this.env.locks!.request(
        this.lockName,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (this._stopped) {
            if (!settled) {
              settled = true
              resolve()
            }
            return
          }

          if (!lock) {
            if (!settled) {
              settled = true
              this.becomeFollower()
              resolve()
            }
            return
          }

          let lockReleasePromise = new Promise<void>((releaseResolve) => {
            this.releaseLockCallback = () => {
              this.releaseLockCallback = null
              releaseResolve()
            }
          })

          if (!settled) {
            settled = true
            this.becomeLeader()
            resolve()
          }

          await lockReleasePromise
        },
      ).catch(() => {
        if (!settled) {
          settled = true
          this.becomeFollower()
          resolve()
        }
      })
    })
  }

  private attemptFallbackElection() {
    if (!this.env.localStorage || this._stopped) return

    const now = this.env.now()
    const currentLease = this.readFallbackLease()
    const isStale = !currentLease || now - currentLease.heartbeat > this.staleTimeoutMs
    const isMine = currentLease && currentLease.leaderId === this.nodeId

    if (isStale || isMine) {
      const lease: LocalStorageLease = { leaderId: this.nodeId, heartbeat: now }
      this.env.localStorage.setItem(this.lockName, JSON.stringify(lease))

      const verified = this.readFallbackLease()
      if (verified && verified.leaderId === this.nodeId) {
        this.becomeLeader()
        return
      }
    }

    this.becomeFollower()
  }

  private becomeLeader() {
    if (this._isLeader || this._stopped) return
    this._isLeader = true
    this.clearFollowerTimers()

    // Notify subscribers of change
    this.notifySubscribers()

    // Resolve any pending leadership requests
    const pending = this.pendingLeadershipRequests.splice(0)
    for (const p of pending) {
      p.resolve()
    }

    // Start heartbeat timer if in fallback mode
    if (this.isFallbackMode) {
      this.startHeartbeatTimer()
    }

    // Run node task
    if (this.task) {
      this.currentAbortController = new AbortController()
      const signal = this.currentAbortController.signal
      Promise.resolve(this.task(signal)).catch(() => {})
    }
  }

  private becomeFollower() {
    if (this._isLeader) return
    this.notifySubscribers()

    // Announce queued follower
    this.channel?.postMessage({
      type: "follower-queued",
      senderId: this.nodeId,
      timestamp: this.env.now(),
    })

    // If fallback, start checking for stale lease
    if (this.isFallbackMode) {
      this.startStaleCheckTimer()
    } else {
      // Broadcast delivery is best-effort during page teardown. Poll the non-blocking
      // Web Lock so a follower still takes over if the leader-released message is lost.
      this.scheduleRetry(this.retryDelayMs)
    }
  }

  private async stepDown(nextTarget?: string) {
    if (!this._isLeader) return

    this._isLeader = false
    this.clearLeaderTimers()

    this.currentAbortController?.abort()
    this.currentAbortController = null

    if (this.isFallbackMode) {
      this.clearFallbackLease()
    }

    // Allow any lock callback resolution
    const releaseCallback = this.releaseLockCallback
    this.releaseLockCallback = null
    releaseCallback?.()

    // Microtask delay to ensure lock manager has processed lock release
    await Promise.resolve()

    this.channel?.postMessage({
      type: "leader-yielded",
      senderId: this.nodeId,
      targetId: nextTarget,
      timestamp: this.env.now(),
    })

    this.notifySubscribers()

    // As follower, queue self and watch
    if (!this._stopped) {
      this.becomeFollower()
    }
  }

  private startHeartbeatTimer() {
    this.clearLeaderTimers()
    this.heartbeatTimer = this.env.setInterval(() => {
      if (!this._isLeader || this._stopped) return
      const now = this.env.now()
      const lease: LocalStorageLease = { leaderId: this.nodeId, heartbeat: now }
      this.env.localStorage?.setItem(this.lockName, JSON.stringify(lease))
      this.channel?.postMessage({
        type: "heartbeat",
        senderId: this.nodeId,
        timestamp: now,
      })
    }, this.heartbeatIntervalMs)
  }

  private startStaleCheckTimer() {
    this.clearFollowerTimers()
    this.staleCheckTimer = this.env.setInterval(() => {
      if (this._isLeader || this._stopped) return
      const lease = this.readFallbackLease()
      const now = this.env.now()
      if (!lease || now - lease.heartbeat > this.staleTimeoutMs) {
        void this.attemptElection()
      }
    }, this.retryDelayMs)
  }

  private clearLeaderTimers() {
    if (this.heartbeatTimer) {
      this.env.clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private clearFollowerTimers() {
    if (this.staleCheckTimer) {
      this.env.clearInterval(this.staleCheckTimer)
      this.staleCheckTimer = null
    }
    if (this.retryTimer) {
      this.env.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private clearTimers() {
    this.clearLeaderTimers()
    this.clearFollowerTimers()
  }

  private readFallbackLease(): LocalStorageLease | null {
    if (!this.env.localStorage) return null
    const raw = this.env.localStorage.getItem(this.lockName)
    if (!raw) return null
    try {
      return JSON.parse(raw) as LocalStorageLease
    } catch {
      return null
    }
  }

  private clearFallbackLease() {
    const lease = this.readFallbackLease()
    if (lease && lease.leaderId === this.nodeId) {
      this.env.localStorage?.removeItem(this.lockName)
    }
  }

  private notifySubscribers() {
    if (this._lastEmittedState === this._isLeader) return
    this._lastEmittedState = this._isLeader

    for (const listener of this.subscribers) {
      try {
        listener(this._isLeader)
      } catch {}
    }
  }
}

export function createMeshLeader(options?: MeshLeaderOptions): MeshLeader {
  return new MeshLeader(options)
}
