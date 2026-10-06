import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createServer } from "node:net"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test, type Browser, type Page } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

const binary = process.env.TINCANBAN_LIGHTHOUSE_BINARY
const manifest = resolve(process.env.TINCANBAN_LIGHTHOUSE_MANIFEST ?? "../mesh-lighthouse/Cargo.toml")
test.skip(!binary || !existsSync(binary) || !existsSync(manifest), "Built standalone Lighthouse binary and checkout are required")
test.use({ trace: "off" })

const processOutput = new WeakMap<ChildProcessWithoutNullStreams, string>()

function native(args: string[], env?: NodeJS.ProcessEnv) {
  const child = spawn(binary!, args, { stdio: "pipe", env: { ...process.env, ...env } })
  processOutput.set(child, "")
  const capture = (chunk: Buffer) => processOutput.set(child, (processOutput.get(child) ?? "").concat(String(chunk)).slice(-20_000))
  child.stdout.on("data", capture)
  child.stderr.on("data", capture)
  return child
}

function waitOutput(child: ChildProcessWithoutNullStreams, pattern: RegExp, timeoutMs = 90_000) {
  return new Promise<string>((resolveOutput, reject) => {
    let output = ""
    const timer = setTimeout(() => finish(new Error("Lighthouse startup timed out")), timeoutMs)
    const data = (chunk: Buffer) => { output += String(chunk); if (pattern.test(output)) finish() }
    const exited = (code: number | null) => finish(new Error("Lighthouse exited " + code))
    function finish(error?: Error) {
      clearTimeout(timer)
      child.stdout.off("data", data); child.stderr.off("data", data); child.off("exit", exited)
      if (error) reject(new Error(error.message + ": " + output)); else resolveOutput(output)
    }
    child.stdout.on("data", data); child.stderr.on("data", data); child.on("exit", exited)
  })
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null } | null>(resolveExit => {
    const exited = (code: number | null, signal: NodeJS.Signals | null) => finish({ code, signal })
    const timer = setTimeout(() => finish(null), timeoutMs)
    function finish(result: { code: number | null; signal: NodeJS.Signals | null } | null) {
      clearTimeout(timer)
      child.off("exit", exited)
      resolveExit(result)
    }
    child.once("exit", exited)
  })
}

async function stop(child?: ChildProcessWithoutNullStreams, requireCleanExit = false) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGINT")
  let exit = await waitForExit(child, 10_000)
  if (!exit) {
    child.kill("SIGTERM")
    exit = await waitForExit(child, 5_000)
  }
  if (!exit) {
    child.kill("SIGKILL")
    await waitForExit(child, 1_000)
    throw new Error("Disposable Lighthouse test child did not stop after SIGINT and SIGTERM\n" + (processOutput.get(child) ?? ""))
  }
  if (requireCleanExit && exit.code !== 0) {
    throw new Error(`Lighthouse exited with code ${exit.code} and signal ${exit.signal ?? "none"} during graceful shutdown\n` + (processOutput.get(child) ?? ""))
  }
}

async function freePort() {
  const server = createServer()
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not allocate local test port")
  const port = address.port
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  return port
}

async function bootstrapKeeperIdentity(browser: Browser, directory: string, baseURL: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  let joinProcess: ChildProcessWithoutNullStreams | undefined
  try {
    console.log("[keeper e2e] bootstrap: open owner board")
    await page.goto(baseURL)
    await createJobSearchWorkspace(page, "Bootstrap board")
    console.log("[keeper e2e] bootstrap: open sync and generate invite")
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Device sync" })
    await dialog.getByRole("button", { name: "Add someone" }).click()
    await dialog.getByRole("button", { name: "Generate link" }).click()
    const invite = await dialog.getByLabel("Pairing link").inputValue()
    joinProcess = native(["join", invite, directory])
    console.log("[keeper e2e] bootstrap: wait for Lighthouse join")
    const joined = waitOutput(joinProcess, /Lighthouse joined/)
    await page.getByLabel("Participant role").waitFor({ timeout: 90_000 })
    await page.getByLabel("Participant role").selectOption("editor")
    await page.getByRole("button", { name: "Approve access" }).click()
    await joined
    console.log("[keeper e2e] bootstrap: join approved")
    const config = JSON.parse(await readFile(join(directory, "config.json"), "utf8")) as {
      localHandshake: { peer: { advertisement: { payload: { personId: string } } } }
      identitySeed: number[]
      deviceSeed: number[]
      irohSecret: number[]
    }
    await stop(joinProcess)
    joinProcess = undefined
    return config
  } finally {
    await stop(joinProcess)
    await context.close()
  }
}

async function startService(directory: string, origin: string, appOrigin: string, token: string) {
  const child = native([join(directory, "config.json")], {
    LIGHTHOUSE_HTTP_BIND: "127.0.0.1:" + new URL(origin).port,
    LIGHTHOUSE_PUBLIC_ORIGIN: origin,
    LIGHTHOUSE_CORS_ORIGINS: appOrigin,
    LIGHTHOUSE_ADMIN_TOKEN: token,
  })
  await waitOutput(child, /Lighthouse HTTP listening/)
  return child
}

async function createTargetBoards(page: Page) {
  await createJobSearchWorkspace(page, "Keeper target A")
  await createJobSearchWorkspace(page, "Keeper target B")
}

test("Given a running Lighthouse identity, when both controllers approve all owned boards, then durable join resumes after lost response and restart", async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(Number(process.env.TINCANBAN_E2E_TIMEOUT ?? 300_000))
  const directory = await mkdtemp(join(tmpdir(), "tincanban-lighthouse-provision-"))
  const baseDirectory = join(directory, "service")
  const appOrigin = baseURL ?? "http://127.0.0.1:4246"
  const servicePort = await freePort()
  const serviceOrigin = "http://127.0.0.1:" + servicePort
  const operatorToken = "keeper-test-token-" + crypto.randomUUID() + "-long-enough"
  const nativeIdentity = { personId: "" }
  const nativeSeeds: { identity: number[]; device: number[]; iroh: number[] } = { identity: [], device: [], iroh: [] }
  let service: ChildProcessWithoutNullStreams | undefined
  let operator: Page | undefined
  let humanA: Page | undefined
  let ownerBContext: Awaited<ReturnType<Browser["newContext"]>> | undefined
  let ownerBPage: Page | undefined
  let humanB: Page | undefined
  let bodyForRetry: string | undefined
  let ownerBProvisionBody: string | undefined
  let droppedResponse = false
  let completed = false
  try {
    console.log("[keeper e2e] create target boards")
    await page.goto(appOrigin)
    await createTargetBoards(page)
    console.log("[keeper e2e] bootstrap keeper identity")
    const bootstrapConfig = await bootstrapKeeperIdentity(browser, baseDirectory, appOrigin)
    nativeIdentity.personId = bootstrapConfig.localHandshake.peer.advertisement.payload.personId
    nativeSeeds.identity = bootstrapConfig.identitySeed
    nativeSeeds.device = bootstrapConfig.deviceSeed
    nativeSeeds.iroh = bootstrapConfig.irohSecret

    console.log("[keeper e2e] start isolated native service")
    service = await startService(baseDirectory, serviceOrigin, appOrigin, operatorToken)
    await page.route(serviceOrigin + "/v1/pairings/*/provision", async route => {
      const requestBody = route.request().postData() ?? undefined
      if (!droppedResponse) bodyForRetry = requestBody
      else if (!ownerBProvisionBody) ownerBProvisionBody = requestBody
      let response
      try {
        response = await route.fetch()
      } catch (error) {
        throw new Error(String(error) + "\nLighthouse output:\n" + (processOutput.get(service!) ?? ""))
      }
      if (!response.ok()) {
        await route.fulfill({ response })
        return
      }
      const responseBody = await response.text()
      if (!droppedResponse) {
        const status = JSON.parse(responseBody) as { payload?: { status?: string } }
        expect(status.payload?.status).toBe("active")
        droppedResponse = true
        await route.abort("failed")
        return
      }
      await route.fulfill({ status: response.status(), contentType: "application/json", body: responseBody })
    })

    console.log("[keeper e2e] check overview authorization and operator login")
    const unauthenticatedOverview = await page.request.get(serviceOrigin + "/admin/api/overview")
    expect(unauthenticatedOverview.status()).toBe(403)
    const unauthenticatedSession = await page.request.get(serviceOrigin + "/admin/api/session")
    expect(unauthenticatedSession.status()).toBe(403)

    const invalidSessionContext = await browser.newContext()
    await invalidSessionContext.addCookies([{
      name: "mesh_lighthouse_admin",
      value: "invalid-session-cookie",
      domain: new URL(serviceOrigin).hostname,
      path: "/admin/api",
      httpOnly: true,
      sameSite: "Strict",
    }])
    const invalidSessionPage = await invalidSessionContext.newPage()
    await invalidSessionPage.goto(serviceOrigin + "/admin/")
    await expect(invalidSessionPage.getByRole("heading", { name: "Sign in" })).toBeVisible()
    await expect(invalidSessionPage.locator(".keeper-card")).toHaveCount(0)
    await expect(invalidSessionPage.locator(".approval-card")).toHaveCount(0)
    await invalidSessionContext.close()

    const unavailableSessionContext = await browser.newContext()
    const unavailableSessionPage = await unavailableSessionContext.newPage()
    let sessionChecks = 0
    await unavailableSessionPage.route(serviceOrigin + "/admin/api/session", async route => {
      sessionChecks += 1
      await route.fulfill({
        status: sessionChecks === 1 ? 503 : 403,
        contentType: "application/json",
        body: JSON.stringify({ message: "Session unavailable" }),
      })
    })
    await unavailableSessionPage.goto(serviceOrigin + "/admin/")
    await expect(unavailableSessionPage.getByRole("heading", { name: "Session check unavailable" })).toBeVisible()
    await expect(unavailableSessionPage.getByLabel("Operator token")).toHaveCount(0)
    await unavailableSessionPage.getByRole("button", { name: "Retry session check" }).click()
    await expect(unavailableSessionPage.getByRole("heading", { name: "Sign in" })).toBeVisible()
    await unavailableSessionContext.close()

    operator = await page.context().newPage()
    humanA = operator
    const adminResponse = await humanA.goto(serviceOrigin + "/admin/")
    expect(adminResponse?.status(), "Lighthouse operator page must be served locally").toBe(200)
    await expect(humanA.getByRole("button", { name: "Sign in with Match" })).toBeVisible()
    await expect(humanA.getByRole("heading", { name: "Sign in" })).toBeVisible()
    let loginProofRequests = 0
    const challengeRoute = serviceOrigin + "/v1/login/challenges/*"
    await humanA.route(serviceOrigin + "/v1/login/proof", async route => {
      loginProofRequests += 1
      await route.continue()
    })
    await humanA.route(challengeRoute, async route => {
      const response = await route.fetch()
      const envelope = await response.json() as { payload: { nonce: string } }
      envelope.payload.nonce += "tampered"
      await route.fulfill({ response, body: JSON.stringify(envelope) })
    })
    await humanA.getByRole("button", { name: "Sign in with Match" }).click()
    await expect(humanA.getByRole("heading", { name: "Could not verify sign-in request" })).toBeVisible()
    await expect(humanA.getByRole("button", { name: "Approve sign-in" })).toHaveCount(0)
    await humanA.screenshot({ path: testInfo.outputPath("lighthouse-tincanban-invalid-challenge.png"), fullPage: true })
    await humanA.getByRole("button", { name: "Cancel" }).click()
    await expect.poll(() => loginProofRequests).toBe(0)
    await humanA.unroute(challengeRoute)

    await humanA.goto(serviceOrigin + "/admin/")
    await humanA.getByRole("button", { name: "Sign in with Match" }).click()
    await expect(humanA.getByRole("heading", { name: "Sign in with your tincanban identity?" })).toBeVisible()
    await expect(humanA.getByText("tincanban identity", { exact: true })).toBeVisible()
    await expect(humanA.getByRole("button", { name: "Approve sign-in" })).toBeVisible()
    await humanA.screenshot({ path: testInfo.outputPath("lighthouse-tincanban-signin-approval.png"), fullPage: true })
    await humanA.getByRole("button", { name: "Approve sign-in" }).click()
    await expect(humanA).toHaveURL(serviceOrigin + "/admin/")
    await expect(humanA.getByRole("button", { name: "Sign out" })).toBeVisible()
    await expect(humanA.getByText("No pending keeper requests")).toBeVisible()
    await expect(humanA.getByRole("button", { name: "Approve exact boards" })).toHaveCount(0)
    await humanA.reload()
    await expect(humanA.getByRole("button", { name: "Sign out" })).toBeVisible()
    await expect(humanA.getByText("No pending keeper requests")).toBeVisible()
    await humanA.getByRole("button", { name: "Sign out" }).click()
    await expect(humanA.getByRole("button", { name: "Sign in with Match" })).toBeVisible()

    operator = await browser.newPage()
    await operator.goto(serviceOrigin + "/admin/")
    await operator.getByText("Service administration").click()
    await operator.getByLabel("Operator token").fill("incorrect-test-operator-token")
    await operator.getByRole("button", { name: "Sign in as operator" }).click()
    await expect(operator.getByRole("status")).toContainText("Approval is not authorized")
    await operator.getByLabel("Operator token").fill(operatorToken)
    await operator.getByRole("button", { name: "Sign in as operator" }).click()
    await expect(operator.locator(".login-card")).toBeHidden()
    await expect(operator.getByText("No pending keeper requests")).toBeVisible()
    await operator.reload()
    await expect(operator.locator(".login-card")).toBeHidden()
    await expect(operator.getByRole("heading", { name: "Keepers", exact: true })).toBeVisible()
    await expect(operator.getByText("No pending keeper requests")).toBeVisible()
    await expect(operator.getByRole("heading", { name: "Keepers", exact: true })).toBeVisible()
    await expect(operator.getByRole("heading", { name: /^Approvals/ })).toBeVisible()
    await expect(operator.getByText("Bootstrap board")).toBeVisible()
    await expect(operator.getByText("JEV intake")).toBeVisible()
    const intake = operator.locator(".overview-group article.board-row").filter({ hasText: "JEV intake" })
    await expect(intake).toContainText(/configured|not configured/)
    await expect(intake).toContainText("pending")
    await operator.screenshot({ path: testInfo.outputPath("lighthouse-admin-overview.png"), fullPage: true })

    console.log("[keeper e2e] owner requests keeper pairing")
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const sync = page.getByRole("dialog", { name: "Device sync" })
    await sync.getByRole("button", { name: "Add keeper" }).click()
    await sync.getByRole("textbox", { name: "Keeper hostname" }).fill(serviceOrigin)
    await sync.getByRole("button", { name: "Discover keeper" }).click()
    await expect(sync.getByText("Service identity " + nativeIdentity.personId)).toBeVisible()
    const ownerBoardChecks = sync.locator('input[aria-label^="Keeper board: "]')
    await expect(ownerBoardChecks).toHaveCount(3)
    for (const checkbox of await ownerBoardChecks.all()) await expect(checkbox).toBeChecked()
    await sync.getByRole("checkbox", { name: "Keeper board: Untitled" }).uncheck()
    await expect(sync.getByRole("checkbox", { name: "Also replicate my future boards" })).toBeChecked()
    await sync.getByRole("checkbox", { name: "Keeper board: Keeper target A" }).check()
    await sync.getByRole("checkbox", { name: "Keeper board: Keeper target B" }).check()
    await sync.getByRole("button", { name: "Request access" }).click()
    await expect(sync.getByText("Waiting for both approvals. No access granted.")).toBeVisible()

    console.log("[keeper e2e] operator refreshes and approves pending pairing")
    const request = operator.locator(".approvals-section article.approval-card")
    await expect(request).toHaveCount(1)
    await expect(request).toContainText("Keeper target A")
    await expect(request).toContainText("Keeper target B")
    await expect(request).toContainText("Controller approval: pending")
    await expect(request).toContainText("Future boards included in approval")
    await operator.reload()
    await expect(operator.locator(".login-card")).toBeHidden()
    const restoredRequest = operator.locator(".approvals-section article.approval-card")
    await expect(restoredRequest).toHaveCount(1)
    await expect(restoredRequest).toContainText("Keeper target A")
    await restoredRequest.getByRole("button", { name: "Approve exact boards" }).click()
    await expect(restoredRequest).toContainText("Controller approval: pending")
    await expect(restoredRequest).toContainText("Future boards included in approval")

    console.log("[keeper e2e] owner approves matching code; wait for durable activation")
    await sync.getByRole("button", { name: "Code matches · approve" }).click()
    await expect(sync.getByText("All selected boards activated and saved by Rusty.")).toBeVisible({ timeout: 90_000 })
    // Status polling may observe the durable commit before the intercepted
    // provision response returns. Keep the native process alive until loss occurs.
    await expect.poll(() => droppedResponse, { timeout: 15_000 }).toBe(true)
    expect(bodyForRetry).toBeTruthy()

    const configPath = join(baseDirectory, "config.json")
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      identitySeed: number[]; deviceSeed: number[]; irohSecret: number[]
      additionalScopes: { workspaceId: string; identitySeed: number[]; deviceSeed: number[]; irohSecret: number[]; controllerPersonId?: string }[]
      provisioningCommits: { workspaceIds: string[]; futureBoards: boolean }[]
      controllerPersonId?: string
    }
    const approvedWorkspaceIds = (JSON.parse(bodyForRetry!) as { signed: { payload: { body: { approvedScopes: { workspaceId: string }[] } } } })
      .signed.payload.body.approvedScopes.map(scope => scope.workspaceId)
    expect(approvedWorkspaceIds).toHaveLength(2)
    expect(config.additionalScopes.filter(scope => approvedWorkspaceIds.includes(scope.workspaceId)).map(scope => scope.workspaceId)).toEqual(approvedWorkspaceIds)
    expect(config.additionalScopes.map(scope => scope.identitySeed)).toEqual(config.additionalScopes.map(() => nativeSeeds.identity))
    expect(config.additionalScopes.map(scope => scope.deviceSeed)).toEqual(config.additionalScopes.map(() => nativeSeeds.device))
    expect(config.additionalScopes.map(scope => scope.irohSecret)).toEqual(config.additionalScopes.map(() => nativeSeeds.iroh))
    expect(config.provisioningCommits.at(-1)?.workspaceIds).toEqual(approvedWorkspaceIds)
    expect((JSON.parse(bodyForRetry!) as { signed: { payload: { body: { futureBoards: boolean } } } })
      .signed.payload.body.futureBoards).toBe(true)
    expect(config.provisioningCommits.at(-1)?.futureBoards).toBe(true)
    const ownerAPersonId = (JSON.parse(bodyForRetry!) as { identity: { personId: string } }).identity.personId
    expect(config.additionalScopes.every(scope => scope.controllerPersonId === ownerAPersonId)).toBe(true)
    const originalPrimaryControllerPersonId = config.controllerPersonId

    await sync.getByRole("button", { name: "Close" }).click()
    console.log("[keeper e2e] verify future-board replication")
    await createJobSearchWorkspace(page, "Keeper future board")
    await expect.poll(async () => {
      const current = JSON.parse(await readFile(configPath, "utf8")) as { additionalScopes: { workspaceId: string }[] }
      return current.additionalScopes.length
    }, { timeout: 90_000 }).toBe(config.additionalScopes.length + 1)
    const withFutureBoard = JSON.parse(await readFile(configPath, "utf8")) as {
      additionalScopes: { workspaceId: string; statePath: string }[]
    }
    expect(withFutureBoard.additionalScopes.every(scope => existsSync(scope.statePath))).toBe(true)

    console.log("[keeper e2e] second owner requests a separate static board")
    ownerBContext = await browser.newContext()
    ownerBPage = await ownerBContext.newPage()
    await ownerBPage.goto(appOrigin)
    await createJobSearchWorkspace(ownerBPage, "Owner B private board")
    await ownerBPage.route(serviceOrigin + "/v1/pairings/*/provision", async route => {
      ownerBProvisionBody ??= route.request().postData() ?? undefined
      await route.continue()
    })
    await ownerBPage.getByRole("button", { name: "Sync", exact: true }).click()
    const ownerBSync = ownerBPage.getByRole("dialog", { name: "Device sync" })
    await ownerBSync.getByRole("button", { name: "Add keeper" }).click()
    await ownerBSync.getByRole("textbox", { name: "Keeper hostname" }).fill(serviceOrigin)
    await ownerBSync.getByRole("button", { name: "Discover keeper" }).click()
    await expect(ownerBSync.getByRole("checkbox", { name: "Keeper board: Owner B private board" })).toBeChecked()
    await ownerBSync.getByRole("checkbox", { name: "Keeper board: Untitled" }).uncheck()
    await ownerBSync.getByRole("checkbox", { name: "Also replicate my future boards" }).uncheck()
    await ownerBSync.getByRole("button", { name: "Request access" }).click()
    await ownerBSync.getByRole("button", { name: "Code matches · approve" }).click()
    await expect(ownerBSync.getByText("Waiting for operator approval. No access granted.")).toBeVisible()

    console.log("[keeper e2e] owner A cannot see owner B pending request or board")
    await humanA.getByRole("button", { name: "Sign in with Match" }).click()
    await expect(humanA.getByRole("heading", { name: "Sign in with your tincanban identity?" })).toBeVisible()
    await humanA.getByRole("button", { name: "Approve sign-in" }).click()
    await expect(humanA.getByRole("heading", { name: "Keepers", exact: true })).toBeVisible()
    await expect(humanA.getByText("Keeper target A", { exact: true })).toBeVisible()
    await expect(humanA.getByText("Keeper target B", { exact: true })).toBeVisible()
    await expect(humanA.getByText("JEV intake", { exact: true })).toHaveCount(0)
    await expect(humanA.getByText("Owner B private board", { exact: true })).toHaveCount(0)
    const ownerAApproval = humanA.locator(".approvals-section article.approval-card")
    await expect(ownerAApproval).toHaveCount(1)
    await expect(ownerAApproval).toContainText("Both approvals are recorded")
    await expect(ownerAApproval).not.toContainText("Owner B private board")
    await humanA.screenshot({ path: testInfo.outputPath("lighthouse-owner-a-scoped.png"), fullPage: true })
    await humanA.getByRole("button", { name: "Sign out" }).click()

    console.log("[keeper e2e] owner B sees only own pending service approval")
    humanB = await ownerBContext.newPage()
    await humanB.goto(serviceOrigin + "/admin/")
    await humanB.getByRole("button", { name: "Sign in with Match" }).click()
    await expect(humanB.getByRole("heading", { name: "Sign in with your tincanban identity?" })).toBeVisible()
    await humanB.getByRole("button", { name: "Approve sign-in" }).click()
    await expect(humanB.getByRole("heading", { name: /^Approvals/ })).toBeVisible()
    await expect(humanB.getByText("No attached boards.")).toBeVisible()
    const ownerBApproval = humanB.locator(".approvals-section article.approval-card")
    await expect(ownerBApproval).toHaveCount(1)
    await expect(ownerBApproval).toContainText("Owner B private board")
    await expect(ownerBApproval).toContainText("Future boards not included")
    await expect(ownerBApproval).toContainText("Waiting for keeper operator to approve service access")
    await expect(ownerBApproval.getByRole("button", { name: "Approve exact boards" })).toHaveCount(0)
    await expect(humanB.getByText("Keeper target A", { exact: true })).toHaveCount(0)
    await expect(humanB.getByText("Keeper target B", { exact: true })).toHaveCount(0)
    await expect(humanB.getByText("Keeper future board", { exact: true })).toHaveCount(0)
    await expect(humanB.getByText("JEV intake", { exact: true })).toHaveCount(0)
    await humanB.reload()
    await expect(humanB.getByRole("button", { name: "Sign out" })).toBeVisible()
    await expect(humanB.locator(".approvals-section article.approval-card")).toContainText("Waiting for keeper operator to approve service access")
    await humanB.screenshot({ path: testInfo.outputPath("lighthouse-owner-b-pending.png"), fullPage: true })

    console.log("[keeper e2e] operator approves B; each identity retains isolated overview")
    const ownerBOperatorApproval = operator.locator(".approvals-section article.approval-card").filter({ hasText: "Owner B private board" })
    await expect(ownerBOperatorApproval).toHaveCount(1)
    await expect(ownerBOperatorApproval).toContainText("Owner B private board")
    await ownerBOperatorApproval.getByRole("button", { name: "Approve exact boards" }).click()
    await expect(ownerBSync.getByText("All selected boards activated and saved by Rusty.")).toBeVisible({ timeout: 90_000 })
    expect(ownerBProvisionBody).toBeTruthy()
    const ownerBRequest = JSON.parse(ownerBProvisionBody!) as {
      identity: { personId: string }
      signed: { payload: { body: { approvedScopes: { workspaceId: string }[]; futureBoards: boolean } } }
    }
    const ownerBWorkspaceId = ownerBRequest.signed.payload.body.approvedScopes[0].workspaceId
    expect(ownerBRequest.identity.personId).not.toBe(ownerAPersonId)
    expect(ownerBRequest.signed.payload.body.futureBoards).toBe(false)
    const afterOwnerB = JSON.parse(await readFile(configPath, "utf8")) as {
      controllerPersonId?: string
      identitySeed: number[]
      additionalScopes: { workspaceId: string; controllerPersonId?: string }[]
    }
    expect(afterOwnerB.controllerPersonId).toBe(originalPrimaryControllerPersonId)
    expect(afterOwnerB.identitySeed).toEqual(nativeSeeds.identity)
    expect(afterOwnerB.additionalScopes.find(scope => scope.workspaceId === ownerBWorkspaceId)?.controllerPersonId).toBe(ownerBRequest.identity.personId)

    await expect(humanB.getByText("Owner B private board", { exact: true })).toBeVisible()
    await expect(humanB.locator(".approval-card")).toHaveCount(1)
    await expect(humanB.locator(".approval-card")).toContainText("Both approvals are recorded")
    await expect(humanB.getByText("Keeper target A", { exact: true })).toHaveCount(0)
    await expect(humanB.getByText("Keeper target B", { exact: true })).toHaveCount(0)
    await expect(humanB.getByText("Keeper future board", { exact: true })).toHaveCount(0)
    await expect(humanB.getByText("JEV intake", { exact: true })).toHaveCount(0)
    await humanB.screenshot({ path: testInfo.outputPath("lighthouse-owner-b-scoped.png"), fullPage: true })
    await humanA.getByRole("button", { name: "Sign in with Match" }).click()
    await expect(humanA.getByRole("heading", { name: "Sign in with your tincanban identity?" })).toBeVisible()
    await humanA.getByRole("button", { name: "Approve sign-in" }).click()
    await expect(humanA.getByText("Keeper target A", { exact: true })).toBeVisible()
    await expect(humanA.getByText("Keeper target B", { exact: true })).toBeVisible()
    await expect(humanA.getByText("Owner B private board", { exact: true })).toHaveCount(0)
    await expect(humanA.getByText("JEV intake", { exact: true })).toHaveCount(0)
    await expect(humanA.locator(".approval-card")).toHaveCount(1)

    console.log("[keeper e2e] graceful shutdown and restart")
    await stop(service, true)
    service = await startService(baseDirectory, serviceOrigin, appOrigin, operatorToken)
    const retryPairingId = JSON.parse(bodyForRetry!).signed.payload.body.pairingId as string
    const retry = await page.request.post(serviceOrigin + "/v1/pairings/" + retryPairingId + "/provision", {
      data: bodyForRetry,
      headers: { Origin: appOrigin, "Content-Type": "application/json" },
    })
    const retryBody = await retry.text()
    expect(retry.ok(), "retry HTTP " + retry.status() + ": " + retryBody).toBe(true)
    const signedStatus = JSON.parse(retryBody) as { payload?: { status?: string; provisioning?: { status?: string; scopes?: { workspaceId?: string; status?: string }[] } }; signature?: string; signerKeyId?: string }
    expect(signedStatus.signature).toBeTruthy()
    expect(signedStatus.signerKeyId).toBeTruthy()
    expect(signedStatus.payload?.status).toBe("active")
    expect(signedStatus.payload?.provisioning?.status).toBe("active")
    expect(signedStatus.payload?.provisioning?.scopes?.map(scope => scope.workspaceId)).toEqual(approvedWorkspaceIds)
    expect(signedStatus.payload?.provisioning?.scopes?.every(scope => scope.status === "active")).toBe(true)
    completed = true
  } finally {
    await operator?.close()
    await humanA?.close()
    await humanB?.close()
    await ownerBContext?.close()
    await stop(service, true)
    if (completed) await rm(directory, { recursive: true, force: true })
  }
})
