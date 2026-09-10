import { fromBase64Url, toBase64Url } from "../domain/identity"
import { decodePairingFrame, encodePairingFrame } from "./protocol"
import type { LiveWorkspaceSync } from "./session"
import type { DuplexStream, SyncConnection } from "./transport"

export class SyncNetworkError extends Error {}

export async function networkIO<T>(operation: Promise<T>): Promise<T> {
  try { return await operation } catch (error) {
    throw new SyncNetworkError(error instanceof Error ? error.message : String(error))
  }
}

export function networkConnection(connection: SyncConnection): SyncConnection {
  const stream = (value: DuplexStream): DuplexStream => ({
    read: () => networkIO(value.read()),
    send: bytes => networkIO(value.send(bytes)),
    closeSend: () => networkIO(value.closeSend()),
  })
  return {
    openStream: async () => stream(await networkIO(connection.openStream())),
    acceptStream: async () => stream(await networkIO(connection.acceptStream())),
    // Closing an already disconnected transport must not replace its original failure.
    close: () => connection.close().catch(() => {}),
  }
}

export function isNetworkFailure(error: unknown) {
  return error instanceof SyncNetworkError || /bootstrap|relay|network|fetch failed/i.test(error instanceof Error ? error.message : String(error))
}

export type WorkspaceSetStore = {
  read: (id: string) => Promise<Uint8Array>
  merge: (id: string, bytes: Uint8Array) => Promise<void>
  activate: (id: string) => Promise<void>
}

export function workspaceSet(store: WorkspaceSetStore, workspaceIds: string[]) {
  const ids = [...new Set(workspaceIds)].sort()
  return {
    async snapshot() {
      const entries = await Promise.all(ids.map(async id => ({ id, bytes: toBase64Url(await store.read(id)) })))
      return new TextEncoder().encode(JSON.stringify(entries))
    },
    async receive(bytes: Uint8Array) {
      const entries = JSON.parse(new TextDecoder().decode(bytes))
      if (!Array.isArray(entries) || entries.length !== ids.length ||
        new Set(entries.map(e => e?.id)).size !== ids.length ||
        entries.some(e => !ids.includes(e?.id) || typeof e?.bytes !== "string")) {
        throw new Error("The peer sent a different set of workspaces than the invitation allows.")
      }
      for (const entry of entries) await store.merge(entry.id, fromBase64Url(entry.bytes))
    },
  }
}

export function liveWorkspaceSetSync(
  connection: SyncConnection,
  secret: string,
  replica: ReturnType<typeof workspaceSet>,
): LiveWorkspaceSync {
  let stopped = false
  let lastSent = ""
  let queue = Promise.resolve()
  const done = (async () => {
    while (!stopped) {
      const stream = await connection.acceptStream()
      if (stopped) return
      await replica.receive(decodePairingFrame(await stream.read(), "sync-update", secret))
      await stream.closeSend()
    }
  })().catch(error => { if (!stopped) throw error })
  return {
    done,
    publish() {
      queue = queue.then(async () => {
        if (stopped) return
        const bytes = await replica.snapshot()
        const content = toBase64Url(bytes)
        if (stopped || content === lastSent) return
        const stream = await connection.openStream()
        await stream.send(encodePairingFrame("sync-update", secret, bytes))
        await stream.closeSend()
        lastSent = content
      })
      return queue
    },
    async close() {
      stopped = true
      await connection.close()
    },
  }
}
