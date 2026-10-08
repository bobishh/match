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
  const origin = "http://127.0.0.1:8080"
  const keeper = testIdentity()
  await page.route(`${origin}/.well-known/mesh-lighthouse`, route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      protocolVersions: [1],
      service: { personId: keeper.identity.personId, publicKey: keeper.identity.publicKey, deviceId: keeper.deviceId, certificates: keeper.certificates },
      displayName: "Test Lighthouse",
      capabilities: { products: ["match"], modes: ["replicate"], documentReplication: true, chatReplication: true, blobReplication: false, pairing: false, provisioning: false },
      publicOrigin: origin,
      managementPath: "/admin",
    }),
  }))
  await page.route(`${origin}/v1/integrations/status`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { operationId: string; controllerPersonId: string; controllerDeviceId: string } } }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(keeper.sign({
      kind: "lighthouse-integration-status", version: 1,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      controllerPersonId: request.signed.payload.controllerPersonId,
      controllerDeviceId: request.signed.payload.controllerDeviceId,
      operationId: request.signed.payload.operationId, revision: 0,
      capabilities: { integrationSettings: true }, integrations: [], issuedAt: Math.floor(Date.now() / 1000),
    })) })
  })
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
    const request = route.request().postDataJSON() as { signed: { payload: { controllerOrigin?: string; body: { policy: { futureBoards: boolean } } } } }
    expect(request.signed.payload.body.policy.futureBoards).toBe(true)
    expect(request.signed.payload.controllerOrigin).toBeUndefined()
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

for (const lateResponse of ["pending", "failure"] as const) {
test(`Given an older status poll is still verifying, when provision confirms active, then a late ${lateResponse} cannot change that pairing`, async ({ page }) => {
  const origin = `http://127.0.0.1:${process.env.TINCANBAN_E2E_PORT ?? "4244"}`
  const keeper = testIdentity()
  let transcriptHash = ""
  let nonce = ""
  let controllerApproved = false
  let statusPolls = 0
  let provisionRequests = 0
  let olderPendingSent = false
  let approvedWorkspaceIds: string[] = []
  let releaseOlderPending: (() => void) | undefined
  let signalOlderPending: (() => void) | undefined
  const olderPendingStarted = new Promise<void>(resolve => { signalOlderPending = resolve })
  await page.route(`${origin}/.well-known/mesh-lighthouse`, route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ protocolVersions: [1], service: { personId: keeper.identity.personId, publicKey: keeper.identity.publicKey,
      deviceId: keeper.deviceId, certificates: keeper.certificates }, displayName: "Test Lighthouse",
      capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true, blobReplication: false, pairing: true, provisioning: true },
      publicOrigin: origin, managementPath: "/admin" }),
  }))
  await page.route(`${origin}/v1/integrations/status`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { operationId: string; controllerPersonId: string; controllerDeviceId: string } } }
    const integrations = provisionRequests ? [{ integrationId: "integration-poll-race", revision: 2,
      policy: { futureBoards: true, baselineWorkspaceIds: approvedWorkspaceIds.slice().sort() },
      scopes: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, grantEpoch: 1, state: "active", activationOperationId: "activation-poll-race" })),
      tombstones: [], pendingOperation: null }] : []
    const envelope = keeper.sign({ kind: "lighthouse-integration-status", version: 1,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      controllerPersonId: request.signed.payload.controllerPersonId, controllerDeviceId: request.signed.payload.controllerDeviceId,
      operationId: request.signed.payload.operationId, revision: integrations.length ? 2 : 0, integrations, issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })
  await page.route(`${origin}/v1/pairings`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: unknown } }
    transcriptHash = keeper.hash(request.signed.payload)
    const expiresAt = Math.floor(Date.now() / 1000) + 600
    nonce = randomBytes(32).toString("base64url")
    const challenge = keeper.sign({ kind: "lighthouse-pairing-challenge", version: 1, pairingId: "poll-race-test", transcriptHash,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin, nonce,
      integrationId: "integration-poll-race", issuedAt: Math.floor(Date.now() / 1000), expiresAt })
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ pairingId: "poll-race-test", expiresAt,
      operatorUrl: `${origin}/admin/?pairing=poll-race-test`, comparisonCode: "520184", transcriptHash, challenge }) })
  })
  await page.route(`${origin}/v1/pairings/poll-race-test/decision`, async route => {
    controllerApproved = true
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pairingId: "poll-race-test" }) })
  })
  await page.route(`${origin}/v1/pairings/poll-race-test/status`, async route => {
    statusPolls += 1
    const requestNumber = statusPolls
    const currentStatus = requestNumber >= 3 && controllerApproved ? "approved" : "pending"
    const approvalSnapshot = controllerApproved
    if (requestNumber === 2) {
      await new Promise<void>(resolve => { releaseOlderPending = resolve; signalOlderPending?.() })
    }
    if (requestNumber === 2 && lateResponse === "failure") {
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ message: "Temporary late status failure" }) })
      olderPendingSent = true
      return
    }
    const envelope = keeper.sign({ kind: "lighthouse-pairing-status", version: 1, pairingId: "poll-race-test",
      integrationId: "integration-poll-race", transcriptHash, servicePersonId: keeper.identity.personId,
      serviceDeviceId: keeper.deviceId, serviceOrigin: origin, expiresAt: Math.floor(Date.now() / 1000) + 600,
      operatorApproved: approvalSnapshot, controllerApproved: approvalSnapshot, status: currentStatus, provisioning: false,
      issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
    if (requestNumber === 2) olderPendingSent = true
  })
  await page.route(`${origin}/v1/pairings/poll-race-test/provision`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { body: { approvedScopes: { workspaceId: string }[] } } } }
    approvedWorkspaceIds = request.signed.payload.body.approvedScopes.map(scope => scope.workspaceId)
    provisionRequests += 1
    const envelope = keeper.sign({ kind: "lighthouse-pairing-status", version: 1, pairingId: "poll-race-test",
      integrationId: "integration-poll-race", transcriptHash, servicePersonId: keeper.identity.personId,
      serviceDeviceId: keeper.deviceId, serviceOrigin: origin, expiresAt: Math.floor(Date.now() / 1000) + 600,
      operatorApproved: true, controllerApproved: true, status: "active",
      provisioning: { status: "active", scopes: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, status: "active" })) },
      issuedAt: Math.floor(Date.now() / 1000) })
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
  await olderPendingStarted
  await expect(dialog.getByText("Waiting for both approvals. No access granted.")).toBeVisible()
  expect(provisionRequests).toBe(0)
  await dialog.getByRole("button", { name: "Code matches · approve" }).click()
  await expect(dialog.getByText("All selected boards activated and saved by Rusty.")).toBeVisible({ timeout: 10_000 })
  expect(provisionRequests).toBe(1)
  releaseOlderPending?.()
  await expect.poll(() => olderPendingSent).toBe(true)
  if (lateResponse === "pending") await page.waitForTimeout(2100)
  else await page.waitForLoadState("networkidle")
  await expect(dialog.getByText("All selected boards activated and saved by Rusty.")).toBeVisible()
  await expect(dialog.getByText("Waiting for operator approval. No access granted.")).toHaveCount(0)
  await expect(dialog.getByRole("alert").getByText("Temporary late status failure")).toHaveCount(0)
  expect(statusPolls).toBe(3)
  expect(nonce).toBeTruthy()
})
}

test("Given owner-origin admission support, when Rusty confirms the signed request, then one approval activates only its exact boards", async ({ page }) => {
  const origin = `http://127.0.0.1:${process.env.TINCANBAN_E2E_PORT ?? "4244"}`
  const keeper = testIdentity()
  let transcriptHash = ""
  let ownerPersonId = ""
  let ownerDeviceId = ""
  let challengeNonce = ""
  let controllerOrigin = ""
  let approvedWorkspaceIds: string[] = []
  let baselineWorkspaceIds: string[] = []
  let futureBoards = false
  let statusMode: "pending" | "wrong-origin" | "wrong-source" | "wrong-controller" | "wrong-device" | "wrong-scope" | "wrong-policy" | "approved" = "pending"
  let provisionRequests = 0
  await page.route(`${origin}/.well-known/mesh-lighthouse`, route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ protocolVersions: [1], service: { personId: keeper.identity.personId, publicKey: keeper.identity.publicKey, deviceId: keeper.deviceId, certificates: keeper.certificates }, displayName: "Test Lighthouse", capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true, blobReplication: false, pairing: true, provisioning: true, ownerOriginAdmission: true }, publicOrigin: origin, managementPath: "/admin" }),
  }))
  await page.route(`${origin}/v1/integrations/status`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { operationId: string; controllerPersonId: string; controllerDeviceId: string } } }
    const integrations = provisionRequests === 0 ? [] : [{ integrationId: "integration-origin", revision: 1,
      policy: { futureBoards, baselineWorkspaceIds },
      scopes: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, grantEpoch: 1, state: "active", activationOperationId: "activation-origin" })),
      tombstones: [], pendingOperation: null }]
    const envelope = keeper.sign({ kind: "lighthouse-integration-status", version: 1,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      controllerPersonId: request.signed.payload.controllerPersonId, controllerDeviceId: request.signed.payload.controllerDeviceId,
      operationId: request.signed.payload.operationId, revision: integrations.length ? 1 : 0,
      capabilities: { integrationSettings: false }, integrations, issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })
  await page.route(`${origin}/v1/pairings`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { controllerOrigin: string; controllerPersonId: string; controllerDeviceId: string; body: { scopes: { workspaceId: string }[]; policy: { futureBoards: boolean; baselineWorkspaceIds: string[] } } } } }
    ownerPersonId = request.signed.payload.controllerPersonId
    ownerDeviceId = request.signed.payload.controllerDeviceId
    controllerOrigin = request.signed.payload.controllerOrigin
    expect(controllerOrigin).toBe(new URL(page.url()).origin)
    approvedWorkspaceIds = request.signed.payload.body.scopes.map(scope => scope.workspaceId).sort()
    futureBoards = request.signed.payload.body.policy.futureBoards
    baselineWorkspaceIds = request.signed.payload.body.policy.baselineWorkspaceIds.slice().sort()
    transcriptHash = keeper.hash(request.signed.payload)
    const nonce = randomBytes(32).toString("base64url")
    challengeNonce = nonce
    const expiresAt = Math.floor(Date.now() / 1000) + 600
    const challenge = keeper.sign({ kind: "lighthouse-pairing-challenge", version: 1, pairingId: "pairing-origin", transcriptHash,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin, nonce,
      integrationId: "integration-origin", issuedAt: Math.floor(Date.now() / 1000), expiresAt })
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ pairingId: "pairing-origin", expiresAt,
      operatorUrl: `${origin}/admin/?pairing=pairing-origin`, comparisonCode: "867530", transcriptHash, challenge }) })
  })
  await page.route(`${origin}/v1/pairings/pairing-origin/decision`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { pairingId: string; transcriptHash: string; challengeNonce: string; decision: string } } }
    expect(request.signed.payload).toMatchObject({ pairingId: "pairing-origin", transcriptHash, challengeNonce, decision: "approve" })
    statusMode = "wrong-origin"
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pairingId: "pairing-origin" }) })
  })
  await page.route(`${origin}/v1/pairings/pairing-origin/status`, async route => {
    const status = statusMode === "pending" ? "pending" : "approved"
    const envelope = keeper.sign({ kind: "lighthouse-pairing-status", version: 1,
      pairingId: "pairing-origin", integrationId: "integration-origin", transcriptHash,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      controllerPersonId: statusMode === "wrong-controller" ? "another-owner" : ownerPersonId,
      controllerDeviceId: statusMode === "wrong-device" ? "another-device" : ownerDeviceId,
      controllerOrigin: statusMode === "wrong-origin" ? "https://foreign.example" : controllerOrigin,
      ...(status === "pending" ? {} : { admissionSource: statusMode === "wrong-source" ? "operator" : "owner_origin" }),
      approvedWorkspaceIds: statusMode === "wrong-scope" ? [] : approvedWorkspaceIds,
      futureBoards: statusMode === "wrong-policy" ? !futureBoards : futureBoards, baselineWorkspaceIds,
      operatorApproved: status !== "pending", controllerApproved: status !== "pending", status,
      provisioning: false,
      expiresAt: Math.floor(Date.now() / 1000) + 600, issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })
  await page.route(`${origin}/v1/pairings/pairing-origin/provision`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { body: { approvedScopes: { workspaceId: string }[]; invitation: { workspaces: { id: string }[] } } } } }
    const provisionedIds = request.signed.payload.body.approvedScopes.map(scope => scope.workspaceId).sort()
    expect(provisionedIds).toEqual(approvedWorkspaceIds)
    expect(request.signed.payload.body.invitation.workspaces.map(workspace => workspace.id).sort()).toEqual(approvedWorkspaceIds)
    provisionRequests++
    const envelope = keeper.sign({ kind: "lighthouse-pairing-status", version: 1,
      pairingId: "pairing-origin", integrationId: "integration-origin", transcriptHash,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      controllerPersonId: ownerPersonId, controllerDeviceId: ownerDeviceId, controllerOrigin,
      admissionSource: "owner_origin", approvedWorkspaceIds, futureBoards, baselineWorkspaceIds,
      operatorApproved: true, controllerApproved: true, status: "active",
      provisioning: { status: "active", scopes: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, status: "active" })) },
      expiresAt: Math.floor(Date.now() / 1000) + 600, issuedAt: Math.floor(Date.now() / 1000) })
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
  await expect(dialog.getByText("Review the requested boards and policy, then approve. No access granted yet.")).toBeVisible()
  await expect(dialog.getByText("Future boards: included.")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Approve and connect" })).toBeVisible()
  await expect(dialog.getByRole("link", { name: "Open operator approval" })).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Code matches · approve" })).toHaveCount(0)
  expect(provisionRequests).toBe(0)
  await dialog.getByRole("button", { name: "Approve and connect" }).click()
  await expect(dialog.getByText("Owner approval sent. Waiting for Rusty to confirm this request. No access granted.")).toBeVisible()
  await expect(dialog.getByRole("alert")).toContainText("did not confirm owner-origin approval", { timeout: 5000 })
  for (const invalidMode of ["wrong-source", "wrong-controller", "wrong-device", "wrong-scope", "wrong-policy"] as const) {
    statusMode = invalidMode
    const alert = dialog.getByRole("alert")
    await expect(alert).toContainText("did not confirm owner-origin approval", { timeout: 5000 })
    expect(provisionRequests).toBe(0)
    await alert.getByRole("button", { name: "Dismiss error" }).click()
  }
  statusMode = "approved"
  await expect(dialog.getByText("All selected boards activated and saved by Rusty.")).toBeVisible({ timeout: 10_000 })
  expect(provisionRequests).toBe(1)
})

test("Given a failed cancellation, when owner dismisses then starts a fresh request, then cleanup completes first and history stays hidden", async ({ page }) => {
  const origin = `http://127.0.0.1:${process.env.TINCANBAN_E2E_PORT ?? "4244"}`
  const keeper = testIdentity()
  let transcriptHash = ""
  let nonce = ""
  const expiresAt = Math.floor(Date.now() / 1000) + 600
  let statusFailure = false
  let pairingExpired = false
  let provisionRequests = 0
  let pairingCreationRequests = 0
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
    pairingCreationRequests += 1
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
    prototype.captureKeeperGrantScopeProofs = async function () {
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

  await dialog.getByRole("button", { name: "Dismiss from list" }).click()
  await expect(dialog.getByRole("region", { name: "Pending keeper requests" })).toHaveCount(0)
  await expect(dialog.getByRole("region", { name: "Saved keeper cancellation history" })).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Add keeper" })).toBeEnabled()
  const retainedBeforeReload = await page.evaluate(async () => (await import("/src/sync/ownerKeeper.ts")).pendingKeeperWithdrawals())
  expect(retainedBeforeReload).toHaveLength(1)

  await page.reload()
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog.getByRole("region", { name: "Saved keeper cancellation history" })).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Add keeper" })).toBeEnabled()
  const stillPendingAfterReload = await page.evaluate(async () => (await import("/src/sync/ownerKeeper.ts")).pendingKeeperWithdrawals())
  expect(stillPendingAfterReload).toHaveLength(1)
  await page.evaluate(async () => {
    const { DurableMesh } = await import("/src/sync/durableMesh.ts")
    ;(DurableMesh.prototype as unknown as { captureKeeperGrantScopeProofs: (...args: unknown[]) => Promise<unknown> })
      .captureKeeperGrantScopeProofs = async () => []
  })
  await dialog.getByRole("button", { name: "Add keeper" }).click()
  await dialog.getByRole("textbox", { name: "Keeper hostname" }).fill(origin)
  await dialog.getByRole("button", { name: "Discover keeper" }).click()
  await expect(dialog.getByRole("checkbox", { name: "Keeper board: Job search" })).toBeVisible()
  await dialog.getByRole("button", { name: "Request access" }).click()
  await expect(dialog.getByText("Waiting for both approvals. No access granted.")).toBeVisible()
  expect(pairingCreationRequests).toBe(2)
  expect(cancellationOperationId).toBe(savedOperationId)
  expect(provisionRequests).toBe(0)
  const remaining = await page.evaluate(async () => (await import("/src/sync/ownerKeeper.ts")).pendingKeeperWithdrawals())
  expect(remaining).toHaveLength(0)
})

test("Given cancellation is in flight, when owner dismisses before response, then late response cannot reopen stale request", async ({ page }) => {
  const origin = `http://127.0.0.1:${process.env.TINCANBAN_E2E_PORT ?? "4244"}`
  const keeper = testIdentity()
  let transcriptHash = ""
  let cancellationOperationId = ""
  let creationCount = 0
  let holdWithdrawal = false
  let releaseWithdrawal: (() => void) | undefined
  let signalWithdrawal: (() => void) | undefined
  const withdrawalStarted = new Promise<void>(resolve => { signalWithdrawal = resolve })
  await page.route(`${origin}/.well-known/mesh-lighthouse`, route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ protocolVersions: [1], service: { personId: keeper.identity.personId, publicKey: keeper.identity.publicKey,
      deviceId: keeper.deviceId, certificates: keeper.certificates }, displayName: "Test Lighthouse",
      capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true, blobReplication: false, pairing: true, provisioning: true },
      publicOrigin: origin, managementPath: "/admin" }),
  }))
  await page.route(`${origin}/v1/integrations/status`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { operationId: string; controllerPersonId: string; controllerDeviceId: string } } }
    const envelope = keeper.sign({ kind: "lighthouse-integration-status", version: 1, servicePersonId: keeper.identity.personId,
      serviceDeviceId: keeper.deviceId, serviceOrigin: origin, controllerPersonId: request.signed.payload.controllerPersonId,
      controllerDeviceId: request.signed.payload.controllerDeviceId, operationId: request.signed.payload.operationId,
      revision: 0, integrations: [], issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })
  await page.route(`${origin}/v1/pairings`, async route => {
    creationCount++
    const request = route.request().postDataJSON() as { signed: { payload: Record<string, unknown> } }
    transcriptHash = keeper.hash(request.signed.payload)
    const nonce = randomBytes(32).toString("base64url")
    const expiresAt = Math.floor(Date.now() / 1000) + 600
    const challenge = keeper.sign({ kind: "lighthouse-pairing-challenge", version: 1, pairingId: "pairing-dismiss-test", transcriptHash,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin, nonce,
      integrationId: "integration-dismiss-test", issuedAt: Math.floor(Date.now() / 1000), expiresAt })
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ pairingId: "pairing-dismiss-test", expiresAt,
      operatorUrl: `${origin}/admin/?pairing=pairing-dismiss-test`, comparisonCode: "104209", transcriptHash, challenge }) })
  })
  await page.route(`${origin}/v1/pairings/pairing-dismiss-test/status`, async route => {
    const envelope = keeper.sign({ kind: "lighthouse-pairing-status", version: 1, pairingId: "pairing-dismiss-test",
      integrationId: "integration-dismiss-test", transcriptHash, servicePersonId: keeper.identity.personId,
      serviceDeviceId: keeper.deviceId, serviceOrigin: origin, expiresAt: Math.floor(Date.now() / 1000) + 600,
      operatorApproved: false, controllerApproved: false, status: "pending", provisioning: false, issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })
  await page.route(`${origin}/v1/pairings/pairing-dismiss-test/withdraw`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: Record<string, unknown> } }
    cancellationOperationId = String(request.signed.payload.operationId)
    const semantic = { ...request.signed.payload }
    delete semantic.issuedAt
    delete semantic.expiresAt
    const requestHash = keeper.hash(semantic)
    const envelope = keeper.sign({ kind: "lighthouse-pairing-status", version: 1, pairingId: "pairing-dismiss-test",
      integrationId: "integration-dismiss-test", transcriptHash, servicePersonId: keeper.identity.personId,
      serviceDeviceId: keeper.deviceId, serviceOrigin: origin, status: "cancelled",
      withdrawal: { operationId: cancellationOperationId, requestHash, status: "cancelled" }, issuedAt: Math.floor(Date.now() / 1000) })
    if (holdWithdrawal) {
      await new Promise<void>(resolve => { releaseWithdrawal = resolve; signalWithdrawal?.() })
    }
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
  await expect(dialog.getByText("Waiting for both approvals. No access granted.")).toBeVisible()
  await page.evaluate(async () => {
    const { DurableMesh } = await import("/src/sync/durableMesh.ts")
    ;(DurableMesh.prototype as unknown as { captureKeeperGrantScopeProofs: (...args: unknown[]) => Promise<unknown> })
      .captureKeeperGrantScopeProofs = async () => []
  })
  holdWithdrawal = true
  await dialog.getByRole("button", { name: "Cancel keeper request" }).click()
  await withdrawalStarted
  await expect(dialog.getByRole("button", { name: "Dismiss from list" })).toBeEnabled()
  await dialog.getByRole("button", { name: "Dismiss from list" }).click()
  await expect(dialog.getByRole("button", { name: "Add keeper" })).toBeEnabled()
  expect(await page.evaluate(async () => (await import("/src/sync/ownerKeeper.ts")).pendingKeeperWithdrawals())).toHaveLength(1)
  releaseWithdrawal?.()
  await expect.poll(async () => page.evaluate(async () => (await import("/src/sync/ownerKeeper.ts")).pendingKeeperWithdrawals().then(rows => rows.length)))
    .toBe(0)
  await expect(dialog.getByRole("region", { name: "Pending keeper requests" })).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Add keeper" })).toBeEnabled()
  expect(cancellationOperationId).toBeTruthy()
  expect(creationCount).toBe(1)
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
