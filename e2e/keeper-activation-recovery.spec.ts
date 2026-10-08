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

test("Given board setup loses its response, when signed status confirms durable activation, then stale errors clear and keeper settings persist without another join", async ({ page }) => {
  const origin = `http://127.0.0.1:${process.env.TINCANBAN_E2E_PORT ?? "4244"}`
  const keeper = testIdentity()
  let transcriptHash = ""
  let nonce = ""
  let controllerApproved = false
  let provisionRequests = 0
  let durableActivation = false
  let approvedWorkspaceIds: string[] = []
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
    const status = provisionRequests > 0 ? "active" : controllerApproved ? "approved" : "pending"
    const provisioning = ["provisioning", "active"].includes(status) ? { status, scopes: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, status: status === "active" ? "active" : "pending" })) } : false
    const envelope = keeper.sign({ kind: "lighthouse-pairing-status", version: 1, pairingId: "pairing-test", integrationId: "integration-test", transcriptHash, servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin, expiresAt: Math.floor(Date.now() / 1000) + 600, operatorApproved: controllerApproved, controllerApproved, status, provisioning, issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })
  await page.route(`${origin}/v1/integrations/status`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { operationId: string; controllerPersonId: string; controllerDeviceId: string } } }
    const integrations = durableActivation ? [{ integrationId: "integration-test", revision: 2,
      policy: { futureBoards: true, baselineWorkspaceIds: approvedWorkspaceIds.slice().sort() },
      scopes: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, grantEpoch: 1, state: "active", activationOperationId: "activation-test" })),
      tombstones: [], pendingOperation: null }] : []
    const envelope = keeper.sign({ kind: "lighthouse-integration-status", version: 1,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      controllerPersonId: request.signed.payload.controllerPersonId,
      controllerDeviceId: request.signed.payload.controllerDeviceId,
      operationId: request.signed.payload.operationId, revision: durableActivation ? 2 : 0,
      capabilities: { integrationSettings: true }, integrations,
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
    durableActivation = true
    expect(request.signed.payload.body.approvedScopes.every(scope => scope.mode === "replicate")).toBe(true)
    expect(approvedWorkspaceIds).toEqual(request.signed.payload.body.invitation.workspaces.map(workspace => workspace.id))
    provisionRequests += 1
    const status = provisionRequests === 1 ? "provisioning" : "active"
    const envelope = keeper.sign({ kind: "lighthouse-pairing-status", version: 1, pairingId: "pairing-test", integrationId: "integration-test", transcriptHash, servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin, expiresAt: Math.floor(Date.now() / 1000) + 600, operatorApproved: true, controllerApproved: true, status, provisioning: { status, scopes: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, status: status === "provisioning" ? "pending" : "active", ...(status === "provisioning" ? { error: "join_failed", errorDetail: "Mesh snapshot rejected: stale authorization epoch" } : {}) })) }, issuedAt: Math.floor(Date.now() / 1000) })
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
  await dialog.getByRole("button", { name: "Request access" }).click()
  await expect(dialog.getByText("Waiting for both approvals. No access granted.")).toBeVisible()
  await dialog.getByRole("button", { name: "Back" }).click()
  const pendingKeeper = dialog.getByRole("list", { name: "Pending keeper requests" })
  await expect(pendingKeeper).toContainText("Approval pending · no access yet")
  await expect(dialog.getByRole("button", { name: "Add keeper" })).toBeDisabled()
  await pendingKeeper.getByRole("button", { name: /Test Lighthouse/ }).click()
  await expect(dialog.getByText("Waiting for both approvals. No access granted.")).toBeVisible()
  await expect(dialog.getByText("314159")).toBeVisible()
  await expect(dialog.getByRole("link", { name: "Open operator approval" })).toHaveAttribute("href", /\/admin/)
  await dialog.getByRole("button", { name: "Code matches · approve" }).click()
  await expect(dialog.getByText(/Both sides approved\. (Lighthouse|Rusty) is saving boards; access remains pending\./)).toBeVisible({ timeout: 5000 })
  await expect(dialog.getByRole("alert")).toContainText(/(Lighthouse|Rusty) could not join the selected boards/)
  await expect(dialog.getByRole("alert")).toContainText("Mesh snapshot rejected: stale authorization epoch")
  await expect(dialog.getByText(/All selected boards activated and saved by (Lighthouse|Rusty)\./)).toBeVisible({ timeout: 10_000 })
  await expect(dialog.getByRole("alert")).toHaveCount(0)
  expect(provisionRequests).toBe(1)
  const details = await page.evaluate(async personId => {
    const { keeperApi } = await import("/src/app/keeperApi.ts")
    return keeperApi.keeperDetails(personId)
  }, keeper.identity.personId)
  expect(details).toMatchObject({ origin, boardIds: approvedWorkspaceIds, futureBoards: true })
})

test("Given approved keeper setup is stuck, when the owner withdraws and Rusty cleanup is pending, then request stays visible until signed cancellation completes", async ({ page }) => {
  const origin = `http://127.0.0.1:${process.env.TINCANBAN_E2E_PORT ?? "4244"}`
  const keeper = testIdentity()
  let transcriptHash = ""
  let nonce = ""
  let controllerApproved = false
  let approvedWorkspaceIds: string[] = []
  let provisionRequests = 0
  let withdrawRequests = 0
  let disconnectRequests = 0
  let disconnectRequestHash = ""
  let withdrawalRequestHash = ""
  let capturedGrantScopes: unknown
  let cancellationComplete = false
  let withdrawalOperationId = ""
  await page.route(`${origin}/.well-known/mesh-lighthouse`, route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ protocolVersions: [1], service: { personId: keeper.identity.personId, publicKey: keeper.identity.publicKey, deviceId: keeper.deviceId, certificates: keeper.certificates }, displayName: "Test Lighthouse", capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true, blobReplication: false, pairing: true, provisioning: true }, publicOrigin: origin, managementPath: "/admin" }),
  }))
  await page.route(`${origin}/v1/pairings`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: Record<string, unknown> } }
    transcriptHash = keeper.hash(request.signed.payload)
    nonce = randomBytes(32).toString("base64url")
    const expiresAt = Math.floor(Date.now() / 1000) + 600
    const challenge = keeper.sign({ kind: "lighthouse-pairing-challenge", version: 1, pairingId: "pairing-withdraw", transcriptHash,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin, nonce,
      integrationId: "integration-withdraw", issuedAt: Math.floor(Date.now() / 1000), expiresAt })
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ pairingId: "pairing-withdraw", expiresAt,
      operatorUrl: `${origin}/admin/?pairing=pairing-withdraw`, comparisonCode: "271828", transcriptHash, challenge }) })
  })
  await page.route(`${origin}/v1/pairings/pairing-withdraw/decision`, route => {
    controllerApproved = true
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pairingId: "pairing-withdraw" }) })
  })
  await page.route(`${origin}/v1/pairings/pairing-withdraw/status`, async route => {
    const currentStatus = cancellationComplete ? "cancelled" : withdrawRequests > 0 ? "cancel_pending"
      : provisionRequests > 0 ? "provisioning" : controllerApproved ? "approved" : "pending"
    const payload: Record<string, unknown> = {
      kind: "lighthouse-pairing-status", version: 1, pairingId: "pairing-withdraw", integrationId: "integration-withdraw",
      transcriptHash, servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      expiresAt: Math.floor(Date.now() / 1000) + 600, operatorApproved: controllerApproved, controllerApproved,
      status: currentStatus, provisioning: ["provisioning", "cancel_pending"].includes(currentStatus) ? { status: "provisioning", scopes: approvedWorkspaceIds.map(workspaceId => ({
        workspaceId, status: "pending", grantEpoch: 2, error: "join_failed", errorDetail: "Browser RPC timed out",
      })) } : false, issuedAt: Math.floor(Date.now() / 1000),
    }
    if (withdrawRequests > 0) payload.withdrawal = { operationId: withdrawalOperationId, requestHash: withdrawalRequestHash,
      status: currentStatus === "cancelled" ? "cancelled" : "cancel_pending" }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(keeper.sign(payload)) })
  })
  await page.route(`${origin}/v1/integrations/status`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { operationId: string; controllerPersonId: string; controllerDeviceId: string } } }
    const pending = disconnectRequests === 1
    const integrations = approvedWorkspaceIds.length ? [{ integrationId: "integration-withdraw", revision: pending ? 2 : 1,
      policy: { futureBoards: false, baselineWorkspaceIds: approvedWorkspaceIds.slice().sort() },
      scopes: pending ? [] : approvedWorkspaceIds.map(workspaceId => ({ workspaceId, grantEpoch: 2, state: "active", activationOperationId: "activation-withdraw" })),
      tombstones: pending ? approvedWorkspaceIds.map(workspaceId => ({ workspaceId, grantEpoch: 2,
        state: "pending", cleanup: "pending", operationId: withdrawalOperationId })) : [],
      ...(pending ? { pendingOperation: { operationId: withdrawalOperationId, requestHash: disconnectRequestHash,
        expectedRevision: 1, scopes: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, expectedGrantEpoch: 2 })), status: "pending" } } : {}),
    }] : []
    const envelope = keeper.sign({ kind: "lighthouse-integration-status", version: 1,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      controllerPersonId: request.signed.payload.controllerPersonId, controllerDeviceId: request.signed.payload.controllerDeviceId,
      operationId: request.signed.payload.operationId, revision: pending ? 2 : 1, integrations,
      issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })
  await page.route(`${origin}/v1/pairings/pairing-withdraw/provision`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { body: { approvedScopes: { workspaceId: string }[] } } } }
    approvedWorkspaceIds = request.signed.payload.body.approvedScopes.map(scope => scope.workspaceId)
    provisionRequests += 1
    const payload = { kind: "lighthouse-pairing-status", version: 1, pairingId: "pairing-withdraw", integrationId: "integration-withdraw",
      transcriptHash, servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      expiresAt: Math.floor(Date.now() / 1000) + 600, operatorApproved: true, controllerApproved: true, status: "provisioning",
      provisioning: { status: "provisioning", scopes: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, status: "pending", grantEpoch: 2,
        error: "join_failed", errorDetail: "Browser RPC timed out" })) }, issuedAt: Math.floor(Date.now() / 1000) }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(keeper.sign(payload)) })
  })
  await page.route(`${origin}/v1/pairings/pairing-withdraw/withdraw`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: Record<string, unknown> } }
    const payload = request.signed.payload
    expect(payload).toMatchObject({ kind: "lighthouse-pairing-withdrawal", version: 1,
      pairingId: "pairing-withdraw", transcriptHash, challengeNonce: nonce,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin })
    expect(typeof payload.operationId).toBe("string")
    expect(payload.operationId).not.toBe("")
    if (withdrawRequests === 0) {
      withdrawalOperationId = payload.operationId as string
      capturedGrantScopes = JSON.parse(JSON.stringify(payload.grantScopes))
      expect(Array.isArray(capturedGrantScopes)).toBe(true)
      expect(capturedGrantScopes).toHaveLength(approvedWorkspaceIds.length)
      const semanticPayload = { ...payload }
      delete semanticPayload.issuedAt
      delete semanticPayload.expiresAt
      withdrawalRequestHash = keeper.hash(semanticPayload)
    }
    else {
      expect(payload.operationId).toBe(withdrawalOperationId)
      expect(payload.grantScopes).toEqual(capturedGrantScopes)
    }
    withdrawRequests += 1
    const currentStatus = "cancel_pending"
    const receipt = keeper.sign({ kind: "lighthouse-pairing-status", version: 1, pairingId: "pairing-withdraw",
      integrationId: "integration-withdraw", transcriptHash, servicePersonId: keeper.identity.personId,
      serviceDeviceId: keeper.deviceId, serviceOrigin: origin, controllerPersonId: payload.controllerPersonId,
      controllerDeviceId: payload.controllerDeviceId, expiresAt: Math.floor(Date.now() / 1000) + 600,
      operatorApproved: true, controllerApproved: true, status: currentStatus,
      provisioning: { status: "provisioning", scopes: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, grantEpoch: 2,
        status: "pending", error: "join_failed", errorDetail: "Browser RPC timed out" })) },
      withdrawal: { operationId: withdrawalOperationId, requestHash: withdrawalRequestHash, status: currentStatus },
      issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(receipt) })
  })
  await page.route(`${origin}/v1/integrations/integration-withdraw/disconnect`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: Record<string, unknown> } }
    const payload = request.signed.payload
    expect(payload).toMatchObject({ kind: "lighthouse-integration-disconnect", integrationId: "integration-withdraw",
      operationId: withdrawalOperationId, expectedRevision: 1 })
    expect(payload.scopes).toEqual(approvedWorkspaceIds.map(workspaceId => ({ workspaceId, expectedGrantEpoch: 2 })))
    const semanticPayload = { ...payload }
    delete semanticPayload.controllerDeviceId
    delete semanticPayload.issuedAt
    delete semanticPayload.expiresAt
    const requestHash = keeper.hash(semanticPayload)
    if (disconnectRequests === 0) disconnectRequestHash = requestHash
    else expect(requestHash).toBe(disconnectRequestHash)
    disconnectRequests += 1
    const scopeStatus = disconnectRequests === 1 ? "pending" : "removed"
    const receipt = keeper.sign({ kind: "lighthouse-integration-disconnect-receipt", version: 1,
      integrationId: "integration-withdraw", operationId: withdrawalOperationId, requestHash,
      status: scopeStatus, revision: disconnectRequests === 1 ? 2 : 3,
      controllerPersonId: payload.controllerPersonId, servicePersonId: keeper.identity.personId,
      serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      scopes: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, grantEpoch: 2,
        state: scopeStatus, cleanup: scopeStatus === "removed" ? "complete" : "pending" })),
      issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: scopeStatus === "pending" ? 202 : 200,
      contentType: "application/json", body: JSON.stringify(receipt) })
  })
  await page.route(`${origin}/v1/pairings/pairing-withdraw/withdraw/complete`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: Record<string, unknown> } }
    const payload = request.signed.payload
    expect(payload).toMatchObject({ kind: "lighthouse-pairing-withdrawal-complete", version: 1,
      pairingId: "pairing-withdraw", withdrawalOperationId, transcriptHash, challengeNonce: nonce })
    expect(payload.scopes).toHaveLength(approvedWorkspaceIds.length)
    cancellationComplete = true
    const receipt = keeper.sign({ kind: "lighthouse-pairing-status", version: 1, pairingId: "pairing-withdraw",
      integrationId: "integration-withdraw", transcriptHash, servicePersonId: keeper.identity.personId,
      serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      controllerPersonId: payload.controllerPersonId, controllerDeviceId: payload.controllerDeviceId,
      expiresAt: Math.floor(Date.now() / 1000) + 600, operatorApproved: true, controllerApproved: true,
      status: "cancelled", withdrawal: { operationId: withdrawalOperationId,
        requestHash: withdrawalRequestHash, status: "cancelled" }, issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(receipt) })
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
  await dialog.getByRole("button", { name: "Code matches · approve" }).click()
  await expect(dialog.getByRole("alert")).toContainText("Browser RPC timed out")
  await expect(dialog.getByRole("button", { name: "Cancel keeper request" })).toBeVisible()
  const seededGrantCount = await page.evaluate(async ({ workspaceIds, personId }) => {
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const { createWorkspaceGrant, defaultProofStore } = await import("/src/domain/proofs.ts")
    const profile = await bootstrapIdentity()
    for (const workspaceId of workspaceIds) {
      const grant = await createWorkspaceGrant(profile, workspaceId, personId, "editor", 2)
      await defaultProofStore.putGrant(grant.payload.grantId, grant)
    }
    return workspaceIds.length
  }, { workspaceIds: approvedWorkspaceIds, personId: keeper.identity.personId })
  expect(seededGrantCount).toBe(approvedWorkspaceIds.length)
  await dialog.getByRole("button", { name: "Cancel keeper request" }).click()
  await expect(dialog.getByRole("status")).toContainText("cancellation is still pending")
  await expect(dialog.getByRole("button", { name: "Retry cancellation" })).toBeVisible()
  await page.reload()
  await ensureJobSearchWorkspace(page)
  await expect.poll(() => page.evaluate(async workspaceIds => {
    const [{ bootstrapIdentity }, { peerStore }] = await Promise.all([
      import("/src/domain/identity.ts"), import("/src/sync/peerStore.ts"),
    ])
    const profile = await bootstrapIdentity()
    const credentials = await Promise.all(workspaceIds.map(id => peerStore.getWorkspaceCredential(id)))
    return credentials.filter(credential => credential?.ownerPersonId === profile.identity.personId).length
  }, approvedWorkspaceIds), { message: "owner workspace credentials reload before cancellation retry", timeout: 5000 })
    .toBe(approvedWorkspaceIds.length)
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const restoredDialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(restoredDialog.getByRole("region", { name: "Saved keeper cancellation history" })).toContainText("Cancellation pending")
  await restoredDialog.getByRole("region", { name: "Saved keeper cancellation history" }).getByRole("button", { name: "Restore request" }).click()
  await expect(restoredDialog.getByRole("button", { name: "Retry cancellation" })).toBeVisible()
  await restoredDialog.getByRole("button", { name: "Dismiss from list" }).click()
  await expect(restoredDialog.getByRole("list", { name: "Pending keeper requests" })).toHaveCount(0)
  await expect(restoredDialog.getByRole("region", { name: "Keeper request history" })).toContainText("Cancellation pending")
  await expect(restoredDialog.getByRole("button", { name: "Add keeper" })).toBeDisabled()
  await restoredDialog.getByRole("region", { name: "Keeper request history" }).getByRole("button", { name: "Restore request" }).click()
  await expect(restoredDialog.getByRole("button", { name: "Retry cancellation" })).toBeVisible()
  await restoredDialog.getByRole("button", { name: "Retry cancellation" }).click()
  try {
    await expect(restoredDialog.getByText("Keeper request cancelled. No access granted.")).toBeVisible()
  } catch (cause) {
    console.error("keeper cancellation failure", JSON.stringify({
      withdrawRequests, disconnectRequests, cancellationComplete,
      status: await restoredDialog.getByRole("status").allInnerTexts().catch(() => []),
      alerts: await restoredDialog.getByRole("alert").allInnerTexts().catch(() => []),
      cause: cause instanceof Error ? cause.message : String(cause),
    }))
    throw cause
  }
  await restoredDialog.getByRole("button", { name: "Back" }).click()
  await expect(restoredDialog.getByRole("button", { name: "Add keeper" })).toBeEnabled()
  expect(withdrawRequests).toBe(2)
  expect(disconnectRequests).toBe(2)
  expect(cancellationComplete).toBe(true)
})
