import { expect, test } from "./support/coverage"
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto"

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function keeperSigner() {
  const privateKey = (seed: Buffer) => createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" })
  const publicKeyRaw = (key: ReturnType<typeof privateKey>) => createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32)
  const id = (raw: Buffer) => createHash("sha256").update(raw).digest("base64url")
  const signPayload = (key: ReturnType<typeof privateKey>, payload: Record<string, unknown>, signerKeyId: string, domain: string) => ({
    payload, signerKeyId, signature: sign(null, Buffer.from(`${domain}/${String(payload.kind)}\0${canonical(payload)}`), key).toString("base64url"),
  })
  const identityKey = privateKey(createHash("sha256").update("keeper-removal-test-identity").digest())
  const identityPublicKey = publicKeyRaw(identityKey)
  const personId = id(identityPublicKey)
  const deviceKey = privateKey(createHash("sha256").update("keeper-removal-test-device").digest())
  const devicePublicKey = publicKeyRaw(deviceKey)
  const deviceId = id(devicePublicKey)
  const certificate = signPayload(identityKey, {
    kind: "device-certificate", version: 1, personId, deviceId,
    devicePublicKey: devicePublicKey.toString("base64url"), issuerCertificateHash: null, canEnrollDevices: true,
  }, personId, "MATCH/1")
  return {
    personId, deviceId, publicKey: identityPublicKey.toString("base64url"), certificates: [certificate],
    sign: (payload: Record<string, unknown>) => signPayload(deviceKey, payload, deviceId, "MESH-LIGHTHOUSE/1"),
  }
}

test("Given Rusty confirms removal but local keeper cleanup fails, when owner retries after reload, then saved receipt finishes cleanup", async ({ page }) => {
  const origin = `http://127.0.0.1:${process.env.TINCANBAN_E2E_PORT ?? "4244"}`
  const service = keeperSigner()
  let removed = false
  let removalOperationId = ""
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey | IDBKeyRange) {
      if (String(key).startsWith("tincanban.owner-keepers.v1:") && value === "[]"
        && !sessionStorage.getItem("fail-owner-keeper-delete")) {
        sessionStorage.setItem("fail-owner-keeper-delete", "failed")
        throw new DOMException("Injected keeper record cleanup failure", "QuotaExceededError")
      }
      return put.call(this, value, key)
    }
  })
  await page.route(`${origin}/v1/integrations/status`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { operationId: string; controllerPersonId: string; controllerDeviceId: string } } }
    const tombstones = removed ? [{ workspaceId: "board", grantEpoch: 1, operationId: removalOperationId, state: "removed", cleanup: "complete" }] : []
    const payload = service.sign({ kind: "lighthouse-integration-status", version: 1, servicePersonId: service.personId,
      serviceDeviceId: service.deviceId, serviceOrigin: origin, controllerPersonId: request.signed.payload.controllerPersonId,
      controllerDeviceId: request.signed.payload.controllerDeviceId, operationId: request.signed.payload.operationId,
      revision: removed ? 2 : 1, integrations: [{ integrationId: "integration-old", revision: removed ? 2 : 1,
        policy: { futureBoards: false, baselineWorkspaceIds: ["board"] },
        scopes: removed ? [] : [{ workspaceId: "board", grantEpoch: 1, state: "active", activationOperationId: "activation" }],
        tombstones, pendingOperation: null }], issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) })
  })
  await page.route(`${origin}/v1/integrations/integration-old/disconnect`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: Record<string, unknown> } }
    const payload = { ...request.signed.payload }
    removalOperationId = String(payload.operationId)
    delete payload.controllerDeviceId
    delete payload.issuedAt
    delete payload.expiresAt
    const requestHash = createHash("sha256").update(canonical(payload)).digest("base64url")
    removed = true
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(service.sign({
      kind: "lighthouse-integration-disconnect-receipt", version: 1, integrationId: "integration-old",
      operationId: removalOperationId, status: "removed", requestHash, revision: 2,
      controllerPersonId: request.signed.payload.controllerPersonId, servicePersonId: service.personId,
      serviceDeviceId: service.deviceId, serviceOrigin: origin,
      scopes: [{ workspaceId: "board", grantEpoch: 1, state: "removed", cleanup: "complete" }], issuedAt: Math.floor(Date.now() / 1000),
    })) })
  })

  await page.goto("/")
  await page.evaluate(async fixture => (await import("/e2e/support/keeperRemoval.ts")).mountKeeperRemoval({ canonicalService: fixture }), {
    origin, personId: service.personId, deviceId: service.deviceId, publicKey: service.publicKey, certificates: service.certificates,
  })
  await removeKeeperFromFixture(page)
  await expect(page.getByRole("alert")).toContainText("Rusty confirmed removal; local keeper cleanup is pending")
  const savedReceipt = await page.evaluate(async () => {
    const { keeperIntegrationReferences } = await import("/src/sync/ownerKeeper.ts")
    return (await keeperIntegrationReferences()).integrations["integration-old"]?.completedRemoval
  })
  expect(savedReceipt).toMatchObject({ operationId: removalOperationId, scopes: [{ workspaceId: "board", grantEpoch: 1 }] })

  await page.reload()
  await page.getByRole("button", { name: "Sync", exact: true }).waitFor()
  await page.evaluate(async fixture => (await import("/e2e/support/keeperRemoval.ts")).mountKeeperRemoval({
    canonicalService: fixture, reopenPersistedLegacyPending: true,
  }), { origin, personId: service.personId, deviceId: service.deviceId, publicKey: service.publicKey, certificates: service.certificates })
  await removeKeeperFromFixture(page)
  await expect(page.getByText("No keepers connected to this board.", { exact: true })).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
  const localState = await page.evaluate(async () => {
    const profile = await (await import("/src/domain/identity.ts")).bootstrapIdentity()
    const { ownerKeepers, keeperIntegrationReferences } = await import("/src/sync/ownerKeeper.ts")
    return { records: await ownerKeepers(profile.identity.personId), reference: (await keeperIntegrationReferences()).integrations["integration-old"] }
  })
  expect(localState.records).toEqual([])
  expect(localState.reference?.completedRemoval?.operationId).toBe(removalOperationId)
  expect(localState.reference?.scopeReceipts).toEqual([])
})

async function removeKeeperFromFixture(page: import("@playwright/test").Page) {
  const keepers = page.getByRole("list", { name: "Keeper services" })
  await keepers.getByRole("button", { name: /Old Lighthouse/ }).click()
  await page.getByRole("button", { name: "Remove keeper", exact: true }).click()
  await page.getByRole("button", { name: "Remove access from all boards" }).click()
}

test("Given a legacy offline keeper without a Rusty descriptor, when owner removes it, then access is revoked and removal finishes without service confirmation", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/keeperRemoval.ts")).mountKeeperRemoval({ legacyWithoutServiceDescriptor: true }))
  const keepers = page.getByRole("list", { name: "Keeper services" })
  await keepers.getByRole("button", { name: /Old Lighthouse/ }).click()
  await page.getByRole("button", { name: "Remove keeper", exact: true }).click()
  await page.getByRole("button", { name: "Remove keeper now", exact: true }).click()
  await expect(page.getByText("No keepers connected to this board.", { exact: true })).toBeVisible()
  await expect(keepers.getByRole("button", { name: /Old Lighthouse/ })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Verify Rusty" })).toHaveCount(0)
  const localState = await page.evaluate(async () => {
    const api = (window as typeof window & { keeperRemoval: { revokedScopes(): string[]; legacyPending(): Promise<unknown> } }).keeperRemoval
    return { scopes: api.revokedScopes(), keeper: await api.legacyPending() }
  })
  expect(localState.scopes).toEqual(["board"])
  expect(localState.keeper).toBeUndefined()
  await page.reload()
  await expect(page.getByRole("button", { name: "Sync", exact: true })).toBeVisible()
  const records = await page.evaluate(async () => {
    const profile = await (await import("/src/domain/identity.ts")).bootstrapIdentity()
    return (await (await import("/src/sync/ownerKeeper.ts")).ownerKeepers(profile.identity.personId)).filter(record => record.personId === "old-keeper")
  })
  expect(records).toEqual([])
})

test("Given local revocation fails for a legacy keeper, when owner retries, then incomplete access stays visible as pending", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/keeperRemoval.ts")).mountKeeperRemoval({
    legacyWithoutServiceDescriptor: true, legacyRevokeFails: true,
  }))

  const keepers = page.getByRole("list", { name: "Keeper services" })
  await keepers.getByRole("button", { name: /Old Lighthouse/ }).click()
  await page.getByRole("button", { name: "Remove keeper" }).click()
  await page.getByRole("button", { name: "Remove keeper now" }).click()
  await expect(page.getByRole("alert")).toContainText("Local board revocation failed")
  await expect(page.getByRole("status", { name: "Keeper removal status" })).toContainText("Removal did not finish")
  const retryLocal = page.getByRole("button", { name: "Retry removal" })
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


test("Given a legacy offline keeper without saved boards, when owner removes it, then owned boards are recovered and access is revoked without contacting Rusty", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/keeperRemoval.ts")).mountKeeperRemoval({
    legacyWithoutServiceDescriptor: true, legacyMissingBoardList: true,
  }))
  await page.getByRole("list", { name: "Keeper services" }).getByRole("button", { name: /Old Lighthouse/ }).click()
  await page.getByRole("button", { name: "Remove keeper" }).click()
  await page.getByRole("button", { name: "Remove keeper now" }).click()
  await expect(page.getByText("No keepers connected to this board.", { exact: true })).toBeVisible()
  await expect(page.getByRole("list", { name: "Keeper services" }).getByRole("button", { name: /Old Lighthouse/ })).toHaveCount(0)
  await expect(page.getByRole("alert")).toHaveCount(0)
  const saved = await page.evaluate(async () => {
    const api = (window as typeof window & { keeperRemoval: { revokedScopes(): string[]; legacyPending(): Promise<unknown> } }).keeperRemoval
    return { scopes: api.revokedScopes(), pending: await api.legacyPending() }
  })
  expect(saved.scopes).toEqual(["board"])
  expect(saved.pending).toBeUndefined()
})
