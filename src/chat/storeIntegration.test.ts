import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { ChatStore, type StoredChatMessage } from "./store"

const workspaceId = "ws_store_contract"
function message(index: number, record: unknown = null): StoredChatMessage {
  return {
    id: `msg_${String(index).padStart(4, "0")}`, workspaceId, personId: "p_author",
    createdAt: new Date(Date.parse("2026-09-10T00:00:00.000Z") + index * 1000).toISOString(),
    body: `Message ${index}`, record,
  }
}

describe("ChatStore transaction rules", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory())
    vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  })
  afterEach(() => vi.unstubAllGlobals())

  it("Given an immutable stored message, when its ID is reused with different content, then append rejects without changing it", async () => {
    const store = new ChatStore("conflict")
    const original = message(0, { version: 1 })
    expect(await store.append(original)).toBe(true)
    await expect(store.append({ ...original, body: "Conflicting content", record: { version: 2 } })).rejects.toThrow(/conflict|immutable/i)
    expect((await store.load(workspaceId)).messages).toEqual([original])
  })

  it("Given 2001 chronological messages, when merged, then only the latest 2000 persist and the pruned cutoff prevents reimport", async () => {
    const store = new ChatStore("count-cap")
    const messages = Array.from({ length: 2001 }, (_, index) => message(index))
    expect((await store.merge(workspaceId, messages, [])).added).toHaveLength(2000)
    const snapshot = await store.load(workspaceId)
    expect(snapshot.messages).toHaveLength(2000)
    expect(snapshot.messages[0]?.id).toBe("msg_0001")
    expect(snapshot.messages.at(-1)?.id).toBe("msg_2000")
    expect(await store.append(messages[0]!)).toBe(false)
    expect((await store.merge(workspaceId, [messages[0]!], [])).added).toHaveLength(0)
    expect((await store.load(workspaceId)).messages).toEqual(snapshot.messages)
  })

  it("Given two batches exceeding 4 MiB, when merged, then older messages are pruned and cannot return", async () => {
    const store = new ChatStore("byte-cap")
    const messages = Array.from({ length: 280 }, (_, index) => message(index, { data: "x".repeat(15 * 1024) }))
    await store.merge(workspaceId, messages.slice(0, 140), [])
    await store.merge(workspaceId, messages.slice(140), [])
    const snapshot = await store.load(workspaceId)
    expect(snapshot.messages.length).toBeLessThan(280)
    expect(snapshot.messages.length).toBeGreaterThan(200)
    expect(snapshot.messages.at(-1)?.id).toBe("msg_0279")
    expect(snapshot.messages[0]?.id).not.toBe("msg_0000")
    expect(await store.append(messages[0]!)).toBe(false)
    expect((await store.merge(workspaceId, [messages[0]!], [])).added).toHaveLength(0)
    expect((await store.load(workspaceId)).messages).toEqual(snapshot.messages)
  })

  it("Given a read cursor, when older and newer cursors arrive, then stored progress only advances", async () => {
    const store = new ChatStore("read-cursor")
    const first = "2026-09-10T12:00:00.000Z|msg_02"
    const older = "2026-09-10T11:00:00.000Z|msg_01"
    const newer = "2026-09-10T13:00:00.000Z|msg_03"
    expect(await store.readCursor(workspaceId)).toBeNull()
    await store.markRead(workspaceId, first)
    expect(await store.readCursor(workspaceId)).toBe(first)
    await store.markRead(workspaceId, older)
    expect(await store.readCursor(workspaceId)).toBe(first)
    await store.markRead(workspaceId, newer)
    expect(await store.readCursor(workspaceId)).toBe(newer)
  })
})
