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
    const envelope = keeper.sign({ kind: "lighthouse-pairing-status", version: 1, pairingId: "pairing-test", transcriptHash, servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin, expiresAt: Math.floor(Date.now() / 1000) + 600, operatorApproved: controllerApproved, controllerApproved, status, provisioning, issuedAt: Math.floor(Date.now() / 1000) })
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
    const status = provisionRequests === 1 ? "provisioning" : "active"
    const envelope = keeper.sign({ kind: "lighthouse-pairing-status", version: 1, pairingId: "pairing-test", transcriptHash, servicePersonId: keeper.identity.personId, serviceDeviceId: keeper.deviceId, serviceOrigin: origin, expiresAt: Math.floor(Date.now() / 1000) + 600, operatorApproved: true, controllerApproved: true, status, provisioning: { status, scopes: approvedWorkspaceIds.map(workspaceId => ({ workspaceId, status: status === "provisioning" ? "pending" : "active", ...(status === "provisioning" ? { error: "join_failed", errorDetail: "Mesh snapshot rejected: stale authorization epoch" } : {}) })) }, issuedAt: Math.floor(Date.now() / 1000) })
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
  await expect(dialog.getByText("Both sides approved. Rusty is saving boards; access remains pending.")).toBeVisible({ timeout: 5000 })
  await expect(dialog.getByRole("alert")).toContainText("Rusty could not join the selected boards")
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
