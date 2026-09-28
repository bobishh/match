import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createServer } from "node:net"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test, type Browser, type Page } from "@playwright/test"
import { createJobSearchWorkspace } from "./support/workspaces"

const binary = process.env.MATCH_LIGHTHOUSE_BINARY
const manifest = resolve(process.env.MATCH_LIGHTHOUSE_MANIFEST ?? "../mesh-lighthouse/Cargo.toml")
test.skip(!binary || !existsSync(binary) || !existsSync(manifest), "Built standalone Lighthouse binary and checkout are required")
test.use({ trace: "off" })

function native(args: string[], env?: NodeJS.ProcessEnv) {
  return spawn(binary!, args, { stdio: "pipe", env: { ...process.env, ...env } })
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

async function stop(child?: ChildProcessWithoutNullStreams) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const stopped = new Promise<void>(resolveStop => child.once("exit", () => resolveStop()))
  child.kill("SIGINT")
  await stopped
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
    await page.goto(baseURL)
    await createJobSearchWorkspace(page, "Bootstrap board")
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Device sync" })
    await dialog.getByRole("button", { name: "Add someone" }).click()
    await dialog.getByRole("button", { name: "Generate link" }).click()
    const invite = await dialog.getByLabel("Pairing link").inputValue()
    joinProcess = native(["join", invite, directory])
    const joined = waitOutput(joinProcess, /Lighthouse joined/)
    await page.getByLabel("Participant role").waitFor({ timeout: 90_000 })
    await page.getByLabel("Participant role").selectOption("editor")
    await page.getByRole("button", { name: "Approve access" }).click()
    await joined
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

test("Given a running Lighthouse identity, when both controllers approve all owned boards, then durable join resumes after lost response and restart", async ({ page, browser, baseURL }) => {
  test.setTimeout(300_000)
  const directory = await mkdtemp(join(tmpdir(), "match-lighthouse-provision-"))
  const baseDirectory = join(directory, "service")
  const appOrigin = baseURL ?? "http://127.0.0.1:4246"
  const servicePort = await freePort()
  const serviceOrigin = "http://127.0.0.1:" + servicePort
  const operatorToken = "keeper-test-token-" + crypto.randomUUID() + "-long-enough"
  const nativeIdentity = { personId: "" }
  const nativeSeeds: { identity: number[]; device: number[]; iroh: number[] } = { identity: [], device: [], iroh: [] }
  let service: ChildProcessWithoutNullStreams | undefined
  let operator: Page | undefined
  let bodyForRetry: string | undefined
  let droppedResponse = false
  let completed = false
  try {
    await page.goto(appOrigin)
    await createTargetBoards(page)
    const bootstrapConfig = await bootstrapKeeperIdentity(browser, baseDirectory, appOrigin)
    nativeIdentity.personId = bootstrapConfig.localHandshake.peer.advertisement.payload.personId
    nativeSeeds.identity = bootstrapConfig.identitySeed
    nativeSeeds.device = bootstrapConfig.deviceSeed
    nativeSeeds.iroh = bootstrapConfig.irohSecret

    service = await startService(baseDirectory, serviceOrigin, appOrigin, operatorToken)
    await page.route(serviceOrigin + "/v1/pairings/*/provision", async route => {
      bodyForRetry = route.request().postData() ?? undefined
      const response = await route.fetch()
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

    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const sync = page.getByRole("dialog", { name: "Device sync" })
    await sync.getByRole("button", { name: "Add keeper" }).click()
    await sync.getByRole("textbox", { name: "Keeper hostname" }).fill(serviceOrigin)
    await sync.getByRole("button", { name: "Discover keeper" }).click()
    await expect(sync.getByText("Service identity: " + nativeIdentity.personId)).toBeVisible()
    const ownerBoardChecks = sync.locator('input[aria-label^="Keeper board: "]')
    await expect(ownerBoardChecks).toHaveCount(3)
    for (const checkbox of await ownerBoardChecks.all()) await expect(checkbox).toBeChecked()
    await expect(sync.getByRole("checkbox", { name: "Also replicate my future boards" })).toBeChecked()
    await sync.getByRole("checkbox", { name: "Keeper board: Keeper target A" }).check()
    await sync.getByRole("checkbox", { name: "Keeper board: Keeper target B" }).check()
    await sync.getByRole("button", { name: "Request keeper access" }).click()
    await expect(sync.getByText("Awaiting both approvals. No access granted.")).toBeVisible()

    operator = await page.context().newPage()
    await operator.goto(serviceOrigin + "/admin/")
    await operator.getByLabel("Operator token").fill(operatorToken)
    await operator.getByRole("button", { name: "Sign in" }).click()
    const request = operator.locator("#requests article")
    await expect(request).toHaveCount(1)
    await expect(request).toContainText("Keeper target A")
    await expect(request).toContainText("Keeper target B")
    await expect(request).toContainText("Controller approval: pending")
    await request.getByRole("button", { name: "Approve exact boards" }).click()
    await expect(request).toContainText("Controller approval: pending")

    await sync.getByRole("button", { name: "Code matches · approve" }).click()
    await expect(sync.getByText("All selected boards activated and saved by Lighthouse.")).toBeVisible({ timeout: 90_000 })
    expect(droppedResponse).toBe(true)
    expect(bodyForRetry).toBeTruthy()

    const configPath = join(baseDirectory, "config.json")
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      identitySeed: number[]; deviceSeed: number[]; irohSecret: number[]
      additionalScopes: { workspaceId: string; identitySeed: number[]; deviceSeed: number[]; irohSecret: number[] }[]
      provisioningCommits: { workspaceIds: string[]; futureBoards: boolean }[]
      controllerPersonId?: string
    }
    const approvedWorkspaceIds = (JSON.parse(bodyForRetry!) as { signed: { payload: { body: { approvedScopes: { workspaceId: string }[] } } } })
      .signed.payload.body.approvedScopes.map(scope => scope.workspaceId)
    expect(approvedWorkspaceIds.length).toBeGreaterThanOrEqual(2)
    expect(config.additionalScopes.map(scope => scope.workspaceId)).toEqual(approvedWorkspaceIds)
    expect(config.additionalScopes.map(scope => scope.identitySeed)).toEqual(approvedWorkspaceIds.map(() => nativeSeeds.identity))
    expect(config.additionalScopes.map(scope => scope.deviceSeed)).toEqual(approvedWorkspaceIds.map(() => nativeSeeds.device))
    expect(config.additionalScopes.map(scope => scope.irohSecret)).toEqual(approvedWorkspaceIds.map(() => nativeSeeds.iroh))
    expect(config.provisioningCommits.at(-1)?.workspaceIds).toEqual(approvedWorkspaceIds)
    expect((JSON.parse(bodyForRetry!) as { signed: { payload: { body: { futureBoards: boolean } } } })
      .signed.payload.body.futureBoards).toBe(true)
    expect(config.provisioningCommits.at(-1)?.futureBoards).toBe(true)
    expect(config.controllerPersonId).toBe((JSON.parse(bodyForRetry!) as { signed: { identity: { personId: string } } })
      .signed.identity.personId)

    await sync.getByRole("button", { name: "Close" }).click()
    await createJobSearchWorkspace(page, "Keeper future board")
    await expect.poll(async () => {
      const current = JSON.parse(await readFile(configPath, "utf8")) as { additionalScopes: { workspaceId: string }[] }
      return current.additionalScopes.length
    }, { timeout: 90_000 }).toBe(approvedWorkspaceIds.length + 1)
    const withFutureBoard = JSON.parse(await readFile(configPath, "utf8")) as {
      additionalScopes: { workspaceId: string; statePath: string }[]
    }
    expect(withFutureBoard.additionalScopes.every(scope => existsSync(scope.statePath))).toBe(true)

    await stop(service)
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
    await stop(service)
    if (completed) await rm(directory, { recursive: true, force: true })
  }
})
