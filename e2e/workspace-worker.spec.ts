import { expect, test } from "./support/coverage"

test("Given an already admitted board, when its exact signed evidence repeats, then it does not queue another admission job", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
  const result = await page.evaluate(async () => {
    const match = (await import("/src/state.ts")).useMatch()
    await match.whenReady()
    const bytes = await match.readWorkspaceBytes(match.activeWorkspace.id)
    const { exportAuthorizationBundle } = await import("/src/sync/changeAuthorization.ts")
    const proof = await exportAuthorizationBundle(bytes, match.getCurrentProfile()!)
    const original = window.Worker
    window.Worker = class { constructor() { throw new Error("Unexpected repeated admission") } } as unknown as typeof Worker
    try {
      const start = performance.now()
      await match.mergeAuthorizedWorkspace(match.activeWorkspace.id, bytes, proof)
      return performance.now() - start
    } finally { window.Worker = original }
  })
  expect(result).toBeLessThan(1000)
  console.info(`Exact evidence replay: ${Math.round(result)}ms; no admission worker`)
})

test("Given a large signed peer history, when admission runs, then board controls stay responsive until durable commit", async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
  await page.evaluate(async () => {
    const { useMatch } = await import("/src/state.ts")
    const { prepareLocalChangeAuthorizations, exportAuthorizationBundle } = await import("/src/sync/changeAuthorization.ts")
    const A = await import("/@id/@automerge/automerge/slim")
    const match = useMatch()
    await match.whenReady()
    const base = match.getActiveDoc()!
    const profile = match.getCurrentProfile()!
    let remote = A.clone(base)
    for (let index = 0; index < 20_001; index++) {
      remote = A.change(remote, draft => { draft.title = `Remote history ${index}` })
    }
    const hashes = A.getChangesMetaSince(remote, A.getHeads(base)).map(change => change.hash)
    const bundle = await exportAuthorizationBundle(A.save(base), profile)
    const proofs = [...bundle.records]
    for (let offset = 0; offset < hashes.length; offset += 256) {
      proofs.push(...await prepareLocalChangeAuthorizations(remote, profile, hashes.slice(offset, offset + 256)))
    }
    const fixture = { id: base.id, bytes: A.save(remote), authorization: { ...bundle, records: proofs }, before: A.getHeads(base) }
    Object.assign(window, { admissionFixture: fixture, admissionState: "ready" })
  })
  const workerStarted = page.waitForEvent("worker", { predicate: worker => worker.url().includes("workspaceAdmissionWorker") })
  await page.evaluate(() => {
    const state = window as unknown as { admissionFixture: { id: string; bytes: Uint8Array; authorization: unknown }; admissionState: string; admissionPromise: Promise<void> }
    state.admissionState = "pending"
    state.admissionPromise = import("/src/state.ts").then(({ useMatch }) => useMatch().mergeAuthorizedWorkspace(
      state.admissionFixture.id, state.admissionFixture.bytes, state.admissionFixture.authorization,
    )).then(() => { state.admissionState = "committed" }, error => { state.admissionState = `failed: ${String(error)}` })
  })
  await workerStarted
  const clickStarted = Date.now()
  await page.getByRole("button", { name: "Open workspaces" }).click({ timeout: 1500 })
  await expect(page.getByRole("dialog", { name: "Workspaces", exact: true })).toBeVisible({ timeout: 1500 })
  const menuLatencyMs = Date.now() - clickStarted
  expect(await page.evaluate(() => (window as unknown as { admissionState: string }).admissionState)).toBe("pending")
  console.info(`Admission Worker: 20,001 changes; menu visible in ${menuLatencyMs}ms while validation pending`)
  await page.evaluate(async () => {
    const { WorkspaceStorage } = await import("/src/storage.ts")
    const A = await import("/@id/@automerge/automerge/slim")
    const state = window as unknown as { admissionFixture: { id: string; before: string[] }; admissionState: string }
    const durable = (await new WorkspaceStorage().loadWorkspaceDoc(state.admissionFixture.id))!.doc
    if (state.admissionState === "pending" && JSON.stringify(A.getHeads(durable)) !== JSON.stringify(state.admissionFixture.before)) {
      throw new Error("Unverified candidate reached durable storage")
    }
  })
  await expect.poll(() => page.evaluate(() => (window as unknown as { admissionState: string }).admissionState), { timeout: 60_000 }).toBe("committed")
  await page.reload()
  // Cold startup restores the accepted history before enabling board controls.
  // Its duration is separate from the menu responsiveness assertion above.
  expect(await page.evaluate(async () => {
    const { useMatch } = await import("/src/state.ts")
    await useMatch().whenReady()
    return useMatch().getActiveDoc()!.title
  })).toBe("Remote history 20000")
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
})

for (const failure of ["worker startup", "forged signature"] as const) {
  test(`Given ${failure} fails admission, when a candidate arrives, then document and notifications remain unchanged`, async ({ page }) => {
    await page.goto("/")
    await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
    const result = await page.evaluate(async failure => {
      const { useMatch } = await import("/src/state.ts")
      const { prepareLocalChangeAuthorizations, exportAuthorizationBundle, exportAuthorizations } = await import("/src/sync/changeAuthorization.ts")
      const { WorkspaceStorage } = await import("/src/storage.ts")
      const A = await import("/@id/@automerge/automerge/slim")
      const match = useMatch()
      await match.whenReady()
      const base = match.getActiveDoc()!
      const remote = A.change(A.clone(base), draft => { draft.title = "Must not commit" })
      const proofs = await prepareLocalChangeAuthorizations(remote, match.getCurrentProfile()!, A.getChangesMetaSince(remote, A.getHeads(base)).map(change => change.hash))
      const bundle = await exportAuthorizationBundle(A.save(base), match.getCurrentProfile()!)
      const beforeProofs = JSON.stringify(await exportAuthorizations(A.save(base)))
      let notifications = 0
      const stop = match.subscribeLocalChanges(() => { notifications++ })
      const originalWorker = window.Worker
      if (failure === "worker startup") window.Worker = class { constructor() { throw new Error("Worker blocked") } } as unknown as typeof Worker
      else proofs[0]!.signed.signature += "forged"
      let error = ""
      try { await match.mergeAuthorizedWorkspace(base.id, A.save(remote), { ...bundle, records: [...bundle.records, ...proofs] }) }
      catch (cause) { error = String(cause) }
      finally { window.Worker = originalWorker; stop() }
      const durable = (await new WorkspaceStorage().loadWorkspaceDoc(base.id))!.doc
      return { error, notifications, before: A.getHeads(base), after: A.getHeads(durable), ui: A.getHeads(match.getActiveDoc()!), beforeProofs, afterProofs: JSON.stringify(await exportAuthorizations(A.save(durable))) }
    }, failure)
    expect(result.error).toMatch(failure === "worker startup" ? /Worker blocked/ : /signature/i)
    expect(result.notifications).toBe(0)
    expect(result.after).toEqual(result.before)
    expect(result.ui).toEqual(result.before)
    expect(result.afterProofs).toBe(result.beforeProofs)
  })
}
