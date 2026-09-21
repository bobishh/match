import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.goto("/")
})

test("Given two tabs persist different changes concurrently, when storage reopens, then both durable records remain", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { WorkspaceStorage } = await import("/src/storage.ts")
    const workspaceId = `concurrent-${crypto.randomUUID()}`
    const isolated = () => new WorkspaceStorage({ changes: new Map(), proofs: new Map(), receipts: new Map(),
      snapshots: new Map(), workspaces: new Map(), personalRoots: new Map() })
    const first = isolated()
    const second = isolated()
    const receiptA = { transactionId: "tx-a", changeHash: "change-a", saved: true }
    const receiptB = { transactionId: "tx-b", changeHash: "change-b", saved: true }
    const proofA = { payload: { changeHash: "change-a" } }
    const proofB = { payload: { changeHash: "change-b" } }

    await Promise.all([
      first.commitTransaction(workspaceId, receiptA as never, new Uint8Array([1]), proofA as never),
      second.commitTransaction(workspaceId, receiptB as never, new Uint8Array([2]), proofB as never),
    ])

    const reopened = isolated()
    return {
      changes: (await reopened.listChanges(workspaceId)).map(change => change.changeHash).sort(),
      receipts: await Promise.all([reopened.getReceipt(workspaceId, "tx-a"), reopened.getReceipt(workspaceId, "tx-b")]),
      proofs: await Promise.all([reopened.getProof(workspaceId, "change-a"), reopened.getProof(workspaceId, "change-b")]),
    }
  })

  expect(result.changes).toEqual(["change-a", "change-b"])
  expect(result.receipts.every(Boolean)).toBe(true)
  expect(result.proofs.every(Boolean)).toBe(true)
})

test("Given proof persistence fails, when a transaction aborts, then no change or receipt leaks", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { WorkspaceStorage } = await import("/src/storage.ts")
    const workspaceId = `abort-${crypto.randomUUID()}`
    const isolated = () => new WorkspaceStorage({ changes: new Map(), proofs: new Map(), receipts: new Map(),
      snapshots: new Map(), workspaces: new Map(), personalRoots: new Map() })
    const storage = isolated()
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "proofs") throw new Error("proof write failed")
      return originalPut.apply(this, args)
    }
    let error = ""
    try {
      await storage.commitTransaction(workspaceId,
        { transactionId: "tx-abort", changeHash: "change-abort", saved: true } as never,
        new Uint8Array([9]), { payload: { changeHash: "change-abort" } } as never)
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    } finally {
      IDBObjectStore.prototype.put = originalPut
    }

    const reopened = isolated()
    return {
      error,
      changes: (await reopened.listChanges(workspaceId)).map(change => change.changeHash),
      receipt: await reopened.getReceipt(workspaceId, "tx-abort"),
      proof: await reopened.getProof(workspaceId, "change-abort"),
    }
  })

  expect(result.error).toContain("proof write failed")
  expect(result.changes).toEqual([])
  expect(result.receipt).toBeNull()
  expect(result.proof).toBeNull()
})

test("Given a legacy journal, when the IndexedDB journal opens, then existing changes and proofs migrate", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const workspaceId = `migration-${crypto.randomUUID()}`
    localStorage.setItem(`match.v1.changes.${workspaceId}`, JSON.stringify([{
      workspaceId, changeHash: "legacy-change", bytesBase64: "Bw", addedAt: new Date().toISOString(),
    }]))
    localStorage.setItem(`match.v1.proofs.${workspaceId}`, JSON.stringify({
      "legacy-change": { payload: { changeHash: "legacy-change" } },
    }))
    localStorage.setItem(`match.v1.receipts.${workspaceId}`, JSON.stringify({
      "legacy-tx": { transactionId: "legacy-tx", changeHash: "legacy-change", saved: true },
    }))
    const { WorkspaceStorage } = await import("/src/storage.ts")
    const storage = new WorkspaceStorage({ changes: new Map(), proofs: new Map(), receipts: new Map(),
      snapshots: new Map(), workspaces: new Map(), personalRoots: new Map() })
    return {
      changes: (await storage.listChanges(workspaceId)).map(change => [...change.bytes]),
      proof: await storage.getProof(workspaceId, "legacy-change"),
      receipt: await storage.getReceipt(workspaceId, "legacy-tx"),
    }
  })

  expect(result.changes).toEqual([[7]])
  expect(result.proof).not.toBeNull()
  expect(result.receipt).not.toBeNull()
})

test("Given two open tabs, when both edit one workspace together, then both converge on both changes", async ({ page }) => {
  const second = await page.context().newPage()
  await second.goto("/")
  const edit = async (target: typeof page, id: string, title: string) => target.evaluate(async ({ id, title }) => {
    const { useMatch } = await import("/src/state.ts")
    const match = useMatch()
    const doc = match.getActiveDoc()!
    const column = Object.values(doc.entities).find(entity => entity.kind === "column")!
    await match.executeCommandAsync({ kind: "createItem", id, parentId: column.id, title })
  }, { id, title })

  try {
    await Promise.all([
      edit(page, crypto.randomUUID(), "Cross-tab A"),
      edit(second, crypto.randomUUID(), "Cross-tab B"),
    ])
    await expect.poll(async () => Promise.all([page, second].map(target => target.evaluate(async () => {
      const { useMatch } = await import("/src/state.ts")
      return Object.values(useMatch().getActiveDoc()!.entities)
        .map(entity => "title" in entity ? entity.title : "")
        .filter(title => title === "Cross-tab A" || title === "Cross-tab B")
        .sort()
    }))), { timeout: 15_000 }).toEqual([
      ["Cross-tab A", "Cross-tab B"],
      ["Cross-tab A", "Cross-tab B"],
    ])
  } finally {
    await second.close()
  }
})
