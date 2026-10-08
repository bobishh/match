import { expect, test } from "./support/coverage"
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto"
import { ensureJobSearchWorkspace } from "./support/workspaces"

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function testIdentity() {
  const privateKey = (seed: Buffer) => createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" })
  const publicKeyRaw = (key: ReturnType<typeof privateKey>) => createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32)
  const id = (raw: Buffer) => createHash("sha256").update(raw).digest("base64url")
  const signPayload = (key: ReturnType<typeof privateKey>, payload: Record<string, unknown>, signerKeyId: string, domain: string) => ({
    payload, signerKeyId,
    signature: sign(null, Buffer.from(`${domain}/${String(payload.kind)}\0${canonical(payload)}`), key).toString("base64url"),
  })
  const identitySeed = randomBytes(32)
  const identityKey = privateKey(identitySeed)
  const identityPublicKey = publicKeyRaw(identityKey)
  const personId = id(identityPublicKey)
  const deviceSeed = randomBytes(32)
  const deviceKey = privateKey(deviceSeed)
  const devicePublicKey = publicKeyRaw(deviceKey)
  const deviceId = id(devicePublicKey)
  const certificate = signPayload(identityKey, {
    kind: "device-certificate", version: 1, personId, deviceId,
    devicePublicKey: devicePublicKey.toString("base64url"), issuerCertificateHash: null, canEnrollDevices: true,
  }, personId, "MATCH/1")
  const identity = { personId, publicKey: identityPublicKey.toString("base64url"), displayName: "Test Lighthouse" }
  return {
    identity, deviceId, certificates: [certificate],
    sign: (payload: Record<string, unknown>) => signPayload(deviceKey, payload, deviceId, "MESH-LIGHTHOUSE/1"),
    hash: (payload: unknown) => createHash("sha256").update(canonical(payload)).digest("base64url"),
  }
}

test("Given an owned board, when a Lighthouse origin is discovered, then tincanban shows identity, capabilities and pending-only boundary", async ({ page }) => {
  await page.route("http://127.0.0.1:8080/.well-known/mesh-lighthouse", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      protocolVersions: [1],
      service: { personId: "keeper-person", publicKey: "keeper-public-key", deviceId: "keeper-device", certificates: [] },
      displayName: "Test Lighthouse",
      capabilities: { products: ["match"], modes: ["replicate"], documentReplication: true, chatReplication: true, blobReplication: false, pairing: false, provisioning: false },
      publicOrigin: "http://127.0.0.1:8080",
      managementPath: "/admin",
    }),
  }))
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog.getByRole("button", { name: "Add keeper", exact: true }).locator("img")).toBeVisible()
  await dialog.getByRole("button", { name: "Add keeper", exact: true }).click()
  await dialog.getByRole("textbox", { name: "Keeper hostname" }).fill("http://127.0.0.1:8080")
  await dialog.getByRole("button", { name: "Discover keeper" }).click()
  await expect(dialog.getByRole("heading", { name: "Test Lighthouse" })).toBeVisible()
  await expect(dialog.getByText("Job search")).toBeVisible()
  await expect(dialog.getByText("This service cannot accept keeper requests.")).toBeVisible()
  await expect(dialog.getByText("Boards", { exact: true })).toBeVisible()
  await expect(dialog.getByText("Connected", { exact: true })).toHaveCount(0)
})

test("Given discovery reports another origin, when tincanban checks it, then it rejects identity redirection", async ({ page }) => {
  await page.route("http://127.0.0.1:8080/.well-known/mesh-lighthouse", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ protocolVersions: [1], service: { personId: "keeper-person", publicKey: "key", deviceId: "device", certificates: [] }, displayName: "Wrong origin", capabilities: {}, publicOrigin: "https://other.example", managementPath: "/admin" }),
  }))
  await page.goto("/")
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await dialog.getByRole("button", { name: "Add keeper" }).click()
  await dialog.getByRole("textbox", { name: "Keeper hostname" }).fill("http://127.0.0.1:8080")
  await dialog.getByRole("button", { name: "Discover keeper" }).click()
  await expect(dialog.getByRole("alert")).toContainText("origin does not match")
  await expect(dialog.getByRole("heading", { name: "Wrong origin" })).toHaveCount(0)
})

test("Given a compatible discovered keeper, when Rusty activates a board but its reply is lost, then retry reuses the approved pairing", async ({ page }) => {
  const origin = `http://127.0.0.1:${process.env.TINCANBAN_E2E_PORT ?? "4244"}`
  const keeper = testIdentity()
  let transcriptHash = ""
  let nonce = ""
  let controllerApproved = false
  let provisionRequests = 0
  let approvedWorkspaceIds: string[] = []
  let failStatusPollOnce = true
  await page.route(`${origin}/.well-known/mesh-lighthouse`, route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ protocolVersions: [1], service: { personId: keeper.identity.personId, publicKey: keeper.identity.publicKey, deviceId: keeper.deviceId, certificates: keeper.certificates }, displayName: "Test Lighthouse", capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true, blobReplication: false, pairing: true, provisioning: true }, publicOrigin: origin, managementPath: "/admin" }),
  }))
  await page.route(`${origin}/v1/pairings`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { body: { policy: { futureBoards: boolean } } } } }
    expect(request.signed.payload.body.policy.futureBoards).toBe(true)
    transcriptHash = keeper.hash(request.signed.payload)
    nonce = randomBytes(32).toString("base64url")
    const expiresAt = Math.floor(Date.now() / 1000) + 600
    const challenge = keeper.sign({ kind: "lighthouse-pairing-challenge", version: 1, pairingId: "pairing-test", transcriptHash, servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin, nonce, integrationId: "integration-test", issuedAt: Math.floor(Date.now() / 1000), expiresAt })
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ pairingId: "pairing-test", expiresAt, operatorUrl: `${origin}/admin/?pairing=pairing-test`, comparisonCode: "314159", transcriptHash, challenge }) })
  })
  await page.route(`${origin}/v1/pairings/pairing-test/decision`, route => {
    controllerApproved = true
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pairingId: "pairing-test" }) })
  })
  await page.route(`${origin}/v1/pairings/pairing-test/status`, async route => {
    if (failStatusPollOnce) {
      failStatusPollOnce = false
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ message: "Temporary status failure" }) })
      return
    }
    const status = provisionRequests > 0 ? "provisioning" : controllerApproved ? "approved" : "pending"
    const provisioning = status === "provisioning" ? { status, scopes: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, status: "pending" })) } : false
    const envelope = keeper.sign({ kind: "lighthouse-pairing-status", version: 1, pairingId: "pairing-test", integrationId: "integration-test", transcriptHash, servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin, expiresAt: Math.floor(Date.now() / 1000) + 600, operatorApproved: controllerApproved, controllerApproved, status, provisioning, issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })
  await page.route(`${origin}/v1/integrations/status`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { operationId: string; controllerPersonId: string; controllerDeviceId: string } } }
    const integrations = provisionRequests === 0 ? [] : [{ integrationId: "integration-test", revision: 2,
      policy: { futureBoards: true, baselineWorkspaceIds: approvedWorkspaceIds.slice().sort() },
      scopes: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, grantEpoch: 1, state: "active", activationOperationId: "activation-test" })),
      tombstones: [], pendingOperation: null }]
    const envelope = keeper.sign({ kind: "lighthouse-integration-status", version: 1,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      controllerPersonId: request.signed.payload.controllerPersonId,
      controllerDeviceId: request.signed.payload.controllerDeviceId,
      operationId: request.signed.payload.operationId, revision: integrations.length ? 2 : 0, integrations,
      issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })
  await page.route(`${origin}/v1/pairings/pairing-test/provision`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { body: { pairingId: string; transcriptHash: string; servicePersonId: string; futureBoards: boolean; approvedScopes: { workspaceId: string; mode: string }[]; invitation: { kind: string; role: string; workspaces: { id: string }[] } } } } }
    expect(request.signed.payload.body.futureBoards).toBe(true)
    expect(request.signed.payload.body.pairingId).toBe("pairing-test")
    expect(request.signed.payload.body.transcriptHash).toBe(transcriptHash)
    expect(request.signed.payload.body.servicePersonId).toBe(keeper.identity.personId)
    expect(request.signed.payload.body.invitation.kind).toBe("workspace-join")
    expect(request.signed.payload.body.invitation.role).toBe("editor")
    approvedWorkspaceIds = request.signed.payload.body.approvedScopes.map(scope => scope.workspaceId)
    expect(request.signed.payload.body.approvedScopes.every(scope => scope.mode === "replicate")).toBe(true)
    expect(approvedWorkspaceIds).toEqual(request.signed.payload.body.invitation.workspaces.map(workspace => workspace.id))
    provisionRequests += 1
    if (provisionRequests === 1) {
      // Rusty activated the scope, but the owner lost the response.
      await route.abort("failed")
      return
    }
    const envelope = keeper.sign({ kind: "lighthouse-pairing-status", version: 1, pairingId: "pairing-test", integrationId: "integration-test", transcriptHash, servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin, expiresAt: Math.floor(Date.now() / 1000) + 600, operatorApproved: true, controllerApproved: true, status: "active", provisioning: { status: "active", scopes: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, status: "active" })) }, issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog.getByText("Device sync", { exact: true })).toHaveCount(1)
  await dialog.getByRole("button", { name: "Add keeper" }).click()
  await dialog.getByRole("textbox", { name: "Keeper hostname" }).fill(origin)
  await dialog.getByRole("button", { name: "Discover keeper" }).click()
  await expect(dialog.getByRole("checkbox", { name: "Also replicate my future boards" })).toBeChecked()
  await expect(dialog.locator(".sync-workspace-detail")).toHaveText(["Editor access", "Editor access"])
  await dialog.getByRole("button", { name: "Request access" }).click()
  await expect(dialog.getByText("Waiting for both approvals. No access granted.")).toBeVisible()
  await expect(dialog.getByRole("alert")).toContainText("Temporary status failure")
  await expect(dialog.getByText("Temporary status failure")).toHaveCount(0)
  await dialog.getByRole("button", { name: "Back" }).click()
  const pendingKeeper = dialog.getByRole("list", { name: "Pending keeper requests" })
  await expect(pendingKeeper).toContainText("Approval pending · no access yet")
  await expect(dialog.getByRole("button", { name: "Add keeper" })).toBeDisabled()
  await pendingKeeper.getByRole("button", { name: /Test Lighthouse/ }).click()
  await expect(dialog.getByText("Waiting for both approvals. No access granted.")).toBeVisible()
  await expect(dialog.getByText("314159")).toBeVisible()
  await expect(dialog.getByRole("link", { name: "Open operator approval" })).toHaveAttribute("href", /\/admin/)
  await dialog.getByRole("button", { name: "Code matches · approve" }).click()
  await expect(dialog.getByRole("alert")).toBeVisible({ timeout: 5000 })
  await dialog.getByRole("button", { name: "Retry board setup" }).click()
  await expect(dialog.getByText("All selected boards activated and saved by Rusty.")).toBeVisible({ timeout: 10_000 })
  expect(provisionRequests).toBeGreaterThanOrEqual(2)
})

test("Given cancellation proof capture fails, when pairing expires and owner reloads, then saved intent stays retryable until signed cancellation", async ({ page }) => {
  const origin = `http://127.0.0.1:${process.env.TINCANBAN_E2E_PORT ?? "4244"}`
  const keeper = testIdentity()
  let transcriptHash = ""
  let nonce = ""
  let expiresAt = Math.floor(Date.now() / 1000) + 600
  let statusFailure = false
  let pairingExpired = false
  let provisionRequests = 0
  let cancellationOperationId = ""
  await page.route(`${origin}/.well-known/mesh-lighthouse`, route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ protocolVersions: [1], service: { personId: keeper.identity.personId, publicKey: keeper.identity.publicKey, deviceId: keeper.deviceId, certificates: keeper.certificates }, displayName: "Test Lighthouse", capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true, blobReplication: false, pairing: true, provisioning: true }, publicOrigin: origin, managementPath: "/admin" }),
  }))
  await page.route(`${origin}/v1/integrations/status`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { operationId: string; controllerPersonId: string; controllerDeviceId: string } } }
    const envelope = keeper.sign({ kind: "lighthouse-integration-status", version: 1,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      controllerPersonId: request.signed.payload.controllerPersonId, controllerDeviceId: request.signed.payload.controllerDeviceId,
      operationId: request.signed.payload.operationId, revision: 0, integrations: [], issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })
  await page.route(`${origin}/v1/pairings`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: Record<string, unknown> } }
    transcriptHash = keeper.hash(request.signed.payload)
    nonce = randomBytes(32).toString("base64url")
    const challenge = keeper.sign({ kind: "lighthouse-pairing-challenge", version: 1, pairingId: "pairing-cancel-test", transcriptHash,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin, nonce,
      integrationId: "integration-cancel-test", issuedAt: Math.floor(Date.now() / 1000), expiresAt })
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ pairingId: "pairing-cancel-test", expiresAt,
      operatorUrl: `${origin}/admin/?pairing=pairing-cancel-test`, comparisonCode: "271828", transcriptHash, challenge }) })
  })
  await page.route(`${origin}/v1/pairings/pairing-cancel-test/status`, async route => {
    if (statusFailure) {
      statusFailure = false
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ message: "Temporary status failure" }) })
      return
    }
    const envelope = keeper.sign({ kind: "lighthouse-pairing-status", version: 1, pairingId: "pairing-cancel-test", integrationId: "integration-cancel-test",
      transcriptHash, servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      expiresAt, operatorApproved: false, controllerApproved: false, status: pairingExpired ? "expired" : "pending", provisioning: false, issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })
  await page.route(`${origin}/v1/pairings/pairing-cancel-test/decision`, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pairingId: "pairing-cancel-test" }) }))
  await page.route(`${origin}/v1/pairings/pairing-cancel-test/withdraw`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: Record<string, unknown> } }
    cancellationOperationId = String(request.signed.payload.operationId)
    const semantic = { ...request.signed.payload }
    delete semantic.issuedAt
    delete semantic.expiresAt
    const requestHash = keeper.hash(semantic)
    const envelope = keeper.sign({ kind: "lighthouse-pairing-status", version: 1, pairingId: "pairing-cancel-test", integrationId: "integration-cancel-test",
      transcriptHash, servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin, status: "cancelled",
      withdrawal: { operationId: cancellationOperationId, requestHash, status: "cancelled" }, issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })
  await page.route(`${origin}/v1/pairings/pairing-cancel-test/provision`, async route => {
    provisionRequests += 1
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "Provisioning must stay blocked during cancellation" }) })
  })

  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  let dialog = page.getByRole("dialog", { name: "Device sync" })
  await dialog.getByRole("button", { name: "Add keeper" }).click()
  await dialog.getByRole("textbox", { name: "Keeper hostname" }).fill(origin)
  await dialog.getByRole("button", { name: "Discover keeper" }).click()
  await dialog.getByRole("button", { name: "Request access" }).click()
  await expect(dialog.getByText("Waiting for both approvals. No access granted.")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Cancel keeper request" })).toBeVisible()

  await page.evaluate(async () => {
    const { DurableMesh } = await import("/src/sync/durableMesh.ts")
    const prototype = DurableMesh.prototype as unknown as { captureKeeperGrantScopeProofs: (...args: unknown[]) => Promise<unknown> }
    const capture = prototype.captureKeeperGrantScopeProofs
    prototype.captureKeeperGrantScopeProofs = async function (...args: unknown[]) {
      prototype.captureKeeperGrantScopeProofs = capture
      throw new Error("Simulated owner proof capture failure")
    }
  })
  await dialog.getByRole("button", { name: "Cancel keeper request" }).click()
  await expect(dialog.getByRole("alert")).toContainText("Simulated owner proof capture failure")
  await expect(dialog.getByRole("button", { name: "Retry cancellation" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Dismiss from list" })).toBeVisible()
  const savedOperationId = await page.evaluate(async () => {
    const { pendingKeeperWithdrawals } = await import("/src/sync/ownerKeeper.ts")
    return (await pendingKeeperWithdrawals())[0]?.operationId ?? ""
  })
  expect(savedOperationId).toBeTruthy()

  await page.evaluate(() => {
    const originalNow = Date.now
    Date.now = () => originalNow() + 700_000
  })
  pairingExpired = true
  statusFailure = true
  await expect(dialog.getByRole("button", { name: "Retry cancellation" })).toBeVisible()
  await expect.poll(() => statusFailure, { timeout: 5000 }).toBe(false)
  await expect(dialog.getByRole("button", { name: "Retry cancellation" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Dismiss from list" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Start new request" })).toHaveCount(0)
  expect(provisionRequests).toBe(0)

  await page.reload()
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  dialog = page.getByRole("dialog", { name: "Device sync" })
  const history = dialog.getByRole("region", { name: "Saved keeper cancellation history" })
  await expect(history).toContainText("Cancellation pending · retry available")
  await history.getByRole("button", { name: "Restore request" }).click()
  await expect(dialog.getByRole("button", { name: "Retry cancellation" })).toBeVisible()
  await page.evaluate(async () => {
    const { DurableMesh } = await import("/src/sync/durableMesh.ts")
    const prototype = DurableMesh.prototype as unknown as { captureKeeperGrantScopeProofs: (...args: unknown[]) => Promise<unknown> }
    prototype.captureKeeperGrantScopeProofs = async () => []
  })
  await dialog.getByRole("button", { name: "Retry cancellation" }).click()
  await expect(dialog.getByText("Keeper request cancelled. No access granted.")).toBeVisible()
  expect(cancellationOperationId).toBe(savedOperationId)
  expect(provisionRequests).toBe(0)
  const remaining = await page.evaluate(async () => (await import("/src/sync/ownerKeeper.ts")).pendingKeeperWithdrawals())
  expect(remaining).toEqual([])
})

test("Given a failed status poll, when Rusty later reports expiry, then the stale network error clears", async ({ page }) => {
  const origin = `http://127.0.0.1:${process.env.TINCANBAN_E2E_PORT ?? "4244"}`
  const keeper = testIdentity()
  let transcriptHash = ""
  let poll = 0
  await page.route(`${origin}/.well-known/mesh-lighthouse`, route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ protocolVersions: [1], service: { personId: keeper.identity.personId, publicKey: keeper.identity.publicKey,
      deviceId: keeper.deviceId, certificates: keeper.certificates }, displayName: "Test Lighthouse",
      capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true, blobReplication: false, pairing: true, provisioning: true },
      publicOrigin: origin, managementPath: "/admin" }),
  }))
  await page.route(`${origin}/v1/integrations/status`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { operationId: string; controllerPersonId: string; controllerDeviceId: string } } }
    const envelope = keeper.sign({ kind: "lighthouse-integration-status", version: 1,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      controllerPersonId: request.signed.payload.controllerPersonId, controllerDeviceId: request.signed.payload.controllerDeviceId,
      operationId: request.signed.payload.operationId, revision: 0, integrations: [], issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })
  await page.route(`${origin}/v1/pairings`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: unknown } }
    transcriptHash = keeper.hash(request.signed.payload)
    const now = Math.floor(Date.now() / 1000)
    const expiresAt = now + 600
    const challenge = keeper.sign({ kind: "lighthouse-pairing-challenge", version: 1, pairingId: "expiry-test", transcriptHash,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      nonce: randomBytes(32).toString("base64url"), integrationId: "expiry-integration", issuedAt: now, expiresAt })
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ pairingId: "expiry-test", expiresAt,
      operatorUrl: `${origin}/admin/?pairing=expiry-test`, comparisonCode: "123456", transcriptHash, challenge }) })
  })
  await page.route(`${origin}/v1/pairings/expiry-test/status`, async route => {
    poll += 1
    if (poll === 1) {
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ message: "Temporary status failure" }) })
      return
    }
    const now = Math.floor(Date.now() / 1000)
    const envelope = keeper.sign({ kind: "lighthouse-pairing-status", version: 1, pairingId: "expiry-test",
      integrationId: "expiry-integration", transcriptHash, servicePersonId: keeper.identity.personId,
      serviceDeviceId: keeper.deviceId, serviceOrigin: origin, expiresAt: now + 600,
      operatorApproved: false, controllerApproved: false, status: "expired", provisioning: null, issuedAt: now })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })

  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await dialog.getByRole("button", { name: "Add keeper" }).click()
  await dialog.getByRole("textbox", { name: "Keeper hostname" }).fill(origin)
  await dialog.getByRole("button", { name: "Discover keeper" }).click()
  await dialog.getByRole("button", { name: "Request access" }).click()
  await expect(dialog.getByRole("alert")).toContainText("Temporary status failure")
  await expect(dialog.getByText("Pairing expired. No access granted.")).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByText("Temporary status failure")).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Start new request" })).toBeVisible()
})
