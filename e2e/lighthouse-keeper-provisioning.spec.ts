import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createServer } from "node:net"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { expect, test, type Browser, type Page } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

const binary = process.env.TINCANBAN_LIGHTHOUSE_BINARY
const manifest = resolve(process.env.TINCANBAN_LIGHTHOUSE_MANIFEST ?? "../mesh-lighthouse-cors-settings/Cargo.toml")
const lifecycleBinaryReady = Boolean(binary && existsSync(binary) && existsSync(manifest))
if (process.env.TINCANBAN_REQUIRE_LIGHTHOUSE_E2E === "1" && !lifecycleBinaryReady) {
  throw new Error("Required Rusty lifecycle E2E needs a built binary and canonical checkout.")
}
test.skip(!lifecycleBinaryReady, "Built standalone Rusty binary and checkout are required")
test.use({ trace: "retain-on-failure" })

const processOutput = new WeakMap<ChildProcessWithoutNullStreams, string>()
const execFileAsync = promisify(execFile)

async function diagnoseStep<T>(label: string, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now()
  console.log(`[keeper e2e] ${label} start`)
  try {
    const result = await action()
    console.log(`[keeper e2e] ${label} done in ${Date.now() - startedAt}ms`)
    return result
  } catch (error) {
    console.log(`[keeper e2e] ${label} failed after ${Date.now() - startedAt}ms: ${String(error)}`)
    throw error
  }
}

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

async function createEmptyServiceFixture(directory: string) {
  if (!binary) throw new Error("Built Rusty binary is required for keeper lifecycle E2E")
  const { stdout } = await execFileAsync(binary, ["e2e-fixture-empty", directory], { maxBuffer: 1024 * 1024 })
  const fixture = JSON.parse(stdout) as {
    configPath: string
    servicePersonId: string
    serviceDeviceId: string
    status: string
    fixtureWorkspaceId: string
  }
  expect(fixture.configPath).toBe(join(directory, "config.json"))
  expect(fixture.servicePersonId).toMatch(/^[A-Za-z0-9_-]{20,}$/)
  expect(fixture.serviceDeviceId).toMatch(/^[A-Za-z0-9_-]{20,}$/)
  expect(fixture.status).toBe("detached")
  expect(fixture.fixtureWorkspaceId).toBeTruthy()
  return fixture
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

async function openApprovals(page: Page) {
  await page.getByRole("navigation", { name: "Keeper sections" }).getByRole("link", { name: /Approvals/ }).click()
}

async function signInOperator(page: Page, token: string) {
  const tokenInput = page.locator("#operator-token")
  if (!(await tokenInput.isVisible())) await page.getByText("Service administration").click()
  await tokenInput.fill(token)
  await page.getByRole("button", { name: "Sign in as operator" }).click()
  await expect(page.locator(".login-card")).toBeHidden()
}

async function openKeeperDetails(page: Page) {
  await page.getByRole("navigation", { name: "Keeper sections" }).getByRole("link", { name: "Keepers", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Keepers", exact: true })).toBeVisible()
  await page.getByRole("link", { name: "Open keeper" }).click()
  await expect(page.getByRole("heading", { name: "Boards", exact: true })).toBeVisible()
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
  let ownerAReaddProvisionBody: string | undefined
  let ownerAReaddRequested = false
  let ownerAPairingId: string | undefined
  let ownerAIntegrationId: string | undefined
  let ownerAServiceDeviceId: string | undefined
  let lastOwnerAStatus: { httpStatus: number; status?: string; provisioningStatus?: string; scopes?: { workspaceId: string; status?: string }[] } | undefined
  let statusFetchFailure: string | undefined
  let droppedResponse = false
  let completed = false
  try {
    console.log("[keeper e2e] create target boards")
    await page.goto(appOrigin)
    await createTargetBoards(page)
    console.log("[keeper e2e] create genuine Rusty identity with empty scope registry")
    const fixture = await createEmptyServiceFixture(baseDirectory)
    nativeIdentity.personId = fixture.servicePersonId
    const initialConfig = JSON.parse(await readFile(fixture.configPath, "utf8")) as {
      identitySeed: number[]; deviceSeed: number[]; irohSecret: number[]
      primaryDetached?: boolean
      additionalScopes?: { workspaceId: string }[]
    }
    expect(initialConfig.primaryDetached).toBe(true)
    expect(initialConfig.additionalScopes ?? []).toEqual([])
    nativeSeeds.identity = initialConfig.identitySeed
    nativeSeeds.device = initialConfig.deviceSeed
    nativeSeeds.iroh = initialConfig.irohSecret

    console.log("[keeper e2e] start isolated native service")
    service = await startService(baseDirectory, serviceOrigin, appOrigin, operatorToken)
    await page.route(serviceOrigin + "/v1/pairings/*/provision", async route => {
      const requestBody = route.request().postData() ?? undefined
      const request = JSON.parse(requestBody ?? "{}") as { signed?: { payload?: { body?: { pairingId?: string; invitation?: { role?: string } } } } }
      expect(request.signed?.payload?.body?.invitation?.role).toBe("editor")
      if (!droppedResponse) {
        bodyForRetry = requestBody
        ownerAPairingId = request.signed?.payload?.body?.pairingId
      }
      else if (ownerAReaddRequested) ownerAReaddProvisionBody ??= requestBody
      else if (!ownerBProvisionBody) ownerBProvisionBody = requestBody
      let response
      try {
        response = await route.fetch()
      } catch (error) {
        throw new Error(String(error) + "\nLighthouse output:\n" + (processOutput.get(service!) ?? ""), { cause: error })
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
    await page.route(serviceOrigin + "/v1/pairings/*/status", async route => {
      let response
      try {
        response = await route.fetch()
      } catch (error) {
        statusFetchFailure = String(error).slice(0, 500)
        await route.abort("failed")
        return
      }
      statusFetchFailure = undefined
      const body = await response.json() as { signerKeyId?: string; payload?: { status?: string; integrationId?: string } }
      const provisioning = body.payload as { provisioning?: { status?: string; scopes?: { workspaceId?: string; status?: string }[] } } | undefined
      lastOwnerAStatus = {
        httpStatus: response.status(),
        status: body.payload?.status,
        provisioningStatus: provisioning?.provisioning?.status,
        scopes: provisioning?.provisioning?.scopes?.map(scope => ({ workspaceId: scope.workspaceId ?? "", status: scope.status })),
      }
      if (body.payload?.status === "active" && body.payload.integrationId) {
        ownerAIntegrationId = body.payload.integrationId
        ownerAServiceDeviceId = body.signerKeyId
      }
      await route.fulfill({ response, body: JSON.stringify(body) })
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
    const invalidPageConsole: string[] = []
    const invalidPageErrors: string[] = []
    const invalidPageFailedRequests: string[] = []
    const invalidPageResponses: string[] = []
    invalidSessionPage.on("console", message => {
      if (message.type() === "error") invalidPageConsole.push(message.text().slice(0, 500))
    })
    invalidSessionPage.on("pageerror", error => invalidPageErrors.push(error.message.slice(0, 500)))
    invalidSessionPage.on("requestfailed", request => {
      if (request.url().startsWith(serviceOrigin + "/admin")) invalidPageFailedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`)
    })
    invalidSessionPage.on("response", response => {
      if (response.url().startsWith(serviceOrigin + "/admin")) invalidPageResponses.push(`${response.status()} ${response.url()}`)
    })
    try {
      const invalidSessionResponsePromise = invalidSessionPage.waitForResponse(response => {
        const url = new URL(response.url())
        return url.origin === serviceOrigin && url.pathname === "/admin/api/session" && response.request().method() === "GET"
      })
      const invalidSessionDocument = await invalidSessionPage.goto(serviceOrigin + "/admin/")
      expect(invalidSessionDocument?.status(), "Rusty must serve its local operator page").toBe(200)
      expect(invalidSessionPage.url(), "Bad-cookie check must stay on Rusty's operator page").toBe(serviceOrigin + "/admin/")
      const invalidSessionResponse = await invalidSessionResponsePromise
      expect(invalidSessionResponse.status(), "Rusty must reject the invalid admin session cookie").toBe(403)
      const invalidSessionHeaders = await invalidSessionResponse.request().allHeaders()
      expect(invalidSessionHeaders.cookie).toContain("mesh_lighthouse_admin=invalid-session-cookie")
      await expect(invalidSessionPage.getByRole("heading", { name: "Sign in" })).toBeVisible()
      await expect(invalidSessionPage.locator(".keeper-card")).toHaveCount(0)
      await expect(invalidSessionPage.locator(".approval-card")).toHaveCount(0)
    } catch (cause) {
      const diagnostic = {
        cause: cause instanceof Error ? cause.message : String(cause),
        url: invalidSessionPage.url(),
        body: (await invalidSessionPage.locator("body").innerText().catch(() => "<body unavailable>")).slice(0, 1_000),
        responses: invalidPageResponses.slice(-20),
        failedRequests: invalidPageFailedRequests.slice(-20),
        consoleErrors: invalidPageConsole.slice(-10),
        pageErrors: invalidPageErrors.slice(-10),
      }
      throw new Error("Rusty invalid-session page diagnostics: " + JSON.stringify(diagnostic), { cause })
    }
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
    await expect(unavailableSessionPage.getByLabel("Operator token")).toBeHidden()
    await unavailableSessionPage.getByRole("button", { name: "Retry session check" }).click()
    await expect(unavailableSessionPage.getByRole("heading", { name: "Sign in" })).toBeVisible()
    await unavailableSessionContext.close()

    operator = await page.context().newPage()
    humanA = operator
    const adminResponse = await humanA.goto(serviceOrigin + "/admin/")
    expect(adminResponse?.status(), "Lighthouse operator page must be served locally").toBe(200)
    await expect(humanA.getByRole("button", { name: "Sign in with Tincanban" })).toBeVisible()
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
    await humanA.getByRole("button", { name: "Sign in with Tincanban" }).click()
    await expect(humanA.getByRole("heading", { name: "Could not verify sign-in request" })).toBeVisible()
    await expect(humanA.getByRole("button", { name: "Approve sign-in" })).toHaveCount(0)
    await humanA.screenshot({ path: testInfo.outputPath("lighthouse-tincanban-invalid-challenge.png"), fullPage: true })
    await humanA.getByRole("button", { name: "Cancel" }).click()
    await expect.poll(() => loginProofRequests).toBe(0)
    await humanA.unroute(challengeRoute)

    await humanA.goto(serviceOrigin + "/admin/")
    await humanA.getByRole("button", { name: "Sign in with Tincanban" }).click()
    await expect(humanA.getByRole("heading", { name: "Sign in with your tincanban identity?" })).toBeVisible()
    await expect(humanA.getByText("tincanban identity", { exact: true })).toBeVisible()
    await expect(humanA.getByRole("button", { name: "Approve sign-in" })).toBeVisible()
    await humanA.screenshot({ path: testInfo.outputPath("lighthouse-tincanban-signin-approval.png"), fullPage: true })
    await humanA.getByRole("button", { name: "Approve sign-in" }).click()
    await expect(humanA).toHaveURL(serviceOrigin + "/admin/")
    await expect(humanA.getByRole("button", { name: "Sign out" })).toBeVisible()
    await openApprovals(humanA)
    await expect(humanA.getByText("No pending keeper requests")).toBeVisible()
    await expect(humanA.getByRole("button", { name: "Approve exact boards" })).toHaveCount(0)
    await humanA.reload()
    await expect(humanA.getByRole("button", { name: "Sign out" })).toBeVisible()
    await expect(humanA.getByRole("heading", { name: /^Approvals/ })).toBeVisible()
    await expect(humanA.getByText("No pending keeper requests")).toBeVisible()
    await humanA.getByRole("button", { name: "Sign out" }).click()
    await expect(humanA.getByRole("button", { name: "Sign in with Tincanban" })).toBeVisible()

    operator = await browser.newPage()
    await operator.goto(serviceOrigin + "/admin/")
    await operator.getByText("Service administration").click()
    await operator.locator("#operator-token").fill("incorrect-test-operator-token")
    await operator.getByRole("button", { name: "Sign in as operator" }).click()
    await expect(operator.getByRole("status")).toContainText("Approval is not authorized")
    await signInOperator(operator, operatorToken)
    await openApprovals(operator)
    await expect(operator.getByText("No pending keeper requests")).toBeVisible()
    await operator.reload()
    await expect(operator.locator(".login-card")).toBeHidden()
    await expect(operator.getByRole("heading", { name: /^Approvals/ })).toBeVisible()
    await expect(operator.getByText("No pending keeper requests")).toBeVisible()
    await openKeeperDetails(operator)
    await expect(operator.getByText("No attached boards.")).toBeVisible()
    await operator.screenshot({ path: testInfo.outputPath("lighthouse-admin-overview.png"), fullPage: true })
    await openApprovals(operator)

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
    await expect.poll(() => lastOwnerAStatus, { timeout: 90_000 }).toMatchObject({
      httpStatus: 200,
      status: "active",
      provisioningStatus: "active",
    })
    await expect(sync.getByText("All selected boards activated and saved by Rusty.")).toBeVisible({ timeout: 90_000 })
    // Status polling may observe the durable commit before the intercepted
    // provision response returns. Keep the native process alive until loss occurs.
    await expect.poll(() => droppedResponse, { timeout: 15_000 }).toBe(true)
    expect(bodyForRetry).toBeTruthy()

    const configPath = join(baseDirectory, "config.json")
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      identitySeed: number[]; deviceSeed: number[]; irohSecret: number[]
      additionalScopes: { workspaceId: string; identitySeed: number[]; deviceSeed: number[]; irohSecret: number[]; controllerPersonId?: string }[]
      provisioningCommits: { workspaceIds: string[]; futureBoards: boolean; baselineWorkspaceIds: string[] }[]
      controllerPersonId?: string
    }
    const firstProvisionBody = JSON.parse(bodyForRetry!) as { signed: { payload: { body: {
      approvedScopes: { workspaceId: string }[]; baselineWorkspaceIds: string[]
    } } } }
    const approvedWorkspaceIds = firstProvisionBody.signed.payload.body.approvedScopes.map(scope => scope.workspaceId)
    const approvedBaselineIds = firstProvisionBody.signed.payload.body.baselineWorkspaceIds
    expect(approvedWorkspaceIds).toHaveLength(2)
    expect(approvedBaselineIds).toHaveLength(3)
    expect(approvedBaselineIds).toEqual(expect.arrayContaining(approvedWorkspaceIds))
    expect(new Set(approvedBaselineIds).size).toBe(approvedBaselineIds.length)
    const baselineTitles = await page.evaluate(async ids => {
      const { defaultStorage } = await import("/src/storage.ts")
      return (await defaultStorage.listWorkspaces()).filter(workspace => ids.includes(workspace.id))
        .map(workspace => workspace.title).sort()
    }, approvedBaselineIds)
    expect(baselineTitles).toEqual(["Keeper target A", "Keeper target B", "Untitled"])
    expect(config.additionalScopes.filter(scope => approvedWorkspaceIds.includes(scope.workspaceId)).map(scope => scope.workspaceId)).toEqual(approvedWorkspaceIds)
    expect(config.additionalScopes.map(scope => scope.identitySeed)).toEqual(config.additionalScopes.map(() => nativeSeeds.identity))
    expect(config.additionalScopes.map(scope => scope.deviceSeed)).toEqual(config.additionalScopes.map(() => nativeSeeds.device))
    expect(config.additionalScopes.map(scope => scope.irohSecret)).toEqual(config.additionalScopes.map(() => nativeSeeds.iroh))
    expect(config.provisioningCommits.at(-1)?.workspaceIds).toEqual(approvedWorkspaceIds)
    expect(config.provisioningCommits.at(-1)?.baselineWorkspaceIds).toEqual(approvedBaselineIds)
    expect((JSON.parse(bodyForRetry!) as { signed: { payload: { body: { futureBoards: boolean } } } })
      .signed.payload.body.futureBoards).toBe(true)
    expect(config.provisioningCommits.at(-1)?.futureBoards).toBe(true)
    const ownerAPersonId = (JSON.parse(bodyForRetry!) as { identity: { personId: string } }).identity.personId
    expect(config.additionalScopes.every(scope => scope.controllerPersonId === ownerAPersonId)).toBe(true)
    const originalPrimaryControllerPersonId = config.controllerPersonId

    await sync.getByRole("button", { name: "Close" }).click()
    console.log("[keeper e2e] verify future-board replication")
    await createJobSearchWorkspace(page, "Keeper future board")
    const ownerAFutureWorkspaceId = await page.evaluate(async () => {
      const { defaultStorage } = await import("/src/storage.ts")
      return (await defaultStorage.listWorkspaces()).find(workspace => workspace.title === "Keeper future board")?.id
    })
    expect(ownerAFutureWorkspaceId).toBeTruthy()
    expect(approvedBaselineIds).not.toContain(ownerAFutureWorkspaceId)
    await expect.poll(async () => {
      const current = JSON.parse(await readFile(configPath, "utf8")) as { additionalScopes: { workspaceId: string }[] }
      return current.additionalScopes.length
    }, { timeout: 90_000 }).toBe(config.additionalScopes.length + 1)
    const withFutureBoard = JSON.parse(await readFile(configPath, "utf8")) as {
      additionalScopes: { workspaceId: string; statePath: string }[]
    }
    expect(withFutureBoard.additionalScopes.every(scope => existsSync(scope.statePath))).toBe(true)
    expect(withFutureBoard.additionalScopes.some(scope => scope.workspaceId === ownerAFutureWorkspaceId)).toBe(true)
    const ownerAWorkspaceIds = [...approvedWorkspaceIds, ownerAFutureWorkspaceId!]
    const ownerAScopePaths = withFutureBoard.additionalScopes
      .filter(scope => ownerAWorkspaceIds.includes(scope.workspaceId))
      .map(scope => scope.statePath)

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
    await humanA.getByRole("button", { name: "Sign in with Tincanban" }).click()
    await expect(humanA.getByRole("heading", { name: "Sign in with your tincanban identity?" })).toBeVisible()
    await humanA.getByRole("button", { name: "Approve sign-in" }).click()
    await expect(humanA.getByRole("heading", { name: "Keepers", exact: true })).toBeVisible()
    await openKeeperDetails(humanA)
    await expect(humanA.getByText("Keeper target A", { exact: true })).toBeVisible()
    await expect(humanA.getByText("Keeper target B", { exact: true })).toBeVisible()
    await expect(humanA.getByText("JEV intake", { exact: true })).toHaveCount(0)
    await expect(humanA.getByText("Owner B private board", { exact: true })).toHaveCount(0)
    await openApprovals(humanA)
    await expect(humanA.getByText("No pending keeper requests")).toBeVisible()
    await expect(humanA.locator(".approvals-section article.approval-card")).toHaveCount(0)
    await humanA.screenshot({ path: testInfo.outputPath("lighthouse-owner-a-scoped.png"), fullPage: true })
    await humanA.getByRole("button", { name: "Sign out" }).click()

    console.log("[keeper e2e] owner B sees only own pending service approval")
    humanB = await ownerBContext.newPage()
    await humanB.goto(serviceOrigin + "/admin/")
    await humanB.getByRole("button", { name: "Sign in with Tincanban" }).click()
    await expect(humanB.getByRole("heading", { name: "Sign in with your tincanban identity?" })).toBeVisible()
    await humanB.getByRole("button", { name: "Approve sign-in" }).click()
    await openKeeperDetails(humanB)
    await expect(humanB.getByText("No attached boards.")).toBeVisible()
    await openApprovals(humanB)
    await expect(humanB.getByRole("heading", { name: /^Approvals/ })).toBeVisible()
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

    await openKeeperDetails(humanB)
    await expect(humanB.getByText("Owner B private board", { exact: true })).toBeVisible()
    await openApprovals(humanB)
    await expect(humanB.getByText("No pending keeper requests")).toBeVisible()
    await expect(humanB.locator(".approval-card")).toHaveCount(0)
    await expect(humanB.getByText("Keeper target A", { exact: true })).toHaveCount(0)
    await expect(humanB.getByText("Keeper target B", { exact: true })).toHaveCount(0)
    await expect(humanB.getByText("Keeper future board", { exact: true })).toHaveCount(0)
    await expect(humanB.getByText("JEV intake", { exact: true })).toHaveCount(0)
    await humanB.screenshot({ path: testInfo.outputPath("lighthouse-owner-b-scoped.png"), fullPage: true })
    await humanA.getByRole("button", { name: "Sign in with Tincanban" }).click()
    await expect(humanA.getByRole("heading", { name: "Sign in with your tincanban identity?" })).toBeVisible()
    await humanA.getByRole("button", { name: "Approve sign-in" }).click()
    await openKeeperDetails(humanA)
    await expect(humanA.getByText("Keeper target A", { exact: true })).toBeVisible()
    await expect(humanA.getByText("Keeper target B", { exact: true })).toBeVisible()
    await expect(humanA.getByText("Owner B private board", { exact: true })).toHaveCount(0)
    await expect(humanA.getByText("JEV intake", { exact: true })).toHaveCount(0)
    await openApprovals(humanA)
    await expect(humanA.getByText("No pending keeper requests")).toBeVisible()
    await expect(humanA.locator(".approval-card")).toHaveCount(0)

    console.log("[keeper e2e] graceful shutdown and restart")
    await stop(service, true)
    service = await startService(baseDirectory, serviceOrigin, appOrigin, operatorToken)
    await operator.reload()
    await signInOperator(operator, operatorToken)
    await openApprovals(operator)
    await expect(operator.getByText("No pending keeper requests")).toBeVisible()
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

    console.log("[keeper e2e] remove active integration; preserve local board through pending and signed cleanup")
    expect(ownerAIntegrationId).toBeTruthy()
    expect(ownerAPairingId).toBeTruthy()
    const localWorkspace = await diagnoseStep("capture retained workspace before removal", () => page.evaluate(async () => {
      const state = (await import("/src/state.ts")).useTincanban()
      const id = state.activeWorkspace.id
      return { id, bytes: Array.from(await state.readWorkspaceBytes(id)) }
    }))
    await diagnoseStep("clear local keeper references for removal recovery", () => page.evaluate(async ({ integrationId, servicePersonId }) => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { defaultStorage } = await import("/src/storage.ts")
      const { removeOwnerKeeper } = await import("/src/sync/ownerKeeper.ts")
      const profile = await bootstrapIdentity()
      await removeOwnerKeeper(profile.identity.personId, servicePersonId)
      const root = await defaultStorage.loadPersonalRoot()
      if (root?.keeperIntegrations) delete root.keeperIntegrations[integrationId]
      if (root) await defaultStorage.savePersonalRoot(root)
    }, { integrationId: ownerAIntegrationId!, servicePersonId: nativeIdentity.personId }))
    let statusRequest: { signed?: { payload?: Record<string, unknown> } } | undefined
    let statusResponse: { signerKeyId?: string; signature?: string; payload?: Record<string, unknown> } | undefined
    let disconnectReceipt: { signerKeyId?: string; signature?: string; payload?: Record<string, unknown> } | undefined
    const disconnectRequests: { url: string; body: { signed?: { payload?: Record<string, unknown> } } }[] = []
    let failFirstDisconnect = true
    await page.route(serviceOrigin + "/v1/integrations/status", async route => {
      statusRequest = JSON.parse(route.request().postData() ?? "{}")
      const response = await route.fetch()
      statusResponse = await response.json() as typeof statusResponse
      await route.fulfill({ response, body: JSON.stringify(statusResponse) })
    })
    await page.route(serviceOrigin + "/v1/integrations/*/disconnect", async route => {
      const request = JSON.parse(route.request().postData() ?? "{}") as { signed?: { payload?: Record<string, unknown> } }
      disconnectRequests.push({ url: route.request().url(), body: request })
      if (failFirstDisconnect) {
        failFirstDisconnect = false
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Temporary Rusty outage" }) })
        return
      }
      const response = await route.fetch()
      const responseBody = await response.text()
      disconnectReceipt = JSON.parse(responseBody) as typeof disconnectReceipt
      await route.fulfill({ response, body: responseBody })
    })
    let spoofDiscovery = true
    await page.route(serviceOrigin + "/.well-known/mesh-lighthouse", async route => {
      const response = await route.fetch()
      if (!spoofDiscovery) { await route.fulfill({ response }); return }
      const descriptor = await response.json() as { service?: { personId?: string } }
      if (descriptor.service) descriptor.service.personId = "different-service-identity"
      await route.fulfill({ response, body: JSON.stringify(descriptor) })
    })

    await diagnoseStep("open Sync after clearing keeper references", () => page.getByRole("button", { name: "Sync", exact: true }).click())
    const removalDialog = page.getByRole("dialog", { name: "Device sync" })
    const keeperRow = removalDialog.getByRole("list", { name: "Keeper services" }).getByRole("button").first()
    await diagnoseStep("find keeper service row", () => expect(keeperRow).toBeVisible())
    await diagnoseStep("open keeper service row", () => keeperRow.click())
    const addressInput = removalDialog.getByLabel("Rusty address")
    await diagnoseStep("fill Rusty address for identity check", () => addressInput.fill(serviceOrigin))
    await diagnoseStep("confirm Rusty address", () => expect(addressInput).toHaveValue(serviceOrigin))
    const verifyRusty = removalDialog.getByRole("button", { name: "Verify Rusty" })
    await diagnoseStep("wait for Rusty identity verification control", () => expect(verifyRusty).toBeEnabled())
    await diagnoseStep("verify spoofed Rusty identity", () => verifyRusty.click())
    await diagnoseStep("reject mismatched Rusty identity", () => expect(removalDialog.getByRole("alert")).toContainText("different keeper identity"))
    expect(statusRequest).toBeUndefined()
    expect(disconnectRequests).toHaveLength(0)
    spoofDiscovery = false
    await diagnoseStep("verify matching Rusty identity", () => removalDialog.getByRole("button", { name: "Verify Rusty" }).click())
    await diagnoseStep("wait for keeper removal action", () => expect(removalDialog.getByRole("button", { name: "Remove keeper" })).toBeVisible())
    await diagnoseStep("open keeper removal confirmation", () => removalDialog.getByRole("button", { name: "Remove keeper" }).click())
    await diagnoseStep("confirm removal from all boards", () => removalDialog.getByRole("button", { name: "Remove access from all boards" }).click())
    await expect.poll(() => disconnectRequests.length, { timeout: 10_000 }).toBe(1)
    await expect(removalDialog.getByRole("status", { name: "Keeper removal status" })).toContainText("not confirmed")
    await expect(removalDialog.getByRole("alert")).toContainText("Temporary Rusty outage")
    await removalDialog.getByRole("button", { name: "Close" }).click()
    const rootBeforeReload = await page.evaluate(async integrationId => {
      const root = await (await import("/src/storage.ts")).defaultStorage.loadPersonalRoot()
      return root?.keeperIntegrations?.[integrationId] ?? null
    }, ownerAIntegrationId)
    expect(rootBeforeReload).toMatchObject({ state: "removing", pendingRemoval: { operationId: expect.any(String) } })
    await page.reload()
    await expect(page.getByRole("button", { name: "Sync", exact: true })).toBeVisible({ timeout: 60_000 })
    const rootAfterReload = await page.evaluate(async integrationId => {
      const root = await (await import("/src/storage.ts")).defaultStorage.loadPersonalRoot()
      return root?.keeperIntegrations?.[integrationId] ?? null
    }, ownerAIntegrationId)
    expect(rootAfterReload).toMatchObject({ state: "removing", pendingRemoval: { operationId: rootBeforeReload?.pendingRemoval?.operationId } })
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const reopenedRemovalDialog = page.getByRole("dialog", { name: "Device sync" })
    const rootLoadError = reopenedRemovalDialog.getByRole("alert", { name: "Keeper integrations unavailable" })
    if (await rootLoadError.isVisible().catch(() => false)) {
      console.log("[keeper e2e] pending integration load error", await rootLoadError.innerText())
      await rootLoadError.getByRole("button", { name: "Retry loading keeper status" }).click()
    }
    const pendingKeeperRow = reopenedRemovalDialog.getByRole("list", { name: "Keeper services" })
      .getByRole("button").filter({ hasText: "Removal pending" })
    await expect(pendingKeeperRow).toBeVisible()
    await pendingKeeperRow.click()
    await expect(reopenedRemovalDialog.getByRole("status", { name: "Keeper removal status" })).toContainText("not confirmed")
    const retryRemoval = reopenedRemovalDialog.getByRole("button", { name: "Retry removal" })
    await expect(retryRemoval).toBeVisible()
    expect(statusRequest?.signed?.payload).toMatchObject({
      kind: "lighthouse-integration-status-request",
      controllerPersonId: ownerAPersonId,
      controllerDeviceId: expect.any(String),
      operationId: expect.any(String),
    })
    expect(statusResponse?.signature).toBeTruthy()
    expect(statusResponse?.signerKeyId).toBe(ownerAServiceDeviceId)
    expect(statusResponse?.payload?.servicePersonId).toBe(nativeIdentity.personId)
    expect(statusResponse?.payload?.controllerPersonId).toBe(ownerAPersonId)
    expect(statusResponse?.payload?.controllerDeviceId).toBe(statusRequest?.signed?.payload?.controllerDeviceId)
    expect(statusResponse?.payload?.operationId).toBe(statusRequest?.signed?.payload?.operationId)
    const discoveredIntegrations = statusResponse?.payload?.integrations as { integrationId?: string; scopes?: { workspaceId: string }[] }[] | undefined
    const discoveredOwnerIntegration = discoveredIntegrations?.find(integration => integration.integrationId === ownerAIntegrationId)
    const discoveredScopeIds = discoveredOwnerIntegration?.scopes?.map(scope => scope.workspaceId).sort() ?? []
    if (JSON.stringify(discoveredScopeIds) !== JSON.stringify([...ownerAWorkspaceIds].sort())) {
      const configSnapshot = JSON.parse(await readFile(configPath, "utf8")) as {
        additionalScopes: { workspaceId: string; controllerPersonId?: string; statePath: string }[]
      }
      const scopeTitles = await page.evaluate(async (ids) => {
        const { defaultStorage } = await import("/src/storage.ts")
        return (await defaultStorage.listWorkspaces()).filter(workspace => ids.includes(workspace.id))
          .map(workspace => ({ id: workspace.id, title: workspace.title }))
      }, discoveredScopeIds)
      console.log("[keeper e2e] scope mismatch", JSON.stringify({
        ownerAWorkspaceIds, ownerBWorkspaceId, discoveredScopeIds, scopeTitles,
        configScopes: configSnapshot.additionalScopes.map(scope => ({ workspaceId: scope.workspaceId, controllerPersonId: scope.controllerPersonId })),
      }))
    }
    expect(discoveredScopeIds).toEqual([...ownerAWorkspaceIds].sort())
    const failedRequest = disconnectRequests[0]
    const failedPayload = failedRequest.body.signed?.payload
    expect(failedPayload).toMatchObject({
      kind: "lighthouse-integration-disconnect",
      integrationId: ownerAIntegrationId,
      controllerPersonId: ownerAPersonId,
      servicePersonId: nativeIdentity.personId,
      operationId: expect.any(String),
      expectedRevision: expect.any(Number),
    })
    const failedScopes = failedPayload?.scopes as { workspaceId: string }[] | undefined
    expect(failedScopes?.map(scope => scope.workspaceId).sort()).toEqual([...ownerAWorkspaceIds].sort())
    expect(failedRequest.url).toContain(`/v1/integrations/${ownerAIntegrationId}/disconnect`)

    await retryRemoval.click()
    await expect.poll(() => disconnectRequests.length, { timeout: 30_000 }).toBe(2)
    const completedPayload = disconnectRequests[1].body.signed?.payload
    expect(completedPayload?.operationId).toBe(failedPayload?.operationId)
    expect(completedPayload?.expectedRevision).toBe(failedPayload?.expectedRevision)
    expect(completedPayload?.scopes).toEqual(failedPayload?.scopes)
    for (let retry = 0; retry < 4 && disconnectReceipt?.payload?.status !== "removed"; retry += 1) {
      await expect.poll(() => disconnectReceipt?.payload?.status, { timeout: 30_000 })
        .toMatch(/^(pending|removed)$/)
      const pendingScopes = disconnectReceipt?.payload?.scopes as {
        workspaceId: string; grantEpoch: number; state: string; cleanup: string
      }[] | undefined
      if (disconnectReceipt?.payload?.status === "removed") break
      expect(pendingScopes?.map(scope => scope.workspaceId).sort()).toEqual([...ownerAWorkspaceIds].sort())
      expect(pendingScopes?.every(scope => scope.grantEpoch > 0 && scope.state === "pending" && scope.cleanup === "pending")).toBe(true)
      await expect(reopenedRemovalDialog.getByRole("status", { name: "Keeper removal status" }))
        .toContainText("not confirmed")
      await expect(retryRemoval).toBeEnabled()
      const requestCount = disconnectRequests.length
      await retryRemoval.click()
      await expect.poll(() => disconnectRequests.length, { timeout: 30_000 }).toBe(requestCount + 1)
      const retryPayload = disconnectRequests.at(-1)?.body.signed?.payload
      expect(retryPayload?.operationId).toBe(failedPayload?.operationId)
      expect(retryPayload?.expectedRevision).toBe(failedPayload?.expectedRevision)
      expect(retryPayload?.scopes).toEqual(failedPayload?.scopes)
    }
    const receiptDiagnostic = `receipt=${JSON.stringify(disconnectReceipt?.payload)}\nRustyExit=${service?.exitCode ?? "running"}/${service?.signalCode ?? "none"}\nRustyOutput=${processOutput.get(service!) ?? ""}`
    expect(disconnectReceipt?.payload?.status, receiptDiagnostic).toBe("removed")
    expect(disconnectReceipt?.signature).toBeTruthy()
    expect(disconnectReceipt?.signerKeyId).toBe(ownerAServiceDeviceId)
    expect(disconnectReceipt?.payload).toMatchObject({
      kind: "lighthouse-integration-disconnect-receipt",
      integrationId: ownerAIntegrationId,
      operationId: failedPayload?.operationId,
    })
    expect(disconnectReceipt?.payload?.requestHash).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const receiptScopes = disconnectReceipt?.payload?.scopes as { workspaceId: string; grantEpoch: number; state: string; cleanup: string }[] | undefined
    expect(receiptScopes?.map(scope => scope.workspaceId).sort()).toEqual([...ownerAWorkspaceIds].sort())
    expect(receiptScopes?.every(scope => scope.grantEpoch > 0 && scope.state === "removed" && scope.cleanup === "complete")).toBe(true)
    await expect(reopenedRemovalDialog.getByRole("list", { name: "Keeper services" }).getByRole("button")).toHaveCount(0, { timeout: 30_000 })
    const afterDisconnect = JSON.parse(await readFile(configPath, "utf8")) as {
      additionalScopes: { workspaceId: string; statePath: string }[]
    }
    expect(afterDisconnect.additionalScopes.some(scope => ownerAWorkspaceIds.includes(scope.workspaceId))).toBe(false)
    expect(ownerAScopePaths.every(path => !existsSync(path))).toBe(true)
    const retainedLocalWorkspace = await page.evaluate(async (id) => {
      const state = (await import("/src/state.ts")).useTincanban()
      return Array.from(await state.readWorkspaceBytes(id))
    }, localWorkspace.id)
    expect(retainedLocalWorkspace).toEqual(localWorkspace.bytes)

    console.log("[keeper e2e] restart Rusty and verify signed removal status")
    await stop(service, true)
    service = await startService(baseDirectory, serviceOrigin, appOrigin, operatorToken)
    const restartedStatus = await page.evaluate(async (origin) => {
      const { discoverLighthouse } = await import("/src/sync/lighthouseDiscovery.ts")
      const { getKeeperIntegrationStatus } = await import("/src/sync/lighthousePairing.ts")
      const discovery = await discoverLighthouse(origin, { allowLoopbackHttp: true })
      return getKeeperIntegrationStatus(discovery)
    }, serviceOrigin)
    expect(restartedStatus.signature).toBeTruthy()
    expect(restartedStatus.signerKeyId).toBe(ownerAServiceDeviceId)
    const persistedRemoval = restartedStatus.integrations.find(integration => integration.integrationId === ownerAIntegrationId)
    expect(persistedRemoval).toBeTruthy()
    expect(persistedRemoval?.scopes).toEqual([])
    expect(persistedRemoval?.pendingOperation).toBeUndefined()
    expect(persistedRemoval?.tombstones.map(scope => scope.workspaceId).sort()).toEqual([...ownerAWorkspaceIds].sort())
    expect(persistedRemoval?.tombstones.every(scope => scope.state === "removed" && scope.cleanup === "complete")).toBe(true)
    const restartedConfig = JSON.parse(await readFile(configPath, "utf8")) as {
      additionalScopes: { workspaceId: string; statePath: string }[]
    }
    expect(restartedConfig.additionalScopes.some(scope => ownerAWorkspaceIds.includes(scope.workspaceId))).toBe(false)
    expect(ownerAScopePaths.every(path => !existsSync(path))).toBe(true)
    const localWorkspaceAfterRestart = await page.evaluate(async (id) => {
      const state = (await import("/src/state.ts")).useTincanban()
      return Array.from(await state.readWorkspaceBytes(id))
    }, localWorkspace.id)
    expect(localWorkspaceAfterRestart).toEqual(localWorkspace.bytes)

    console.log("[keeper e2e] re-add removed scopes with a fresh pairing and grant epoch")
    const readdDialog = reopenedRemovalDialog
    await readdDialog.getByRole("button", { name: "Add keeper" }).click()
    await readdDialog.getByRole("textbox", { name: "Keeper hostname" }).fill(serviceOrigin)
    await readdDialog.getByRole("button", { name: "Discover keeper" }).click()
    await expect(readdDialog.getByText("Service identity " + nativeIdentity.personId)).toBeVisible()
    for (const title of ["Keeper target A", "Keeper target B", "Keeper future board"]) {
      const board = readdDialog.getByRole("checkbox", { name: "Keeper board: " + title })
      await expect(board).toBeVisible()
      await board.check()
    }
    await readdDialog.getByRole("checkbox", { name: "Keeper board: Untitled" }).uncheck()
    await expect(readdDialog.getByRole("checkbox", { name: "Keeper board: Owner B private board" })).toHaveCount(0)
    await expect(readdDialog.getByRole("checkbox", { name: "Also replicate my future boards" })).toBeChecked()
    ownerAReaddRequested = true
    await readdDialog.getByRole("button", { name: "Request access" }).click()
    await expect(readdDialog.getByRole("status")).toContainText("Waiting for both approvals")
    await operator.reload()
    await signInOperator(operator, operatorToken)
    await openApprovals(operator)
    const readdApproval = operator.locator(".approvals-section article.approval-card")
    await expect(readdApproval).toHaveCount(1)
    await expect(readdApproval).toContainText("Keeper target A")
    await readdApproval.getByRole("button", { name: "Approve exact boards" }).click()
    await readdDialog.getByRole("button", { name: "Code matches · approve" }).click()
    await expect(readdDialog.getByText("All selected boards activated and saved by Rusty.")).toBeVisible({ timeout: 90_000 })
    expect(ownerAReaddProvisionBody).toBeTruthy()
    const readdRequest = JSON.parse(ownerAReaddProvisionBody!) as {
      signed: { payload: { operationId: string; body: { pairingId: string; approvedScopes: { workspaceId: string }[] } } }
    }
    expect(readdRequest.signed.payload.operationId).toBeTruthy()
    expect(readdRequest.signed.payload.body.pairingId).not.toBe(ownerAPairingId)
    const readdedWorkspaceIds = readdRequest.signed.payload.body.approvedScopes.map(scope => scope.workspaceId)
    expect(readdedWorkspaceIds.sort()).toEqual([...ownerAWorkspaceIds].sort())
    const readdedStatus = await page.evaluate(async (origin) => {
      const { discoverLighthouse } = await import("/src/sync/lighthouseDiscovery.ts")
      const { getKeeperIntegrationStatus } = await import("/src/sync/lighthousePairing.ts")
      return getKeeperIntegrationStatus(await discoverLighthouse(origin, { allowLoopbackHttp: true }))
    }, serviceOrigin)
    expect(readdedStatus.signature).toBeTruthy()
    expect(readdedStatus.signerKeyId).toBe(ownerAServiceDeviceId)
    const activeReaddedIntegration = readdedStatus.integrations.find(integration => integration.integrationId === ownerAIntegrationId)
    expect(activeReaddedIntegration?.scopes.map(scope => scope.workspaceId).sort()).toEqual([...ownerAWorkspaceIds].sort())
    expect(activeReaddedIntegration?.pendingOperation).toBeUndefined()
    for (const scope of activeReaddedIntegration?.scopes ?? []) {
      const oldEpoch = receiptScopes?.find(removed => removed.workspaceId === scope.workspaceId)?.grantEpoch ?? 0
      expect(scope.grantEpoch).toBeGreaterThan(oldEpoch)
      expect(scope.activationOperationId).toBe(readdRequest.signed.payload.operationId)
    }
    const staleDisconnect = await page.request.post(serviceOrigin + "/v1/integrations/" + ownerAIntegrationId + "/disconnect", {
      data: failedRequest.body,
      headers: { Origin: appOrigin, "Content-Type": "application/json" },
    })
    expect(staleDisconnect.status()).toBe(409)
    await expect(readdDialog.getByRole("status")).toContainText("All selected boards activated and saved by Rusty.")
    await expect(readdDialog.getByRole("alert")).toHaveCount(0)
    expect(statusFetchFailure).toBeUndefined()
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
