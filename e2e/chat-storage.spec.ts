import { test, expect } from "./support/coverage"
import { openStorageHarness } from "./support/storageHarness"

const STORE_PATH = "/src/chat/store.ts"

function uniqueDbName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

test.describe("ChatStore Real IndexedDB Durability & Isolation E2E", () => {
  test("two tabs concurrently append different messages and duplicate is suppressed", async ({
    context,
    page,
  }) => {
    const dbName = uniqueDbName("test-chat-concurrent")
    const secondPage = await context.newPage()

    await openStorageHarness(page)
    await openStorageHarness(secondPage)

    const workspaceId = "ws_concurrent"
    const sharedMsg = {
      id: "msg_shared",
      workspaceId,
      personId: "p_shared",
      createdAt: "2026-09-10T12:00:00.000Z",
      body: "Shared message",
      record: { shared: true },
    }
    const msgA = {
      id: "msg_a",
      workspaceId,
      personId: "p_a",
      createdAt: "2026-09-10T12:00:01.000Z",
      body: "Message from tab 1",
      record: null,
    }
    const msgB = {
      id: "msg_b",
      workspaceId,
      personId: "p_b",
      createdAt: "2026-09-10T12:00:02.000Z",
      body: "Message from tab 2",
      record: null,
    }

    const [res1, res2] = await Promise.all([
      page.evaluate(
        async ({ modPath, dbName, sharedMsg, uniqueMsg }) => {
          const { ChatStore } = await import(/* @vite-ignore */ modPath)
          const store = new ChatStore(dbName)
          const sharedResult = await store.append(sharedMsg)
          const uniqueResult = await store.append(uniqueMsg)
          return { sharedResult, uniqueResult }
        },
        { modPath: STORE_PATH, dbName, sharedMsg, uniqueMsg: msgA }
      ),
      secondPage.evaluate(
        async ({ modPath, dbName, sharedMsg, uniqueMsg }) => {
          const { ChatStore } = await import(/* @vite-ignore */ modPath)
          const store = new ChatStore(dbName)
          const sharedResult = await store.append(sharedMsg)
          const uniqueResult = await store.append(uniqueMsg)
          return { sharedResult, uniqueResult }
        },
        { modPath: STORE_PATH, dbName, sharedMsg, uniqueMsg: msgB }
      ),
    ])

    // Both unique messages were appended successfully
    expect(res1.uniqueResult).toBe(true)
    expect(res2.uniqueResult).toBe(true)

    // Exactly one tab succeeded in newly inserting the shared record; the other was suppressed as a duplicate
    const sharedSuccessCount = (res1.sharedResult ? 1 : 0) + (res2.sharedResult ? 1 : 0)
    expect(sharedSuccessCount).toBe(1)

    // Both tabs observe all 3 messages durable in the shared IndexedDB
    const snapshot = await page.evaluate(
      async ({ modPath, dbName, workspaceId }) => {
        const { ChatStore } = await import(/* @vite-ignore */ modPath)
        const store = new ChatStore(dbName)
        return await store.load(workspaceId)
      },
      { modPath: STORE_PATH, dbName, workspaceId }
    )

    expect(snapshot.messages).toHaveLength(3)
    const ids = snapshot.messages.map((m: any) => m.id)
    expect(ids).toContain("msg_shared")
    expect(ids).toContain("msg_a")
    expect(ids).toContain("msg_b")

    await secondPage.close()
  })

  test("atomic merge failure on conflicting record does not partially save valid message", async ({
    page,
  }) => {
    const dbName = uniqueDbName("test-chat-atomic")
    await openStorageHarness(page)

    const workspaceId = "ws_atomic"
    const existingMsg = {
      id: "m_existing",
      workspaceId,
      personId: "p_1",
      createdAt: "2026-09-10T10:00:00.000Z",
      body: "Existing initial message",
      record: null,
    }

    const validNewMsg = {
      id: "m_valid_new",
      workspaceId,
      personId: "p_2",
      createdAt: "2026-09-10T10:01:00.000Z",
      body: "Should not be persisted due to transaction abort",
      record: null,
    }

    const conflictingMsg = {
      id: "m_existing",
      workspaceId,
      personId: "p_1",
      createdAt: "2026-09-10T10:00:00.000Z",
      body: "Illegal changed body conflicting with existing",
      record: null,
    }

    const result = await page.evaluate(
      async ({ modPath, dbName, workspaceId, existingMsg, validNewMsg, conflictingMsg }) => {
        const { ChatStore } = await import(/* @vite-ignore */ modPath)
        const store = new ChatStore(dbName)

        // Setup pre-existing durable message
        await store.append(existingMsg)

        // Try merge containing both valid new message and conflicting message
        let mergeFailed = false
        let errorMessage = ""
        try {
          await store.merge(workspaceId, [validNewMsg, conflictingMsg], [])
        } catch (err) {
          mergeFailed = true
          errorMessage = err instanceof Error ? err.message : String(err)
        }

        // Check whether validNewMsg was partially written
        const snapshot = await store.load(workspaceId)
        return { mergeFailed, errorMessage, snapshot }
      },
      { modPath: STORE_PATH, dbName, workspaceId, existingMsg, validNewMsg, conflictingMsg }
    )

    expect(result.mergeFailed).toBe(true)
    expect(result.errorMessage).toMatch(/conflict|immutable/i)

    // Only the original existing message remains; validNewMsg was rolled back atomically
    expect(result.snapshot.messages).toHaveLength(1)
    expect(result.snapshot.messages[0].id).toBe("m_existing")
    expect(result.snapshot.messages[0].body).toBe("Existing initial message")
  })

  test("page reload opens and loads durable stored chat data identically", async ({ page }) => {
    const dbName = uniqueDbName("test-chat-reload")
    await openStorageHarness(page)

    const workspaceId = "ws_reload"
    const msg = {
      id: "m_durable",
      workspaceId,
      personId: "p_owner",
      createdAt: "2026-09-10T15:00:00.000Z",
      body: "This message must survive page reload",
      record: { payload: "persisted" },
    }
    const profile = {
      workspaceId,
      personId: "p_owner",
      name: "Persistent User",
      revision: 3,
      record: { verified: true },
    }
    const cursorVal = "2026-09-10T15:00:00.000Z|m_durable"

    // Save data before reload
    await page.evaluate(
      async ({ modPath, dbName, msg, profile, cursorVal, workspaceId }) => {
        const { ChatStore } = await import(/* @vite-ignore */ modPath)
        const store = new ChatStore(dbName)
        await store.append(msg)
        await store.putProfile(profile)
        await store.markRead(workspaceId, cursorVal)
      },
      { modPath: STORE_PATH, dbName, msg, profile, cursorVal, workspaceId }
    )

    // Reload the browser page
    await page.reload()

    // Read data after reload
    const afterReload = await page.evaluate(
      async ({ modPath, dbName, workspaceId }) => {
        const { ChatStore } = await import(/* @vite-ignore */ modPath)
        const store = new ChatStore(dbName)
        const snapshot = await store.load(workspaceId)
        const cursor = await store.readCursor(workspaceId)
        return { snapshot, cursor }
      },
      { modPath: STORE_PATH, dbName, workspaceId }
    )

    expect(afterReload.snapshot.messages).toHaveLength(1)
    expect(afterReload.snapshot.messages[0]).toEqual(msg)

    expect(afterReload.snapshot.profiles).toHaveLength(1)
    expect(afterReload.snapshot.profiles[0]).toEqual(profile)

    expect(afterReload.cursor).toBe(cursorVal)
  })
})
