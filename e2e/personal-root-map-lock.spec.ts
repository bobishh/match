import { expect, test } from "./support/coverage"

test("Given two tabs, when root writes overlap, then the shared map keeps both changes", async ({ page }) => {
  const second = await page.context().newPage()
  await Promise.all([page.goto("/"), second.goto("/")])
  const personId = `lock-test-${crypto.randomUUID()}`
  const rootId = crypto.randomUUID()
  const root = {
    kind: "personal-root", formatVersion: 1, rootId,
    identity: { personId, publicKey: "test-key", displayName: "Lock test" },
    devices: {}, workspaces: {},
  }

  await page.evaluate(async initialRoot => {
    const { PersonalRootMapStore } = await import("/src/storagePersonalRoot.ts")
    await new PersonalRootMapStore(new Map(), () => {}).save(initialRoot as never)
    const state = window as typeof window & { __lockReady?: () => void; __unlock?: () => void; __lockHeld?: Promise<void> }
    state.__lockHeld = new Promise<void>(resolve => { state.__unlock = resolve })
    let announce: (() => void) | undefined
    const ready = new Promise<void>(resolve => { announce = resolve })
    state.__lockReady = () => announce?.()
    void navigator.locks.request("tincanban.local-state.write:tincanban.v1.personal_roots", { mode: "exclusive" }, async () => {
      state.__lockReady?.()
      await state.__lockHeld
    })
    await ready
  }, root)

  await second.evaluate(async args => {
    const { PersonalRootMapStore } = await import("/src/storagePersonalRoot.ts")
    const state = window as typeof window & { __rootUpdate?: Promise<unknown>; __rootDone?: boolean }
    state.__rootDone = false
    state.__rootUpdate = new PersonalRootMapStore(new Map(), () => {}).update(args.personId, current => {
      if (!current) throw new Error("root missing")
      current.pendingKeeperWithdrawals = { pairing: { pairingId: "pairing", operationId: "operation", pairing: {} } }
      return current
    }).then(value => { state.__rootDone = true; return value })
  }, { personId })
  await expect.poll(() => second.evaluate(() => (window as typeof window & { __rootDone?: boolean }).__rootDone)).toBe(false)

  await page.evaluate(async args => {
    const { PersonalRootMapStore } = await import("/src/storagePersonalRoot.ts")
    const state = window as typeof window & { __rootUpdate?: Promise<unknown>; __rootDone?: boolean; __unlock?: () => void }
    state.__rootDone = false
    state.__rootUpdate = new PersonalRootMapStore(new Map(), () => {}).update(args.personId, current => {
      if (!current) throw new Error("root missing")
      current.displayNamePreset = "saved in first tab"
      return current
    }).then(value => { state.__rootDone = true; return value })
    state.__unlock?.()
  }, { personId })

  await page.evaluate(async () => {
    const state = window as typeof window & { __rootUpdate?: Promise<unknown> }
    await state.__rootUpdate
  })
  await second.evaluate(async () => {
    const state = window as typeof window & { __rootUpdate?: Promise<unknown> }
    await state.__rootUpdate
  })
  const saved = await second.evaluate(async id => {
    const { PersonalRootMapStore } = await import("/src/storagePersonalRoot.ts")
    return new PersonalRootMapStore(new Map(), () => {}).load(id)
  }, rootId)
  expect(saved).toMatchObject({
    rootId,
    displayNamePreset: "saved in first tab",
    pendingKeeperWithdrawals: { pairing: { operationId: "operation" } },
  })
  await second.close()
})

test("Given one owner cache, when tabs add and remove keepers concurrently, then unrelated keeper rows survive", async ({ page }) => {
  const second = await page.context().newPage()
  await Promise.all([page.goto("/"), second.goto("/")])
  const owner = `owner-${crypto.randomUUID()}`
  const first = `keeper-${crypto.randomUUID()}`
  const retained = `keeper-${crypto.randomUUID()}`
  const added = `keeper-${crypto.randomUUID()}`

  await Promise.all([
    page.evaluate(async args => (await import("/src/sync/ownerKeeper.ts")).saveOwnerKeeper(args.owner,
      { personId: args.person, role: "editor" }), { owner, person: first }),
    second.evaluate(async args => (await import("/src/sync/ownerKeeper.ts")).saveOwnerKeeper(args.owner,
      { personId: args.person, role: "visitor" }), { owner, person: retained }),
  ])
  await Promise.all([
    page.evaluate(async args => (await import("/src/sync/ownerKeeper.ts")).removeOwnerKeeper(args.owner, args.person),
      { owner, person: first }),
    second.evaluate(async args => (await import("/src/sync/ownerKeeper.ts")).saveOwnerKeeper(args.owner,
      { personId: args.person, role: "editor" }), { owner, person: added }),
  ])

  const keepers = await second.evaluate(async id => (await import("/src/sync/ownerKeeper.ts")).ownerKeepers(id), owner)
  expect(keepers).toEqual([
    { personId: retained, role: "visitor" },
    { personId: added, role: "editor" },
  ])
  await second.close()
})
