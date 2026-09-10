import { test, expect } from "@playwright/test"

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

    await page.goto("/")
    await secondPage.goto("/")

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

  test("immutable same-id conflict rejects and leaves stored record unchanged", async ({ page }) => {
    const dbName = uniqueDbName("test-chat-conflict")
    await page.goto("/")

    const workspaceId = "ws_conflict"
    const originalMsg = {
      id: "m_conflict",
      workspaceId,
      personId: "p_1",
      createdAt: "2026-09-10T12:00:00.000Z",
      body: "Original immutable content",
      record: { version: 1 },
    }
    const conflictingMsg = {
      id: "m_conflict",
      workspaceId,
      personId: "p_1",
      createdAt: "2026-09-10T12:00:00.000Z",
      body: "Conflicting content with same id",
      record: { version: 2 },
    }

    const result = await page.evaluate(
      async ({ modPath, dbName, originalMsg, conflictingMsg, workspaceId }) => {
        const { ChatStore } = await import(/* @vite-ignore */ modPath)
        const store = new ChatStore(dbName)

        // First append succeeds
        const firstAppend = await store.append(originalMsg)

        // Second append with differing immutable content must reject
        let conflictRejected = false
        let errorMessage = ""
        try {
          await store.append(conflictingMsg)
        } catch (err) {
          conflictRejected = true
          errorMessage = err instanceof Error ? err.message : String(err)
        }

        // Check current state in DB
        const snapshot = await store.load(workspaceId)
        return { firstAppend, conflictRejected, errorMessage, snapshot }
      },
      { modPath: STORE_PATH, dbName, originalMsg, conflictingMsg, workspaceId }
    )

    expect(result.firstAppend).toBe(true)
    expect(result.conflictRejected).toBe(true)
    expect(result.errorMessage).toMatch(/conflict|immutable/i)
    expect(result.snapshot.messages).toHaveLength(1)
    expect(result.snapshot.messages[0].id).toBe("m_conflict")
    expect(result.snapshot.messages[0].body).toBe("Original immutable content")
    expect(result.snapshot.messages[0].record).toEqual({ version: 1 })
  })

  test("2001 chronological records retains latest 2000 and pruned cutoff rejects reimport", async ({
    page,
  }) => {
    const dbName = uniqueDbName("test-chat-cap2000")
    await page.goto("/")

    const workspaceId = "ws_cap2000"

    const result = await page.evaluate(
      async ({ modPath, dbName, workspaceId }) => {
        const { ChatStore } = await import(/* @vite-ignore */ modPath)
        const store = new ChatStore(dbName)

        // Generate 2001 messages in strict chronological order
        const baseTime = Date.parse("2026-09-10T00:00:00.000Z")
        const allMsgs = []
        for (let i = 0; i < 2001; i++) {
          allMsgs.push({
            id: `msg_${String(i).padStart(4, "0")}`,
            workspaceId,
            personId: "p_author",
            createdAt: new Date(baseTime + i * 1000).toISOString(),
            body: `Message ${i}`,
            record: null,
          })
        }

        // Merge all 2001 messages in one transaction
        const mergeResult = await store.merge(workspaceId, allMsgs, [])
        const snapshotAfterMerge = await store.load(workspaceId)

        // Attempt to reimport the oldest message (which was pruned)
        const prunedMsg = allMsgs[0]
        const appendPrunedResult = await store.append(prunedMsg)
        const mergePrunedResult = await store.merge(workspaceId, [prunedMsg], [])

        const snapshotFinal = await store.load(workspaceId)

        return {
          addedCount: mergeResult.added.length,
          snapshotCount: snapshotAfterMerge.messages.length,
          firstStoredId: snapshotAfterMerge.messages[0]?.id,
          lastStoredId: snapshotAfterMerge.messages[snapshotAfterMerge.messages.length - 1]?.id,
          appendPrunedResult,
          mergePrunedAddedCount: mergePrunedResult.added.length,
          finalCount: snapshotFinal.messages.length,
          hasPrunedMessage: snapshotFinal.messages.some((m: any) => m.id === prunedMsg.id),
        }
      },
      { modPath: STORE_PATH, dbName, workspaceId }
    )

    // Merge should only report the 2000 actually retained records as added
    expect(result.addedCount).toBe(2000)
    expect(result.snapshotCount).toBe(2000)

    // msg_0000 was pruned; msg_0001 is now the oldest retained, msg_2000 is newest
    expect(result.firstStoredId).toBe("msg_0001")
    expect(result.lastStoredId).toBe("msg_2000")

    // Pruned message cannot be reimported via append or merge
    expect(result.appendPrunedResult).toBe(false)
    expect(result.mergePrunedAddedCount).toBe(0)
    expect(result.finalCount).toBe(2000)
    expect(result.hasPrunedMessage).toBe(false)
  })

  test("byte cap 4 MiB retains latest records and prunes oldest when using records near 16 KiB", async ({
    page,
  }) => {
    const dbName = uniqueDbName("test-chat-bytecap")
    await page.goto("/")

    const workspaceId = "ws_byte_cap"

    const result = await page.evaluate(
      async ({ modPath, dbName, workspaceId }) => {
        const { ChatStore } = await import(/* @vite-ignore */ modPath)
        const store = new ChatStore(dbName)

        // Each record has near 16 KiB payload (15 KiB string + structure overhead)
        // 4 MiB = 4,194,304 bytes. 280 records * ~15.5 KiB ≈ 4.34 MiB > 4 MiB.
        const payload15KiB = "x".repeat(15 * 1024)
        const baseTime = Date.parse("2026-09-10T00:00:00.000Z")
        const messages = []
        for (let i = 0; i < 280; i++) {
          messages.push({
            id: `chunk_${String(i).padStart(4, "0")}`,
            workspaceId,
            personId: "p_streamer",
            createdAt: new Date(baseTime + i * 1000).toISOString(),
            body: `Chunk ${i}`,
            record: { data: payload15KiB },
          })
        }

        // Merge in two batches
        await store.merge(workspaceId, messages.slice(0, 140), [])
        await store.merge(workspaceId, messages.slice(140, 280), [])

        const snapshot = await store.load(workspaceId)

        // Attempt re-importing the first (pruned) chunk
        const firstPruned = messages[0]
        const appendPrunedResult = await store.append(firstPruned)

        return {
          totalLoaded: snapshot.messages.length,
          firstId: snapshot.messages[0]?.id,
          lastId: snapshot.messages[snapshot.messages.length - 1]?.id,
          appendPrunedResult,
        }
      },
      { modPath: STORE_PATH, dbName, workspaceId }
    )

    // 280 messages exceeded 4 MiB, so earlier messages must have been pruned
    expect(result.totalLoaded).toBeLessThan(280)
    expect(result.totalLoaded).toBeGreaterThan(200)

    // The latest chunk must be preserved
    expect(result.lastId).toBe("chunk_0279")

    // chunk_0000 was pruned and must not be present or re-importable
    expect(result.firstId).not.toBe("chunk_0000")
    expect(result.appendPrunedResult).toBe(false)
  })

  test("atomic merge failure on conflicting record does not partially save valid message", async ({
    page,
  }) => {
    const dbName = uniqueDbName("test-chat-atomic")
    await page.goto("/")

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

  test("read cursor operates monotonically and ignores older cursors", async ({ page }) => {
    const dbName = uniqueDbName("test-chat-cursor")
    await page.goto("/")

    const workspaceId = "ws_cursor"

    const result = await page.evaluate(
      async ({ modPath, dbName, workspaceId }) => {
        const { ChatStore } = await import(/* @vite-ignore */ modPath)
        const store = new ChatStore(dbName)

        const initialCursor = await store.readCursor(workspaceId)

        // Set cursor to T12
        const cursor1 = "2026-09-10T12:00:00.000Z|msg_02"
        await store.markRead(workspaceId, cursor1)
        const afterFirstMark = await store.readCursor(workspaceId)

        // Attempt setting older cursor T11 (monotonic: should NOT overwrite)
        const olderCursor = "2026-09-10T11:00:00.000Z|msg_01"
        await store.markRead(workspaceId, olderCursor)
        const afterOlderMark = await store.readCursor(workspaceId)

        // Set newer cursor T13 (should update)
        const newerCursor = "2026-09-10T13:00:00.000Z|msg_03"
        await store.markRead(workspaceId, newerCursor)
        const afterNewerMark = await store.readCursor(workspaceId)

        return {
          initialCursor,
          afterFirstMark,
          afterOlderMark,
          afterNewerMark,
        }
      },
      { modPath: STORE_PATH, dbName, workspaceId }
    )

    expect(result.initialCursor).toBeNull()
    expect(result.afterFirstMark).toBe("2026-09-10T12:00:00.000Z|msg_02")
    expect(result.afterOlderMark).toBe("2026-09-10T12:00:00.000Z|msg_02")
    expect(result.afterNewerMark).toBe("2026-09-10T13:00:00.000Z|msg_03")
  })

  test("page reload opens and loads durable stored chat data identically", async ({ page }) => {
    const dbName = uniqueDbName("test-chat-reload")
    await page.goto("/")

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
