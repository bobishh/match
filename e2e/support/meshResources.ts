import type { Page } from "@playwright/test"

/** Observe ownership of real retry/heartbeat timers without replacing their scheduling. */
export async function captureMeshResources(page: Page) {
  await page.route("**/browserDial.ts*", async route => {
    const response = await route.fetch()
    const source = await response.text()
    const marker = "const peers = await this.host.peers();"
    if (!source.includes(marker)) throw new Error("Dial observation target changed")
    await route.fulfill({ response, body: source.replace(marker, `${marker}
      window.__meshDialInput = { localDeviceId, localInstanceId, peers: peers.map(peer => ({
        workspaceId: peer.workspaceId, deviceId: peer.deviceId, instanceId: peer.instanceId,
        revokedAt: peer.revokedAt, endpoint: peer.endpoint,
      })) };`) })
  })
  await page.route("**/browserLifecycle.ts*", async route => {
    const response = await route.fetch()
    const source = await response.text()
    if (!source.includes("class BrowserMeshLifecycle")) throw new Error("Lifecycle observation target changed")
    await route.fulfill({ response, body: `${source}\n;(() => {
      window.__meshObservedLifecycles = new Set()
      const wait = BrowserMeshLifecycle.prototype.wait
      BrowserMeshLifecycle.prototype.wait = async function (...args) {
        window.__meshObservedLifecycles.add(this)
        this.__observedWaits = (this.__observedWaits ?? 0) + 1
        try { return await wait.apply(this, args) }
        finally { this.__observedWaits -= 1 }
      }
    })()` })
  })
  await page.route("**/mesh-transport/src/index.ts*", async route => {
    const response = await route.fetch()
    const source = await response.text()
    if (!source.includes("function startMeshHeartbeat")) throw new Error("Heartbeat observation target changed")
    await route.fulfill({ response, body: `${source}\n;(() => {
      window.__meshObservedHeartbeats = 0
      const start = startMeshHeartbeat
      startMeshHeartbeat = (...args) => {
        const stop = start(...args)
        window.__meshObservedHeartbeats += 1
        let stopped = false
        return () => {
          stop()
          if (!stopped) { stopped = true; window.__meshObservedHeartbeats -= 1 }
        }
      }
    })()` })
  })
}

export async function meshResourceCounts(page: Page) {
  return page.evaluate(() => {
    const observed = window as Window & {
      __meshObservedHeartbeats?: number
      __meshObservedLifecycles?: Set<{ __observedWaits?: number }>
    }
    if (observed.__meshObservedHeartbeats === undefined || !observed.__meshObservedLifecycles) {
      throw new Error("Mesh resource instrumentation did not load")
    }
    return {
      heartbeats: observed.__meshObservedHeartbeats,
      retryWaits: [...observed.__meshObservedLifecycles].reduce((sum, owner) => sum + (owner.__observedWaits ?? 0), 0),
    }
  })
}
