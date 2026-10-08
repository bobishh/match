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

function canonicalIntegrationId(controllerPersonId: string, servicePersonId: string): string {
  return createHash("sha256").update(`MESH-LIGHTHOUSE-INTEGRATION/1\0${controllerPersonId}\0${servicePersonId}`).digest("base64url")
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

async function seedMissingPairing(page: import("@playwright/test").Page, origin: string, pairingId: string,
  service: { personId: string; publicKey: string; deviceId: string; certificates: unknown[] },
  options: { integrationId?: string; workspaceId?: string; grantEpoch?: number } = {}) {
  return page.evaluate(async ({ origin, pairingId, service, options }) => {
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const { createWorkspaceGrant, defaultProofStore } = await import("/src/domain/proofs.ts")
    const { savePendingKeeperWithdrawal } = await import("/src/sync/ownerKeeper.ts")
    const profile = await bootstrapIdentity()
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(profile.identity.publicKey)))
    const fingerprint = [...digest].slice(0, 12).map(byte => byte.toString(16).padStart(2, "0")).join("")
      .match(/.{1,4}/g)?.join(":") ?? "unavailable"
    const workspaceId = options.workspaceId ?? "board-orphan"
    const integrationId = options.integrationId ?? "integration-orphan"
    const grant = options.grantEpoch === undefined ? undefined
      : await createWorkspaceGrant(profile, workspaceId, service.personId, "editor", options.grantEpoch)
    if (grant) await defaultProofStore.putGrant(grant.payload.grantId, grant)
    await savePendingKeeperWithdrawal(pairingId, "orphan-withdrawal", {
      pairingId, integrationId, operatorUrl: `${origin}/admin`, comparisonCode: "418203",
      expiresAt: Math.floor(Date.now() / 1000) - 60, transcriptHash: "saved-transcript", challengeNonce: "saved-nonce",
      controllerFingerprint: fingerprint,
      discovery: { origin, displayName: "Test Lighthouse", personId: service.personId, publicKey: service.publicKey,
        deviceId: service.deviceId, certificates: service.certificates, fingerprint: "service-fingerprint",
        capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true,
          blobReplication: false, pairing: true } },
      workspaces: [{ id: workspaceId, title: "Orphan board" }],
    }, grant ? [{ workspaceId, document: "saved-document-proof", authorizationBundle: { saved: true }, grant }] : [])
  }, { origin, pairingId, service, options })
}

test("Given board setup loses its response, when signed status confirms durable activation, then stale errors clear and keeper settings persist without another join", async ({ page }) => {
  const origin = `http://127.0.0.1:${process.env.TINCANBAN_E2E_PORT ?? "4244"}`
  const keeper = testIdentity()
  let integrationId = ""
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
    const request = route.request().postDataJSON() as { signed: { payload: { controllerPersonId: string; body: { policy: { futureBoards: boolean } } } } }
    expect(request.signed.payload.body.policy.futureBoards).toBe(true)
    integrationId = canonicalIntegrationId(request.signed.payload.controllerPersonId, keeper.identity.personId)
    transcriptHash = keeper.hash(request.signed.payload)
    nonce = randomBytes(32).toString("base64url")
    const expiresAt = Math.floor(Date.now() / 1000) + 600
    const challenge = keeper.sign({ kind: "lighthouse-pairing-challenge", version: 1, pairingId: "pairing-test", transcriptHash, servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin, nonce, integrationId, issuedAt: Math.floor(Date.now() / 1000), expiresAt })
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ pairingId: "pairing-test", expiresAt, operatorUrl: `${origin}/admin/?pairing=pairing-test`, comparisonCode: "314159", transcriptHash, challenge }) })
  })
  await page.route(`${origin}/v1/pairings/pairing-test/decision`, route => {
    controllerApproved = true
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pairingId: "pairing-test" }) })
  })
  await page.route(`${origin}/v1/pairings/pairing-test/status`, async route => {
    const status = provisionRequests > 0 ? "active" : controllerApproved ? "approved" : "pending"
    const provisioning = ["provisioning", "active"].includes(status) ? { status, scopes: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, status: status === "active" ? "active" : "pending" })) } : false
    const envelope = keeper.sign({ kind: "lighthouse-pairing-status", version: 1, pairingId: "pairing-test", integrationId, transcriptHash, servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin, expiresAt: Math.floor(Date.now() / 1000) + 600, operatorApproved: controllerApproved, controllerApproved, status, provisioning, issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })
  await page.route(`${origin}/v1/integrations/status`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { operationId: string; controllerPersonId: string; controllerDeviceId: string } } }
    const integrations = durableActivation ? [{ integrationId, revision: 2,
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
    const envelope = keeper.sign({ kind: "lighthouse-pairing-status", version: 1, pairingId: "pairing-test", integrationId, transcriptHash, servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin, expiresAt: Math.floor(Date.now() / 1000) + 600, operatorApproved: true, controllerApproved: true, status, provisioning: { status, scopes: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, status: status === "provisioning" ? "pending" : "active", ...(status === "provisioning" ? { error: "join_failed", errorDetail: "Mesh snapshot rejected: stale authorization epoch" } : {}) })) }, issuedAt: Math.floor(Date.now() / 1000) })
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

test("Given Rusty pruned an unissued pairing, when owner starts another request, then exact signed status clears outbox before access offer", async ({ page }) => {
  const origin = `http://127.0.0.1:${process.env.TINCANBAN_E2E_PORT ?? "4244"}`
  const keeper = testIdentity()
  let newPairingRequests = 0
  let completionRequests = 0
  let transcriptHash = ""
  let integrationId = ""
  await page.route(`${origin}/.well-known/mesh-lighthouse`, route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ protocolVersions: [1], service: { personId: keeper.identity.personId,
      publicKey: keeper.identity.publicKey, deviceId: keeper.deviceId, certificates: keeper.certificates },
      displayName: "Test Lighthouse", capabilities: { modes: ["replicate"], documentReplication: true,
        chatReplication: true, blobReplication: false, pairing: true }, publicOrigin: origin }),
  }))
  await page.route(`${origin}/v1/pairings/pruned-pairing/withdraw`, route =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "pairing not found" }) }))
  await page.route(`${origin}/v1/pairings/pruned-pairing/status`, route =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "pairing not found" }) }))
  await page.route(`${origin}/v1/pairings/pruned-pairing/withdraw/complete`, route => {
    completionRequests += 1
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "No cancellation receipt expected" }) })
  })
  await page.route(`${origin}/v1/pairings`, async route => {
    newPairingRequests += 1
    expect(newPairingRequests).toBe(1)
    const request = route.request().postDataJSON() as { signed: { payload: Record<string, unknown> & { controllerPersonId: string } } }
    integrationId = canonicalIntegrationId(request.signed.payload.controllerPersonId, keeper.identity.personId)
    const body = request.signed.payload.body as { integrationUpdate?: { expectedRevision?: number } }
    expect(body.integrationUpdate?.expectedRevision).toBe(5)
    transcriptHash = keeper.hash(request.signed.payload)
    const expiresAt = Math.floor(Date.now() / 1000) + 600
    const challenge = keeper.sign({ kind: "lighthouse-pairing-challenge", version: 1,
      pairingId: "fresh-after-orphan", transcriptHash, servicePersonId: keeper.identity.personId,
      serviceDeviceId: keeper.deviceId, serviceOrigin: origin, nonce: "fresh-orphan-nonce",
      integrationId, issuedAt: Math.floor(Date.now() / 1000), expiresAt })
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({
      pairingId: "fresh-after-orphan", expiresAt, operatorUrl: `${origin}/admin/?pairing=fresh-after-orphan`,
      comparisonCode: "314159", transcriptHash, challenge,
    }) })
  })
  await page.route(`${origin}/v1/pairings/fresh-after-orphan/status`, async route => {
    const payload = keeper.sign({ kind: "lighthouse-pairing-status", version: 1, pairingId: "fresh-after-orphan",
      integrationId, transcriptHash, servicePersonId: keeper.identity.personId,
      serviceDeviceId: keeper.deviceId, serviceOrigin: origin, expiresAt: Math.floor(Date.now() / 1000) + 600,
      operatorApproved: false, controllerApproved: false, status: "pending", provisioning: false,
      issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) })
  })
  await page.route(`${origin}/v1/pairings/fresh-after-orphan/decision`, route =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pairingId: "fresh-after-orphan" }) }))
  await page.route(`${origin}/v1/integrations/status`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: Record<string, string> } }
    const envelope = keeper.sign({ kind: "lighthouse-integration-status", version: 1,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      controllerPersonId: request.signed.payload.controllerPersonId,
      controllerDeviceId: request.signed.payload.controllerDeviceId, operationId: request.signed.payload.operationId,
      revision: 5, integrations: [{ integrationId, revision: 5,
        policy: { futureBoards: false, baselineWorkspaceIds: ["board-orphan"] }, scopes: [], tombstones: [] }],
      issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const controllerPersonId = await page.evaluate(async () =>
    (await import("/src/domain/identity.ts")).bootstrapIdentity().then(profile => profile.identity.personId))
  integrationId = canonicalIntegrationId(controllerPersonId, keeper.identity.personId)
  await seedMissingPairing(page, origin, "pruned-pairing", { ...keeper.identity, deviceId: keeper.deviceId,
    certificates: keeper.certificates }, { integrationId })
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog.getByRole("region", { name: "Saved keeper cancellation history" })).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Add keeper" })).toBeEnabled()
  await dialog.getByRole("button", { name: "Add keeper" }).click()
  await dialog.getByRole("textbox", { name: "Keeper hostname" }).fill(origin)
  await dialog.getByRole("button", { name: "Discover keeper" }).click()
  await dialog.getByRole("button", { name: "Request access" }).click()
  await expect(dialog.getByText("Waiting for both approvals. No access granted.")).toBeVisible()
  expect(newPairingRequests).toBe(1)
  expect(completionRequests).toBe(0)
  const saved = await page.evaluate(async () => (await import("/src/sync/ownerKeeper.ts")).pendingKeeperWithdrawals())
  const resolved = saved.find(entry => entry.pairingId === "pruned-pairing")
  expect(resolved?.orphanResolution?.serviceRevision).toBe(5)
  expect(resolved?.orphanResolution?.signedStatus.signature).toBeTruthy()
  expect(resolved?.orphanResolution?.localRevocationScopes).toEqual([])
})

test("Given a saved owner grant at epoch 5, when owner starts another request, then exact tombstone proof resolves cleanup privately before rebind", async ({ page }) => {
  const origin = `http://127.0.0.1:${process.env.TINCANBAN_E2E_PORT ?? "4244"}`
  const keeper = testIdentity()
  let integrationId = ""
  let workspaceId = ""
  let rebindUpdate: Record<string, unknown> | undefined
  await page.route(`${origin}/.well-known/mesh-lighthouse`, route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ protocolVersions: [1], service: { personId: keeper.identity.personId,
      publicKey: keeper.identity.publicKey, deviceId: keeper.deviceId, certificates: keeper.certificates },
      displayName: "Test Lighthouse", capabilities: { modes: ["replicate"], documentReplication: true,
        chatReplication: true, blobReplication: false, pairing: true }, publicOrigin: origin }),
  }))
  await page.route(`${origin}/v1/pairings/pruned-granted-pairing/withdraw`, route =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "pairing not found" }) }))
  await page.route(`${origin}/v1/pairings/pruned-granted-pairing/status`, route =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "pairing not found" }) }))
  await page.route(`${origin}/v1/pairings`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: Record<string, unknown> } }
    const body = request.signed.payload.body as Record<string, unknown>
    rebindUpdate = body.integrationUpdate as Record<string, unknown>
    const transcriptHash = keeper.hash(request.signed.payload)
    const expiresAt = Math.floor(Date.now() / 1000) + 600
    const challenge = keeper.sign({ kind: "lighthouse-pairing-challenge", version: 1,
      pairingId: "fresh-rebind", transcriptHash, servicePersonId: keeper.identity.personId,
      serviceDeviceId: keeper.deviceId, serviceOrigin: origin, nonce: "fresh-nonce",
      integrationId, issuedAt: Math.floor(Date.now() / 1000), expiresAt })
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({
      pairingId: "fresh-rebind", expiresAt, operatorUrl: `${origin}/admin/?pairing=fresh-rebind`,
      comparisonCode: "418204", transcriptHash, challenge,
    }) })
  })
  await page.route(`${origin}/v1/integrations/status`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: Record<string, string> } }
    const envelope = keeper.sign({ kind: "lighthouse-integration-status", version: 1,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      controllerPersonId: request.signed.payload.controllerPersonId,
      controllerDeviceId: request.signed.payload.controllerDeviceId, operationId: request.signed.payload.operationId,
      revision: 3, integrations: [{ integrationId, revision: 3,
        policy: { futureBoards: false, baselineWorkspaceIds: [workspaceId] }, scopes: [],
        tombstones: [{ workspaceId, grantEpoch: 5, state: "removed", cleanup: "complete", operationId: "verified-cleanup" }] }],
      issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const { controllerPersonId, ownedWorkspaceIds, eligibleWorkspaceIds } = await page.evaluate(async () => {
    const [{ defaultStorage }, { getEligibleKeeperWorkspaces }, { bootstrapIdentity }] = await Promise.all([
      import("/src/storage.ts"), import("/src/sync/lighthousePairing.ts"), import("/src/domain/identity.ts"),
    ])
    const profile = await bootstrapIdentity()
    const workspaces = await defaultStorage.listWorkspaces()
    const eligible = await getEligibleKeeperWorkspaces(workspaces.map(workspace => ({ id: workspace.id, title: workspace.title })))
    return { controllerPersonId: profile.identity.personId, ownedWorkspaceIds: workspaces.map(workspace => workspace.id).sort(),
      eligibleWorkspaceIds: eligible.map(workspace => workspace.id).sort() }
  })
  integrationId = canonicalIntegrationId(controllerPersonId, keeper.identity.personId)
  workspaceId = eligibleWorkspaceIds[0] ?? ""
  expect(workspaceId).not.toBe("")
  await seedMissingPairing(page, origin, "pruned-granted-pairing", { ...keeper.identity, deviceId: keeper.deviceId,
    certificates: keeper.certificates }, { integrationId, workspaceId, grantEpoch: 5 })
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog.getByRole("region", { name: "Saved keeper cancellation history" })).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Add keeper" })).toBeEnabled()
  await dialog.getByRole("button", { name: "Add keeper" }).click()
  await dialog.getByRole("textbox", { name: "Keeper hostname" }).fill(origin)
  await dialog.getByRole("button", { name: "Discover keeper" }).click()
  await dialog.getByRole("checkbox", { name: "Also replicate my future boards" }).check()
  await dialog.getByRole("button", { name: "Request access" }).click()
  await expect(dialog.getByText("418204")).toBeVisible({ timeout: 15_000 })
  await expect(dialog.getByRole("region", { name: "Saved keeper cancellation history" })).toHaveCount(0)
  expect(rebindUpdate).toMatchObject({ integrationId, expectedRevision: 3 })
  expect(rebindUpdate?.scopeWorkspaceIds).toEqual(eligibleWorkspaceIds)
  expect(rebindUpdate?.policy).toEqual({ futureBoards: true, baselineWorkspaceIds: ownedWorkspaceIds })
  const saved = await page.evaluate(async () => (await import("/src/sync/ownerKeeper.ts")).pendingKeeperWithdrawals())
  const resolved = saved.find(entry => entry.pairingId === "pruned-granted-pairing")
  expect(resolved?.orphanResolution?.serviceRevision).toBe(3)
  expect(resolved?.orphanResolution?.signedStatus.signature).toBeTruthy()
  expect(resolved?.orphanResolution?.localRevocationScopes.map(scope => scope.workspaceId)).toEqual([workspaceId])
  const ownerWorkspacesAfter = await page.evaluate(async () =>
    (await import("/src/storage.ts")).defaultStorage.listWorkspaces().then(workspaces => workspaces.map(workspace => workspace.id).sort()))
  expect(ownerWorkspacesAfter).toEqual(ownedWorkspaceIds)
})

test("Given Rusty status is signed for another controller device, when owner retries same target across reload, then private cleanup stays blocked", async ({ page }) => {
  const origin = `http://127.0.0.1:${process.env.TINCANBAN_E2E_PORT ?? "4244"}`
  const keeper = testIdentity()
  let offerRequests = 0
  await page.route(`${origin}/.well-known/mesh-lighthouse`, route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ protocolVersions: [1], service: { personId: keeper.identity.personId,
      publicKey: keeper.identity.publicKey, deviceId: keeper.deviceId, certificates: keeper.certificates },
      displayName: "Test Lighthouse", capabilities: { modes: ["replicate"], documentReplication: true,
        chatReplication: true, blobReplication: false, pairing: true }, publicOrigin: origin }),
  }))
  await page.route(`${origin}/v1/pairings/pruned-pairing/withdraw`, route =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "pairing not found" }) }))
  await page.route(`${origin}/v1/pairings/pruned-pairing/status`, route =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "pairing not found" }) }))
  await page.route(`${origin}/v1/pairings`, route => {
    offerRequests += 1
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "Cleanup proof must block new offers" }) })
  })
  await page.route(`${origin}/v1/integrations/status`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: Record<string, string> } }
    const envelope = keeper.sign({ kind: "lighthouse-integration-status", version: 1,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      controllerPersonId: request.signed.payload.controllerPersonId,
      controllerDeviceId: "another-controller-device", operationId: request.signed.payload.operationId,
      revision: 5, integrations: [{ integrationId: "integration-orphan", revision: 5,
        policy: { futureBoards: false, baselineWorkspaceIds: ["board-orphan"] }, scopes: [],
        tombstones: [{ workspaceId: "board-orphan", grantEpoch: 5, state: "removed", cleanup: "complete", operationId: "unrelated-cleanup" }] }],
      issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await seedMissingPairing(page, origin, "pruned-pairing", { ...keeper.identity, deviceId: keeper.deviceId,
    certificates: keeper.certificates })
  const attemptRequest = async () => {
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Device sync" })
    await expect(dialog.getByRole("region", { name: "Saved keeper cancellation history" })).toHaveCount(0)
    await dialog.getByRole("button", { name: "Add keeper" }).click()
    await dialog.getByRole("textbox", { name: "Keeper hostname" }).fill(origin)
    await dialog.getByRole("button", { name: "Discover keeper" }).click()
    await expect(dialog.getByRole("alert")).toContainText("Rusty status does not match this controller request.")
    await expect(dialog.getByRole("button", { name: "Request access" })).toHaveCount(0)
    await dialog.getByRole("button", { name: "Back" }).click()
    await expect(dialog.getByRole("button", { name: "Add keeper" })).toBeEnabled()
  }
  await attemptRequest()
  await page.reload()
  await ensureJobSearchWorkspace(page)
  await attemptRequest()
  expect(offerRequests).toBe(0)
  const saved = await page.evaluate(async () => (await import("/src/sync/ownerKeeper.ts")).pendingKeeperWithdrawals())
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ pairingId: "pruned-pairing", operationId: "orphan-withdrawal" })
  expect(saved[0].orphanResolution).toBeUndefined()
})

test("Given approved keeper setup is stuck, when the owner withdraws and Rusty cleanup is pending, then request stays visible until signed cancellation completes", async ({ page }) => {
  const origin = `http://127.0.0.1:${process.env.TINCANBAN_E2E_PORT ?? "4244"}`
  const keeper = testIdentity()
  let transcriptHash = ""
  let nonce = ""
  let controllerApproved = false
  let approvedWorkspaceIds: string[] = []
  let provisionRequests = 0
  let offerRequests = 0
  let activePairingId = "pairing-withdraw"
  let withdrawRequests = 0
  let disconnectRequests = 0
  let disconnectRequestHash = ""
  let withdrawalRequestHash = ""
  let capturedGrantScopes: unknown
  let cancellationComplete = false
  let withdrawalOperationId = ""
  let integrationId = ""
  await page.route(`${origin}/.well-known/mesh-lighthouse`, route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ protocolVersions: [1], service: { personId: keeper.identity.personId, publicKey: keeper.identity.publicKey, deviceId: keeper.deviceId, certificates: keeper.certificates }, displayName: "Test Lighthouse", capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true, blobReplication: false, pairing: true, provisioning: true }, publicOrigin: origin, managementPath: "/admin" }),
  }))
  await page.route(`${origin}/v1/pairings`, async route => {
    offerRequests += 1
    if (offerRequests > 1) {
      expect(cancellationComplete).toBe(true)
      activePairingId = "pairing-after-cleanup"
    }
    const request = route.request().postDataJSON() as { signed: { payload: Record<string, unknown> & { controllerPersonId: string } } }
    integrationId = canonicalIntegrationId(request.signed.payload.controllerPersonId, keeper.identity.personId)
    transcriptHash = keeper.hash(request.signed.payload)
    nonce = randomBytes(32).toString("base64url")
    const expiresAt = Math.floor(Date.now() / 1000) + 600
    const challenge = keeper.sign({ kind: "lighthouse-pairing-challenge", version: 1, pairingId: activePairingId, transcriptHash,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin, nonce,
      integrationId, issuedAt: Math.floor(Date.now() / 1000), expiresAt })
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ pairingId: activePairingId, expiresAt,
      operatorUrl: `${origin}/admin/?pairing=${activePairingId}`, comparisonCode: "271828", transcriptHash, challenge }) })
  })
  await page.route(`${origin}/v1/pairings/pairing-withdraw/decision`, route => {
    controllerApproved = true
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pairingId: "pairing-withdraw" }) })
  })
  await page.route(`${origin}/v1/pairings/pairing-withdraw/status`, async route => {
    const currentStatus = cancellationComplete ? "cancelled" : withdrawRequests > 0 ? "cancel_pending"
      : provisionRequests > 0 ? "provisioning" : controllerApproved ? "approved" : "pending"
    const payload: Record<string, unknown> = {
      kind: "lighthouse-pairing-status", version: 1, pairingId: "pairing-withdraw", integrationId,
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
  await page.route(`${origin}/v1/pairings/pairing-after-cleanup/status`, async route => {
    const payload = keeper.sign({ kind: "lighthouse-pairing-status", version: 1,
      pairingId: "pairing-after-cleanup", integrationId, transcriptHash,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      expiresAt: Math.floor(Date.now() / 1000) + 600, operatorApproved: false, controllerApproved: false,
      status: "pending", provisioning: false, issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) })
  })
  await page.route(`${origin}/v1/integrations/status`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { operationId: string; controllerPersonId: string; controllerDeviceId: string } } }
    const pending = disconnectRequests <= 2
    integrationId = canonicalIntegrationId(request.signed.payload.controllerPersonId, keeper.identity.personId)
    const integrations = approvedWorkspaceIds.length ? [{ integrationId, revision: pending ? 2 : 3,
      policy: { futureBoards: false, baselineWorkspaceIds: approvedWorkspaceIds.slice().sort() },
      scopes: [],
      tombstones: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, grantEpoch: 2,
        state: pending ? "pending" : "removed", cleanup: pending ? "pending" : "complete", operationId: withdrawalOperationId })),
      ...(pending ? { pendingOperation: { operationId: withdrawalOperationId, requestHash: disconnectRequestHash,
        expectedRevision: 1, scopes: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, expectedGrantEpoch: 2 })), status: "pending" } } : {}),
    }] : []
    const envelope = keeper.sign({ kind: "lighthouse-integration-status", version: 1,
      servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin,
      controllerPersonId: request.signed.payload.controllerPersonId, controllerDeviceId: request.signed.payload.controllerDeviceId,
      operationId: request.signed.payload.operationId, revision: pending ? 2 : 3, integrations,
      issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope) })
  })
  await page.route(`${origin}/v1/pairings/pairing-withdraw/provision`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: { body: { approvedScopes: { workspaceId: string }[] } } } }
    approvedWorkspaceIds = request.signed.payload.body.approvedScopes.map(scope => scope.workspaceId)
    provisionRequests += 1
    const payload = { kind: "lighthouse-pairing-status", version: 1, pairingId: "pairing-withdraw", integrationId,
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
      integrationId, transcriptHash, servicePersonId: keeper.identity.personId,
      serviceDeviceId: keeper.deviceId, serviceOrigin: origin, controllerPersonId: payload.controllerPersonId,
      controllerDeviceId: payload.controllerDeviceId, expiresAt: Math.floor(Date.now() / 1000) + 600,
      operatorApproved: true, controllerApproved: true, status: currentStatus,
      provisioning: { status: "provisioning", scopes: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, grantEpoch: 2,
        status: "pending", error: "join_failed", errorDetail: "Browser RPC timed out" })) },
      withdrawal: { operationId: withdrawalOperationId, requestHash: withdrawalRequestHash, status: currentStatus },
      issuedAt: Math.floor(Date.now() / 1000) })
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(receipt) })
  })
  await page.route(`${origin}/v1/integrations/*/disconnect`, async route => {
    const request = route.request().postDataJSON() as { signed: { payload: Record<string, unknown> } }
    const payload = request.signed.payload
    expect(payload).toMatchObject({ kind: "lighthouse-integration-disconnect", integrationId,
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
    const scopeStatus = disconnectRequests <= 2 ? "pending" : "removed"
    const receipt = keeper.sign({ kind: "lighthouse-integration-disconnect-receipt", version: 1,
      integrationId, operationId: withdrawalOperationId, requestHash,
      status: scopeStatus, revision: disconnectRequests <= 2 ? 2 : 3,
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
      integrationId, transcriptHash, servicePersonId: keeper.identity.personId,
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
  await expect(restoredDialog.getByRole("region", { name: "Saved keeper cancellation history" })).toHaveCount(0)
  await expect(restoredDialog.getByRole("button", { name: "Add keeper" })).toBeEnabled()
  const privateOutbox = await page.evaluate(async () => (await import("/src/sync/ownerKeeper.ts")).pendingKeeperWithdrawals())
  expect(privateOutbox).toHaveLength(1)
  expect(privateOutbox[0]).toMatchObject({ pairingId: "pairing-withdraw", operationId: withdrawalOperationId })
  expect(privateOutbox[0].grantScopes).toEqual(capturedGrantScopes)
  await restoredDialog.getByRole("button", { name: "Add keeper" }).click()
  await restoredDialog.getByRole("textbox", { name: "Keeper hostname" }).fill(origin)
  await restoredDialog.getByRole("button", { name: "Discover keeper" }).click()
  await restoredDialog.getByRole("button", { name: "Request access" }).click()
  await expect(restoredDialog.getByRole("alert")).toContainText("No new access request was sent.")
  expect(offerRequests).toBe(1)
  await restoredDialog.getByRole("button", { name: "Request access" }).click()
  await expect(restoredDialog.getByText("271828")).toBeVisible()
  await expect(restoredDialog.getByText("Waiting for both approvals. No access granted.")).toBeVisible()
  expect(offerRequests).toBe(2)
  expect(withdrawRequests).toBe(3)
  expect(disconnectRequests).toBe(3)
  expect(cancellationComplete).toBe(true)
  const outboxAfterCleanup = await page.evaluate(async () => (await import("/src/sync/ownerKeeper.ts")).pendingKeeperWithdrawals())
  expect(outboxAfterCleanup).toHaveLength(0)
  await expect(restoredDialog.getByText("Waiting for both approvals. No access granted.")).toBeVisible()
})
