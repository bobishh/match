import { expect, test } from "./support/coverage"

test("Given a legacy offline keeper without a Rusty descriptor, when owner opens details, then Remove remains available", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/keeperRemoval.ts")).mountKeeperRemoval({ legacyWithoutServiceDescriptor: true }))

  const keepers = page.getByRole("list", { name: "Keeper services" })
  await keepers.getByRole("button", { name: /Old Lighthouse/ }).click()
  await expect(page.getByText("Keeper · Offline")).toBeVisible()
  await expect(page.getByRole("button", { name: "Remove keeper" })).toBeVisible()
  await page.getByRole("button", { name: "Remove keeper" }).click()
  await expect(page.getByText("Revoke this keeper’s local access now.")).toBeVisible()
  await page.getByRole("button", { name: "Revoke local access" }).click()
  await expect(page.getByRole("status", { name: "Keeper removal status" })).toContainText("Local access is revoked")
  const localState = await page.evaluate(async () => {
    const api = (window as typeof window & { keeperRemoval: { revokedScopes(): string[]; legacyPending(): Promise<{ removalPending?: boolean; boardIds: string[] } | undefined> } }).keeperRemoval
    return { revokedScopes: api.revokedScopes(), keeper: await api.legacyPending() }
  })
  expect(localState.revokedScopes).toEqual(["board"])
  expect(localState.keeper).toMatchObject({ removalPending: true, boardIds: ["board"] })
  await expect(page.getByRole("button", { name: "Retry removal" })).toHaveCount(0)
  await expect(page.getByLabel("Rusty address")).toBeVisible()
  await page.route("https://offline-rusty.invalid/.well-known/mesh-lighthouse", route => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ message: "Rusty offline" }),
  }))
  await page.getByLabel("Rusty address").fill("offline-rusty.invalid")
  await page.getByRole("button", { name: "Verify Rusty" }).click()
  await expect(page.getByRole("alert")).toContainText("Rusty offline")
  await expect(page.getByRole("status", { name: "Keeper removal status" })).toContainText("Local access is revoked")
  await page.getByRole("button", { name: "Back" }).click()
  const pendingRow = keepers.getByRole("button", { name: /Old Lighthouse/ })
  await expect(pendingRow).toContainText("Removal pending")
  await pendingRow.click()
  await expect(page.getByRole("status", { name: "Keeper removal status" })).toContainText("Local access is revoked")
  await page.reload()
  await expect(page.getByRole("button", { name: "Sync", exact: true })).toBeVisible({ timeout: 60_000 })
  const persistedAfterReload = await page.evaluate(async () => {
    const profile = await (await import("/src/domain/identity.ts")).bootstrapIdentity()
    const keepers = await (await import("/src/sync/ownerKeeper.ts")).ownerKeepers(profile.identity.personId)
    return keepers.find(record => record.personId === "old-keeper")?.details
  })
  expect(persistedAfterReload).toMatchObject({ removalPending: true, boardIds: ["board"], serviceDeviceIds: ["old-device"] })
  await page.evaluate(async () => (await import("/e2e/support/keeperRemoval.ts")).mountKeeperRemoval({
    legacyWithoutServiceDescriptor: true, reopenPersistedLegacyPending: true,
  }))
  const reopenedKeepers = page.getByRole("list", { name: "Keeper services" })
  const reopenedRow = reopenedKeepers.getByRole("button", { name: /Old Lighthouse/ })
  await expect(reopenedRow).toContainText("Removal pending")
  await reopenedRow.click()
  await expect(page.getByRole("status", { name: "Keeper removal status" })).toContainText("Local access is revoked")
})

test("Given local revocation fails for a legacy keeper, when owner retries, then incomplete access stays visible as pending", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/keeperRemoval.ts")).mountKeeperRemoval({
    legacyWithoutServiceDescriptor: true, legacyRevokeFails: true,
  }))

  const keepers = page.getByRole("list", { name: "Keeper services" })
  await keepers.getByRole("button", { name: /Old Lighthouse/ }).click()
  await page.getByRole("button", { name: "Remove keeper" }).click()
  await page.getByRole("button", { name: "Revoke local access" }).click()
  await expect(page.getByRole("alert")).toContainText("Local board revocation failed")
  await expect(page.getByRole("status", { name: "Keeper removal status" })).toContainText("Local access may still remain")
  const retryLocal = page.getByRole("button", { name: "Retry local revocation" })
  await expect(retryLocal).toBeEnabled()
  await retryLocal.click()
  await expect(page.getByRole("alert")).toContainText("Local board revocation failed")
  const pending = await page.evaluate(async () => {
    const api = (window as typeof window & { keeperRemoval: { legacyPending(): Promise<{ removalPending?: boolean } | undefined> } }).keeperRemoval
    return api.legacyPending()
  })
  expect(pending).toMatchObject({ removalPending: true, localRevocationComplete: false })
})

test("Given a connected keeper, when owner removes it, then access removal waits for completion and keeper leaves the list", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/keeperRemoval.ts")).mountKeeperRemoval())

  const keepers = page.getByRole("list", { name: "Keeper services" })
  await keepers.getByRole("button", { name: /Old Lighthouse/ }).click()
  await page.getByRole("button", { name: "Remove keeper" }).click()
  await expect(page.getByText("Remove access from all boards still owned by this identity?")).toBeVisible()
  await page.getByRole("button", { name: "Remove access from all boards" }).click()
  await expect(page.getByRole("button", { name: "Removing keeper…" })).toBeDisabled()
  await page.evaluate(() => (window as typeof window & { keeperRemoval: { complete(): void } }).keeperRemoval.complete())
  await expect(keepers.getByRole("button", { name: /Old Lighthouse/ })).toHaveCount(0)
})

test("Given keeper removal fails, when owner retries, then error stays visible and successful retry removes the keeper", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/keeperRemoval.ts")).mountKeeperRemoval())

  const keepers = page.getByRole("list", { name: "Keeper services" })
  await keepers.getByRole("button", { name: /Old Lighthouse/ }).click()
  await page.getByRole("button", { name: "Remove keeper" }).click()
  await page.getByRole("button", { name: "Remove access from all boards" }).click()
  await expect(page.getByRole("button", { name: "Removing keeper…" })).toBeDisabled()
  await page.evaluate(() => (window as typeof window & { keeperRemoval: { fail(): void } }).keeperRemoval.fail())
  await expect(page.getByRole("alert")).toContainText("Could not revoke keeper")
  await expect(page.getByRole("button", { name: "Retry removal" })).toBeEnabled()
  await page.getByRole("button", { name: "Back" }).click()
  await expect(keepers.getByRole("button", { name: /Old Lighthouse/ })).toBeVisible()
  await keepers.getByRole("button", { name: /Old Lighthouse/ }).click()
  await page.getByRole("button", { name: "Remove keeper" }).click()
  await page.getByRole("button", { name: "Remove access from all boards" }).click()
  await expect(page.getByRole("button", { name: "Removing keeper…" })).toBeDisabled()
  await page.evaluate(() => (window as typeof window & { keeperRemoval: { complete(): void } }).keeperRemoval.complete())
  await expect(keepers.getByRole("button", { name: /Old Lighthouse/ })).toHaveCount(0)
  expect(await page.evaluate(() => (window as typeof window & { keeperRemoval: { attempts(): number } }).keeperRemoval.attempts())).toBe(2)
})
